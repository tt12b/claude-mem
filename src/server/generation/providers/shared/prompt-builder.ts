// SPDX-License-Identifier: Apache-2.0

import { ModeManager } from '../../../../services/domain/ModeManager.js';
import type { ModeConfig, ModePrompts, ObservationType } from '../../../../services/domain/types.js';
import { stripTags } from '../../../../utils/tag-stripping.js';
import { logger } from '../../../../utils/logger.js';
import type { PostgresAgentEvent } from '../../../../storage/postgres/agent-events.js';
import type { ServerGenerationContext } from './types.js';

// Fallback list mirrors the default observation types used by claude-mem
// modes. The server-beta prompt does not strictly need a loaded mode file —
// the parser accepts any of these as the <type> value — so when no mode is
// loaded (tests, fresh installs) we synthesize a minimal type list rather
// than throwing.
const FALLBACK_OBSERVATION_TYPES: ReadonlyArray<Pick<ObservationType, 'id'>> = [
  { id: 'discovery' },
  { id: 'progress' },
  { id: 'blocker' },
  { id: 'decision' },
];

// Build a single-shot generation prompt from a list of AgentEvent records
// plus project/session metadata. Output: a user prompt asking the provider
// to return one or more <observation> XML blocks (or an empty response if
// the batch should be skipped). This is intentionally a single-turn request
// — server-beta does NOT use the worker's multi-turn SDK conversation
// model. parseAgentXml(...) accepts the response unchanged.
//
// Privacy: every event payload field passes through `stripTags` (which
// removes <private>, <claude-mem-context>, <system-reminder>, etc.) before
// being included in the prompt. Privacy enforcement here is belt-and-suspenders
// — `processGeneratedResponse` also discards observations that are entirely
// derived from privately-tagged inputs.

export interface BuildServerPromptResult {
  /**
   * How many of `context.events` made it into the prompt. Fewer than the
   * input means the budget cut the batch short and the caller must not
   * advance its watermark past this point.
   */
  readonly includedEvents?: number;
  readonly prompt: string;
  readonly hadPrivateContent: boolean;
  readonly skippedAll: boolean;
}

const MAX_PAYLOAD_CHARS = 16 * 1024;

/**
 * Ceiling on the combined event text in one request.
 *
 * MAX_PAYLOAD_CHARS bounds a single event; without a total the periodic
 * summariser can hand the provider a whole backlog at once (500 events x 16KB
 * is 8MB, past any context window). Events are appended oldest-first and the
 * builder stops at this budget — the caller advances the session watermark to
 * the last event it actually included, so the remainder is picked up by the
 * next tick instead of being dropped.
 */
const MAX_TOTAL_PAYLOAD_CHARS = (() => {
  const raw = Number.parseInt(process.env.CLAUDE_MEM_MAX_PROMPT_CHARS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 120 * 1024;
})();

/**
 * Language for the human-readable fields of an observation.
 *
 * The model defaults to English, which is wrong for an operator who reads the
 * dashboard in their own language. Set CLAUDE_MEM_OBSERVATION_LANGUAGE to a
 * language name (e.g. `Korean`) to have title/subtitle/facts/narrative come
 * back in it. Structural values — the XML tags, the observation `type`, file
 * paths, identifiers, code — stay as they are so parsing and search do not
 * change with the setting.
 */
function languageDirective(): string[] {
  const language = (process.env.CLAUDE_MEM_OBSERVATION_LANGUAGE ?? '').trim();
  if (!language) return [];
  return [
    '',
    `Write every human-readable field in ${language}: title, subtitle, facts,`,
    'narrative, and concepts. Keep the XML tag names, the observation type',
    'value, file paths, identifiers, commands, and code excerpts exactly as',
    'they appear — translate the prose around them, not the symbols.',
  ];
}

export function buildServerGenerationPrompt(
  context: ServerGenerationContext,
  options: { mode?: ModeConfig } = {},
): BuildServerPromptResult {
  const mode = options.mode ?? loadActiveModeOrFallback();

  let hadPrivateContent = false;
  let allEventsScrubbedToEmpty = true;
  const eventBlocks: string[] = [];

  let usedChars = 0;
  let includedEvents = 0;
  for (const event of context.events) {
    const block = buildEventBlock(event);
    if (block.hadPrivate) {
      hadPrivateContent = true;
    }
    if (block.body.length === 0) {
      includedEvents++;
      continue;
    }
    // Always take the first event: a single oversized one must still be sent
    // (truncated to MAX_PAYLOAD_CHARS) rather than stalling the session.
    if (eventBlocks.length > 0 && usedChars + block.body.length > MAX_TOTAL_PAYLOAD_CHARS) {
      break;
    }
    allEventsScrubbedToEmpty = false;
    eventBlocks.push(block.body);
    usedChars += block.body.length;
    includedEvents++;
  }

  const skippedAll = context.events.length > 0 && allEventsScrubbedToEmpty;

  const sessionTag = context.project.serverSessionId
    ? `\n  <server_session_id>${escapeXml(context.project.serverSessionId)}</server_session_id>`
    : '';
  const projectTag = context.project.projectName
    ? `\n  <project_name>${escapeXml(context.project.projectName)}</project_name>`
    : '';

  // Modes carry their own instruction text (`prompts`) alongside the type
  // taxonomy — that is where the shipped translations live, e.g. code--ko
  // localises every placeholder and states the output language. The server
  // path only ever read `observation_types`, so a language mode selected by
  // the operator had no effect here at all.
  const prompts = ('prompts' in mode ? mode.prompts : undefined) as Partial<ModePrompts> | undefined;
  const observationOutputSchema = buildObservationOutputSchema(mode, prompts);

  const isSummaryJob = context.job.sourceType === 'session_summary';

  const prompt = [
    '<server_beta_observation_request>',
    `  <project_id>${escapeXml(context.project.projectId)}</project_id>`,
    `  <team_id>${escapeXml(context.project.teamId)}</team_id>` + sessionTag + projectTag,
    `  <generation_job_id>${escapeXml(context.job.id)}</generation_job_id>`,
    '  <agent_events>',
    eventBlocks.length > 0 ? eventBlocks.join('\n') : '    <!-- empty after privacy stripping -->',
    '  </agent_events>',
    '</server_beta_observation_request>',
    '',
    ...(isSummaryJob
      ? summaryInstructions(prompts)
      : observationInstructions(observationOutputSchema, prompts)),
    // The env directive stays as the fallback for deployments running the
    // default mode; a mode that states its own language wins.
    ...languageDirective(),
  ].join('\n');

  return { prompt, hadPrivateContent, skippedAll, includedEvents };
}

/**
 * Per-event jobs want discrete observations.
 */
function observationInstructions(
  observationOutputSchema: string,
  prompts?: Partial<ModePrompts>,
): string[] {
  return [
    'You are observing an agent at work. Return one or more',
    '<observation>...</observation> XML blocks summarizing durable, useful',
    'discoveries from the events above. If the events contain nothing worth',
    'recording (e.g., everything was scrubbed by privacy filters or the',
    'activity was trivial), return a single self-closing <skip_summary />',
    'tag and nothing else. Do not include any prose outside the XML.',
    ...(prompts?.type_guidance ? ['', prompts.type_guidance] : []),
    '',
    'Schema for each <observation> block:',
    observationOutputSchema,
    ...(prompts?.footer ? ['', prompts.footer] : []),
  ];
}

/**
 * Session-summary jobs are parsed by processSessionSummaryResponse, which
 * reads a `<summary>` block (src/sdk/parser.ts ParsedSummary) — not
 * `<observation>` blocks. Asking for the wrong shape here makes every summary
 * job land as "nothing to record": the parser finds no summary, the content
 * is empty, and the job completes having persisted zero rows. That went
 * unnoticed while per-event jobs carried the load; once generation moved to
 * periodic batching it silenced observations entirely.
 */
function summaryInstructions(prompts?: Partial<ModePrompts>): string[] {
  const field = (value: string | undefined, fallback: string) => value ?? fallback;
  return [
    'You are summarizing a stretch of an agent session. Return exactly one',
    '<summary>...</summary> XML block covering the events above. If there is',
    'nothing worth recording (everything was scrubbed, or the activity was',
    'trivial), return a single self-closing <skip_summary /> tag and nothing',
    'else. Do not include any prose outside the XML.',
    '',
    'Schema for the <summary> block:',
    '<summary>',
    `  <request>${field(prompts?.xml_summary_request_placeholder, 'what the user asked for')}</request>`,
    `  <investigated>${field(prompts?.xml_summary_investigated_placeholder, 'what was examined and how')}</investigated>`,
    `  <learned>${field(prompts?.xml_summary_learned_placeholder, 'findings that stay true beyond this session')}</learned>`,
    `  <completed>${field(prompts?.xml_summary_completed_placeholder, 'what actually changed')}</completed>`,
    `  <next_steps>${field(prompts?.xml_summary_next_steps_placeholder, 'what remains open')}</next_steps>`,
    `  <notes>${field(prompts?.xml_summary_notes_placeholder, 'anything else worth keeping')}</notes>`,
    '</summary>',
    ...(prompts?.summary_footer ? ['', prompts.summary_footer] : []),
  ];
}

interface EventBlockResult {
  body: string;
  hadPrivate: boolean;
}

function buildEventBlock(event: PostgresAgentEvent): EventBlockResult {
  const rawPayload =
    typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload ?? {}, null, 2);

  const stripResult = stripTags(rawPayload);
  const hadPrivate = (stripResult.counts.private ?? 0) > 0;
  const truncatedPayload = stripResult.stripped.length > MAX_PAYLOAD_CHARS
    ? stripResult.stripped.slice(0, MAX_PAYLOAD_CHARS) + '\n[...truncated]'
    : stripResult.stripped;

  if (truncatedPayload.trim().length === 0) {
    return { body: '', hadPrivate };
  }

  return {
    body: [
      '    <agent_event>',
      `      <id>${escapeXml(event.id)}</id>`,
      `      <event_type>${escapeXml(event.eventType)}</event_type>`,
      `      <source_adapter>${escapeXml(event.sourceAdapter)}</source_adapter>`,
      `      <occurred_at>${new Date(event.occurredAtEpoch).toISOString()}</occurred_at>`,
      '      <payload>',
      escapeXml(truncatedPayload),
      '      </payload>',
      '    </agent_event>',
    ].join('\n'),
    hadPrivate,
  };
}

function loadActiveModeOrFallback(): ModeConfig | { observation_types: ReadonlyArray<Pick<ObservationType, 'id'>> } {
  try {
    return ModeManager.getInstance().getActiveMode();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SDK', 'Failed to load active mode; using fallback observation types', {
      fallbackTypes: FALLBACK_OBSERVATION_TYPES.map(t => t.id),
    }, err);
    return { observation_types: FALLBACK_OBSERVATION_TYPES } as unknown as ModeConfig;
  }
}

function buildObservationOutputSchema(
  mode: ModeConfig | { observation_types: ReadonlyArray<Pick<ObservationType, 'id'>> },
  prompts?: Partial<ModePrompts>,
): string {
  const types = mode.observation_types.map(t => t.id).join(' | ');
  // Listing bare ids left the model guessing what each one meant, so it kept
  // reaching for the two that read as generic (`discovery`, `change`) and the
  // rest of the taxonomy went unused. The mode already carries a label and a
  // description per type; spelling them out is what makes the distinctions
  // available to the model at all.
  const described = (mode.observation_types as ReadonlyArray<Partial<ObservationType> & { id: string }>)
    .filter(type => Boolean(type.description))
    .map(type => `    ${type.id} — ${type.label ?? type.id}: ${type.description}`);

  return [
    '<observation>',
    `  <type>[ ${types} ]</type>`,
    ...(described.length > 0 ? ['  <!-- choose the type that fits best:', ...described, '  -->'] : []),
    `  <title>${prompts?.xml_title_placeholder ?? '...'}</title>`,
    `  <subtitle>${prompts?.xml_subtitle_placeholder ?? '...'}</subtitle>`,
    `  <facts><fact>${prompts?.xml_fact_placeholder ?? '...'}</fact></facts>`,
    `  <narrative>${prompts?.xml_narrative_placeholder ?? '...'}</narrative>`,
    `  <concepts><concept>${prompts?.xml_concept_placeholder ?? '...'}</concept></concepts>`,
    `  <files_read><file>${prompts?.xml_file_placeholder ?? '...'}</file></files_read>`,
    `  <files_modified><file>${prompts?.xml_file_placeholder ?? '...'}</file></files_modified>`,
    '</observation>',
  ].join('\n');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
