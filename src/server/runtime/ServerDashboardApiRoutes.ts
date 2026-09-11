// SPDX-License-Identifier: Apache-2.0
//
// Dashboard data API for the server runtime.
//
// ServerViewerRoutes serves plugin/ui/viewer.html, but the bundle then calls
// /api/observations, /api/summaries, /api/prompts, /api/settings and /stream —
// routes that only ever existed on the in-plugin worker, which reads SQLite.
// On the server runtime every one of them 404s, so the page loads and stays
// empty. These handlers answer the same contract out of Postgres.
//
// Shape notes (src/ui/viewer/types.ts is the source of truth):
//   - list endpoints take ?offset&limit&project and return { items, hasMore }
//   - `id` is typed as number there but is only ever used as a React key and
//     for de-duplication, so the Postgres uuid string is fine
//   - a summary is an observation with kind='summary'; the viewer reads its
//     request/investigated/learned/completed/next_steps out of metadata
//   - a prompt is an agent_event with event_type='user_prompt'
//
// These are read-only and unauthenticated, matching the viewer page itself
// (ServerViewerRoutes mounts `/` with no auth). The server is expected to sit
// on a private network; do not expose it publicly without putting auth in
// front of the whole surface.

import express from 'express';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Application, Request, Response } from 'express';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresServerSettingsRepository, PREFERRED_MODEL_KEY } from '../../storage/postgres/server-settings.js';
import { logger } from '../../utils/logger.js';
import { QUOTA_TIMEZONE, nextQuotaReset, quotaDayStart } from '../services/quota-day.js';
import { PostgresObservationRepository } from '../../storage/postgres/observations.js';
import { AskService, MAX_QUESTION_CHARS, askApiKey, askBriefingLoaded, askModels } from '../ask/AskService.js';
import { vectorSupport } from '../../storage/postgres/vector-support.js';
import { resolveEmbeddingProvider } from '../generation/embeddings/GeminiEmbeddingProvider.js';
import { resolveEmbeddingIntervalMs } from '../services/ObservationEmbeddingScheduler.js';

const DEFAULT_LIMIT = 50;
/**
 * How long a quota refusal keeps a model marked spent.
 *
 * Google does not say when a daily allowance resets, so the mark is cleared
 * optimistically rather than waiting out a full day: if the model is still
 * spent the next attempt re-marks it within one cycle, and if it recovered
 * early the panel says so instead of lying for hours. Being wrong in the
 * optimistic direction costs one refused request, which draws down nothing.
 */
/* The quota-day boundary lives in ../services/quota-day.js — the retry
 * scheduler parks jobs on the same instant this panel counts down to. */

const MAX_LIMIT = 200;
/** How often an open /stream connection looks for rows it has not sent yet. */
const STREAM_POLL_MS = 3_000;
const STREAM_HEARTBEAT_MS = 25_000;

interface PageQuery {
  offset: number;
  limit: number;
  project: string | null;
}

function parsePageQuery(req: Request): PageQuery {
  const rawOffset = Number.parseInt(String(req.query.offset ?? '0'), 10);
  const rawLimit = Number.parseInt(String(req.query.limit ?? String(DEFAULT_LIMIT)), 10);
  const project = typeof req.query.project === 'string' && req.query.project.trim() !== ''
    ? req.query.project.trim()
    : null;
  return {
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT,
    project,
  };
}

/**
 * The viewer groups by a human-readable project name. The server stores the
 * cwd-derived label the client sent on session start
 * (`server_sessions.metadata->>'project'`) and falls back to the project row's
 * own name when a session predates that.
 */
const PROJECT_LABEL_SQL = `COALESCE(s.metadata->>'project', p.name, 'unknown')`;

/**
 * `CLAUDE_MEM_MODEL_LIMITS` as `model=limit` pairs, e.g.
 * `gemini-3.5-flash-lite=1000,gemini-flash-latest=20`. Published free-tier
 * figures go here so the dashboard shows headroom before a model has ever
 * been refused; a measured limit from a 429 supersedes it.
 */
function parseModelLimits(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const pair of (raw ?? '').split(',')) {
    const [name, value] = pair.split('=').map(part => part.trim());
    const limit = Number.parseInt(value ?? '', 10);
    if (name && Number.isFinite(limit) && limit > 0) out.set(name, limit);
  }
  return out;
}

function toEpoch(value: Date | string | null): number {
  if (!value) return 0;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('\n');
  return JSON.stringify(value);
}

/**
 * ObservationCard runs these through JSON.parse (facts, concepts, files_read,
 * files_modified), so they have to arrive as a JSON array *string* — handing
 * it prose makes the card throw and takes the whole page down with it.
 */
function asJsonArrayText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    // Already-encoded arrays pass through; anything else is a single item.
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return trimmed;
      } catch {
        // fall through and treat it as one plain string
      }
    }
    return JSON.stringify([value]);
  }
  return JSON.stringify([String(value)]);
}

export interface ServerDashboardApiRoutesOptions {
  pool: PostgresPool;
}

export class ServerDashboardApiRoutes implements RouteHandler {
  constructor(private readonly options: ServerDashboardApiRoutesOptions) {}

  setupRoutes(app: Application): void {
    app.get('/api/observations', this.wrap(this.handleObservations));
    app.get('/api/summaries', this.wrap(this.handleSummaries));
    app.get('/api/prompts', this.wrap(this.handlePrompts));
    app.get('/api/messages', this.wrap(this.handleMessages));
    app.get('/api/projects', this.wrap(this.handleProjects));
    app.get('/api/settings', this.wrap(this.handleSettings));
    app.get('/api/usage', this.wrap(this.handleUsage));
    app.get('/api/models', this.wrap(this.handleModels));
    // The only write on this surface. Same unauthenticated posture as the
    // rest of the dashboard: it changes which model is tried first, nothing
    // that leaves the deployment.
    app.post('/api/models/active', express.json(), this.wrap(this.handleSelectModel));
    app.post('/api/ask', express.json({ limit: '32kb' }), this.wrap(this.handleAsk));
    app.get('/api/ask/status', this.wrap(this.handleAskStatus));
    app.get('/api/context/preview', this.wrap(this.handleContextPreview));
    app.get('/api/logs', this.wrap(this.handleLogs));
    app.get('/stream', this.handleStream.bind(this));
  }

  private wrap(handler: (req: Request, res: Response) => Promise<void>) {
    const bound = handler.bind(this);
    return (req: Request, res: Response) => {
      bound(req, res).catch((error: unknown) => {
        logger.warn('SYSTEM', 'dashboard api handler failed', {
          path: req.path,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({ error: 'InternalError', message: 'dashboard query failed' });
        }
      });
    };
  }

  // ---------------------------------------------------------------- lists

  private async handleObservations(req: Request, res: Response): Promise<void> {
    const { offset, limit, project } = parsePageQuery(req);
    const rows = await this.queryObservations({ offset, limit: limit + 1, project, summaries: false });
    res.json(this.page(rows, limit));
  }

  private async handleSummaries(req: Request, res: Response): Promise<void> {
    const { offset, limit, project } = parsePageQuery(req);
    const rows = await this.queryObservations({ offset, limit: limit + 1, project, summaries: true });
    res.json(this.page(rows, limit));
  }

  private async handlePrompts(req: Request, res: Response): Promise<void> {
    const { offset, limit, project } = parsePageQuery(req);
    const rows = await this.queryPrompts({ offset, limit: limit + 1, project });
    res.json(this.page(rows, limit));
  }

  private async handleMessages(req: Request, res: Response): Promise<void> {
    const { offset, limit, project } = parsePageQuery(req);
    const rows = await this.queryAgentEventText({
      offset,
      limit: limit + 1,
      project,
      eventType: 'assistant_message',
      payloadKey: 'last_assistant_message',
    });
    res.json(this.page(rows, limit));
  }

  private async handleProjects(_req: Request, res: Response): Promise<void> {
    const projects = await this.listProjects();
    res.json({ projects, sources: ['claude-code'], projectsBySource: { 'claude-code': projects } });
  }

  private async handleSettings(_req: Request, res: Response): Promise<void> {
    // Read-only mirror of the knobs that actually drive this deployment. The
    // viewer merges whatever it gets over its own defaults.
    res.json({
      CLAUDE_MEM_MODEL: process.env.CLAUDE_MEM_SERVER_MODEL ?? '',
      CLAUDE_MEM_PROVIDER: process.env.CLAUDE_MEM_SERVER_PROVIDER ?? '',
      CLAUDE_MEM_WORKER_HOST: process.env.CLAUDE_MEM_SERVER_HOST ?? '0.0.0.0',
      CLAUDE_MEM_WORKER_PORT: process.env.CLAUDE_MEM_SERVER_PORT ?? '37877',
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS ?? '50',
      CLAUDE_MEM_GENERATE_PER_EVENT: process.env.CLAUDE_MEM_GENERATE_PER_EVENT ?? 'true',
      CLAUDE_MEM_SUMMARY_INTERVAL_MINUTES: process.env.CLAUDE_MEM_SUMMARY_INTERVAL_MINUTES ?? '10',
    });
  }

  /**
   * Provider spend for the dashboard.
   *
   * Google exposes no quota-remaining read for an AI Studio key (the
   * monitoring API rejects API-key auth outright), so this reports what was
   * actually consumed instead of what is left. `observation_generation_job_events`
   * has exactly one row per provider attempt, which makes it the call counter;
   * `usage_events` carries the token totals the provider returned.
   *
   * `?days=` bounds the window (default 1, max 30).
   */
  private async handleUsage(req: Request, res: Response): Promise<void> {
    const rawDays = Number.parseInt(String(req.query.days ?? '1'), 10);
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 30) : 1;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [calls, tokens, jobs, failures] = await Promise.all([
      this.options.pool.query<{ event_type: string; count: string }>(
        `SELECT event_type, count(*)::text AS count
           FROM observation_generation_job_events
          WHERE event_type IN ('completed', 'failed') AND created_at >= $1
          GROUP BY event_type`,
        [since],
      ),
      this.options.pool.query<{ provider: string | null; model: string | null; total: string }>(
        `SELECT metadata->>'provider' AS provider,
                metadata->>'model'    AS model,
                COALESCE(sum(quantity), 0)::text AS total
           FROM usage_events
          WHERE kind = 'tokens' AND created_at >= $1
          GROUP BY 1, 2`,
        [since],
      ),
      this.options.pool.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count
           FROM observation_generation_jobs
          WHERE created_at >= $1
          GROUP BY status`,
        [since],
      ),
      this.options.pool.query<{ classification: string | null; count: string }>(
        `SELECT last_error->>'classification' AS classification, count(*)::text AS count
           FROM observation_generation_jobs
          WHERE status = 'failed' AND created_at >= $1
          GROUP BY 1
          ORDER BY 2 DESC`,
        [since],
      ),
    ]);

    const callCounts = Object.fromEntries(calls.rows.map(r => [r.event_type, Number(r.count)]));
    const succeeded = callCounts.completed ?? 0;
    const failed = callCounts.failed ?? 0;

    res.json({
      windowDays: days,
      since: since.toISOString(),
      provider: process.env.CLAUDE_MEM_SERVER_PROVIDER ?? null,
      // One row per attempt, so this is the real request count against the
      // provider's rate limit — not the number of observations produced.
      calls: { total: succeeded + failed, succeeded, failed },
      tokens: tokens.rows.map(r => ({
        provider: r.provider,
        model: r.model,
        total: Number(r.total),
      })),
      jobs: Object.fromEntries(jobs.rows.map(r => [r.status, Number(r.count)])),
      failureReasons: failures.rows.map(r => ({
        classification: r.classification ?? 'unknown',
        count: Number(r.count),
      })),
    });
  }

  /**
   * What a new session in this project would be handed.
   *
   * Mirrors how /v1/context assembles an injection payload — observation
   * `content`, newest first, joined by a blank line — but reads by project
   * label and returns plain text, which is what the viewer's preview drawer
   * expects (it calls response.text(), not .json()).
   */
  private async handleContextPreview(req: Request, res: Response): Promise<void> {
    const project = typeof req.query.project === 'string' && req.query.project.trim() !== ''
      ? req.query.project.trim()
      : null;
    const limit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const rows = await this.queryObservations({
      offset: 0,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : 20,
      project,
      summaries: false,
    });

    res.type('text/plain; charset=utf-8');
    if (rows.length === 0) {
      res.send(
        project
          ? `아직 ${project} 프로젝트에 주입할 관측치가 없습니다.`
          : '아직 주입할 관측치가 없습니다.',
      );
      return;
    }

    const body = rows
      .map(row => String(row.text ?? ''))
      .filter(text => text.trim().length > 0)
      .join('\n\n');
    res.send(body);
  }

  /**
   * Configured models and what each has spent.
   *
   * `CLAUDE_MEM_SERVER_MODEL` is an ordered candidate list; generation walks
   * it and falls through on quota errors, so "active" is not the first entry
   * but whichever model last produced a completed job.
   *
   * There is no quota-remaining read for an AI Studio key, so `limit` is
   * whatever Google last reported while refusing a request (captured from the
   * 429 body into the failure row). Until a model has been refused once its
   * ceiling is simply unknown, and `remaining` stays null rather than being
   * invented.
   */
  private async handleModels(req: Request, res: Response): Promise<void> {
    const rawDays = Number.parseInt(String(req.query.days ?? '1'), 10);
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 30) : 1;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const configured = (process.env.CLAUDE_MEM_SERVER_MODEL ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);

    // Consumption is metered per quota day, not per display window: the
    // dashboard can show a week of history while "remaining" must still be
    // measured from the last midnight-Pacific reset.
    const dayStart = quotaDayStart();
    const embeddings = await this.embeddingStatus();
    const [calls, tokens, askCalls, active, limits] = await Promise.all([
      this.options.pool.query<{ model: string | null; event_type: string; count: string }>(
        `SELECT details->>'model' AS model, event_type, count(*)::text AS count
           FROM observation_generation_job_events
          WHERE event_type IN ('completed', 'failed') AND created_at >= $1
          GROUP BY 1, 2`,
        [dayStart],
      ),
      this.options.pool.query<{ model: string | null; total: string }>(
        `SELECT metadata->>'model' AS model, COALESCE(sum(quantity), 0)::text AS total
           FROM usage_events
          WHERE kind = 'tokens' AND created_at >= $1
          GROUP BY 1`,
        [since],
      ),
      // Dashboard questions call the same models on the same key, so they
      // draw down the same daily allowance. They leave no generation-job
      // row, so without this the gauge would only ever count summarisation
      // and overstate what is left.
      this.options.pool.query<{ model: string | null; count: string }>(
        `SELECT metadata->>'model' AS model, count(*)::text AS count
           FROM usage_events
          WHERE kind = 'request' AND metadata->>'source' = 'ask' AND created_at >= $1
          GROUP BY 1`,
        [dayStart],
      ),
      this.options.pool.query<{ model: string | null; created_at: Date }>(
        `SELECT details->>'model' AS model, created_at
           FROM observation_generation_job_events
          WHERE event_type = 'completed' AND details->>'model' IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 200`,
        [],
      ),
      // Quota refusals name the model in the message (extractQuotaDetail), so
      // this is also how we learn WHICH model is spent — failures do not
      // otherwise record one.
      this.options.pool.query<{ reason: string | null; updated_at: Date }>(
        `SELECT last_error->>'reason' AS reason, updated_at
           FROM observation_generation_jobs
          WHERE status = 'failed' AND last_error->>'reason' LIKE '%model=%'
          ORDER BY updated_at DESC
          LIMIT 200`,
        [],
      ),
    ]);

    const callsByModel = new Map<string, { succeeded: number; failed: number }>();
    for (const row of calls.rows) {
      const key = row.model ?? 'unknown';
      const entry = callsByModel.get(key) ?? { succeeded: 0, failed: 0 };
      if (row.event_type === 'completed') entry.succeeded += Number(row.count);
      else entry.failed += Number(row.count);
      callsByModel.set(key, entry);
    }
    // Only successful asks are recorded, and a success draws down the
    // allowance exactly like a completed generation does.
    for (const row of askCalls.rows) {
      const key = row.model ?? 'unknown';
      const entry = callsByModel.get(key) ?? { succeeded: 0, failed: 0 };
      entry.succeeded += Number(row.count);
      callsByModel.set(key, entry);
    }

    const tokensByModel = new Map<string, number>(
      tokens.rows.map(row => [row.model ?? 'unknown', Number(row.total)]),
    );

    // Two sources, measured wins. A published figure is a starting point so
    // the gauge is not blank on day one, but the only number that is true for
    // THIS key is the one Google quoted while refusing it — today
    // `gemini-flash-latest` came back with limit 20 against a documented
    // figure orders of magnitude higher.
    const configuredLimits = parseModelLimits(process.env.CLAUDE_MEM_MODEL_LIMITS);
    const measuredLimits = new Map<string, number>();
    // Most recent quota refusal per model. Rows arrive newest-first.
    const refusedAt = new Map<string, number>();
    for (const row of limits.rows) {
      const text = row.reason ?? '';
      const model = /model=([A-Za-z0-9._-]+)/.exec(text)?.[1];
      if (!model) continue;
      const limit = /limit=([0-9]+)/.exec(text)?.[1];
      if (limit && !measuredLimits.has(model)) measuredLimits.set(model, Number(limit));
      if (!refusedAt.has(model)) refusedAt.set(model, new Date(row.updated_at).getTime());
    }

    // Most recent success per model. Google does not publish when a daily
    // allowance resets, so "spent" cannot be timed out on a clock — instead a
    // later success is the evidence that the model is usable again.
    const succeededAt = new Map<string, number>();
    for (const row of active.rows) {
      const model = row.model;
      if (!model || succeededAt.has(model)) continue;
      succeededAt.set(model, new Date(row.created_at).getTime());
    }

    const preferred = await new PostgresServerSettingsRepository(this.options.pool)
      .get<string>(PREFERRED_MODEL_KEY)
      .catch(() => null);
    // "Active" is what last worked; "preferred" is what the operator asked to
    // try first. They differ while a preferred model is out of quota.
    const activeModel = active.rows[0]?.model ?? configured[0] ?? null;
    // A model can appear in usage without being configured any more (the list
    // was edited); show those too so past spend does not silently vanish.
    const names = Array.from(new Set([
      ...configured,
      ...callsByModel.keys(),
      ...tokensByModel.keys(),
    ])).filter(name => name !== 'unknown');

    res.json({
      windowDays: days,
      provider: process.env.CLAUDE_MEM_SERVER_PROVIDER ?? null,
      // Counts below are for the current quota day, which is what the
      // provider itself meters against.
      quotaDayStartEpoch: dayStart.getTime(),
      quotaResetsAtEpoch: nextQuotaReset().getTime(),
      quotaTimezone: QUOTA_TIMEZONE,
      embeddings,
      activeModel,
      preferredModel: preferred ?? null,
      models: names.map(name => {
        const c = callsByModel.get(name) ?? { succeeded: 0, failed: 0 };
        // A 429 is a refusal — the request never ran, so it does not draw
        // down the daily allowance. Only completed calls do. (A call that
        // reaches the model and then fails to parse is charged and counted
        // here as failed, so this can undercount slightly; it is far closer
        // than charging every rejection.)
        const used = c.succeeded;
        const measured = measuredLimits.get(name) ?? null;
        const limit = measured ?? configuredLimits.get(name) ?? null;
        const refused = refusedAt.get(name) ?? null;
        const succeeded = succeededAt.get(name) ?? null;
        // A refusal goes stale on its own. Without this a model far down the
        // candidate list stays grey for good: the chain stops at the first
        // model that works, so a spent one at the back is never retried and
        // never earns the success that would clear it.
        // A daily-quota refusal holds until the allowance resets — nothing
        // else clears it. An optimistic timeout lived here before the reset
        // schedule was known; with the real boundary in hand it would only
        // paint models green while they are still spent.
        const stale = refused !== null && refused < dayStart.getTime();
        const exhausted = refused !== null
          && !stale
          && (succeeded === null || refused > succeeded);
        return {
          name,
          configured: configured.includes(name),
          // Usable right now, as far as we can tell: no quota refusal since
          // the last time this model answered.
          status: exhausted ? 'exhausted' : 'available',
          exhaustedAtEpoch: exhausted ? refused : null,
          active: name === activeModel,
          preferred: name === preferred,
          priority: configured.indexOf(name),
          calls: { total: used, succeeded: c.succeeded, failed: c.failed },
          tokens: tokensByModel.get(name) ?? 0,
          limit,
          limitSource: measured !== null ? 'measured' : (limit !== null ? 'configured' : null),
          remaining: limit !== null ? Math.max(0, limit - used) : null,
        };
      }).sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        return a.priority - b.priority;
      }),
    });
  }

  /**
   * Answer a question from the dashboard out of the stored observations.
   *
   * Errors are reported as text rather than a 500 so a spent quota reads as
   * an answer the reader can act on instead of a blank panel.
   */
  private async handleAsk(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as {
      question?: unknown; project?: unknown; limit?: unknown; history?: unknown;
    };
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (question === '') {
      res.status(400).json({ error: 'ValidationError', message: '질문이 비어 있습니다' });
      return;
    }
    if (question.length > MAX_QUESTION_CHARS) {
      res.status(400).json({ error: 'ValidationError', message: `질문은 ${MAX_QUESTION_CHARS}자 이내여야 합니다` });
      return;
    }

    const project = typeof body.project === 'string' && body.project !== '' ? body.project : null;
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const history = Array.isArray(body.history)
      ? body.history
          .filter((turn): turn is { question: string; answer: string } =>
            typeof turn === 'object' && turn !== null
            && typeof (turn as { question?: unknown }).question === 'string'
            && typeof (turn as { answer?: unknown }).answer === 'string')
          .map(turn => ({ question: turn.question, answer: turn.answer }))
      : [];

    try {
      const result = await new AskService({ pool: this.options.pool }).ask({ question, project, limit, history });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('SYSTEM', 'ask failed', { error: message });
      res.status(502).json({ error: 'AskFailed', message });
    }
  }

  /** Whether the panel can be used at all, so the UI can say why not. */
  private async handleAskStatus(_req: Request, res: Response): Promise<void> {
    const models = askModels();
    res.json({
      available: askApiKey() !== '' && models.length > 0,
      briefingLoaded: askBriefingLoaded(),
      models,
    });
  }

  /**
   * Whether semantic search is actually being kept up to date.
   *
   * Reported alongside the models because it fails the same way they do —
   * a provider says no and the backfill quietly stops — and because that
   * failure is otherwise invisible: search keeps working on keywords, so
   * nothing looks broken while new observations stop being searchable by
   * meaning.
   */
  private async embeddingStatus(): Promise<{
    enabled: boolean;
    reason: string | null;
    model: string | null;
    embedded: number;
    total: number;
    pending: number;
    lastEmbeddedAtEpoch: number | null;
    stalled: boolean;
  }> {
    const off = {
      enabled: false, model: null, embedded: 0, total: 0,
      pending: 0, lastEmbeddedAtEpoch: null, stalled: false,
    };
    if (vectorSupport() !== true) {
      return { ...off, reason: 'pgvector_unavailable' };
    }
    const provider = resolveEmbeddingProvider();
    if (!provider) {
      return { ...off, reason: 'not_configured' };
    }

    let stats: { embedded: number; total: number; lastEmbeddedAtEpoch: number | null };
    try {
      stats = await new PostgresObservationRepository(this.options.pool).embeddingStats();
    } catch (error) {
      logger.warn('SYSTEM', 'could not read embedding status', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...off, enabled: true, model: provider.label, reason: 'unreadable' };
    }

    const pending = Math.max(0, stats.total - stats.embedded);
    // Only a backlog can be stalled. With nothing pending the backfill is
    // idle by design, however long ago it last ran.
    const intervalMs = resolveEmbeddingIntervalMs();
    const graceMs = (intervalMs > 0 ? intervalMs : 5 * 60_000) * 3;
    const stalled = pending > 0
      && (stats.lastEmbeddedAtEpoch === null || Date.now() - stats.lastEmbeddedAtEpoch > graceMs);

    return {
      enabled: true,
      reason: null,
      model: provider.label,
      embedded: stats.embedded,
      total: stats.total,
      pending,
      lastEmbeddedAtEpoch: stats.lastEmbeddedAtEpoch,
      stalled,
    };
  }

  /**
   * Pick the model to try first.
   *
   * Stored in Postgres rather than the environment because the worker that
   * actually calls the provider is a different container — it reads this
   * before each job, so the change lands without a restart. Only a model
   * already in the configured candidate list is accepted; anything else
   * would silently never be reachable by the failover chain.
   */
  private async handleSelectModel(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { model?: unknown };
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const configured = (process.env.CLAUDE_MEM_SERVER_MODEL ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);

    if (!model) {
      res.status(400).json({ error: 'BadRequest', message: 'model is required' });
      return;
    }
    if (!configured.includes(model)) {
      res.status(400).json({
        error: 'BadRequest',
        message: `model is not in the configured list: ${configured.join(', ')}`,
      });
      return;
    }

    const repo = new PostgresServerSettingsRepository(this.options.pool);
    await repo.set(PREFERRED_MODEL_KEY, model);
    logger.info('SYSTEM', 'preferred generation model changed', { model });
    res.json({ ok: true, model });
  }

  /**
   * Recent server log lines.
   *
   * The viewer treats `logs` as one newline-joined string and splits it
   * itself (LogsModal), so an array here crashes the drawer. Tail the same
   * file the logger writes; when there is none, an empty string renders as
   * "no logs" instead of an error.
   */
  private async handleLogs(req: Request, res: Response): Promise<void> {
    const rawLines = Number.parseInt(String(req.query.lines ?? '500'), 10);
    const lines = Number.isFinite(rawLines) && rawLines > 0 ? Math.min(rawLines, 5000) : 500;

    const dir = join(process.env.CLAUDE_MEM_DATA_DIR ?? '/data/claude-mem', 'logs');
    let text = '';
    try {
      const today = (await readdir(dir))
        .filter(name => name.endsWith('.log'))
        .sort();
      const newest = today[today.length - 1];
      if (newest) {
        const content = await readFile(join(dir, newest), 'utf8');
        text = content.split('\n').slice(-lines).join('\n');
      }
    } catch {
      // No log directory yet, or it is not readable. An empty string is the
      // honest answer and keeps the drawer usable.
      text = '';
    }
    res.json({ logs: text });
  }

  private page<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
    // Handlers over-fetch by one row; its presence is the hasMore signal.
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  // -------------------------------------------------------------- queries

  private async queryObservations(input: {
    offset: number;
    limit: number;
    project: string | null;
    summaries: boolean;
    sinceEpoch?: number;
  }): Promise<Record<string, unknown>[]> {
    const kindClause = input.summaries ? `o.kind = 'summary'` : `o.kind <> 'summary'`;
    const params: unknown[] = [input.limit, input.offset];
    let projectClause = '';
    if (input.project) {
      params.push(input.project);
      projectClause = `AND ${PROJECT_LABEL_SQL} = $${params.length}`;
    }
    let sinceClause = '';
    if (input.sinceEpoch) {
      params.push(new Date(input.sinceEpoch));
      sinceClause = `AND o.created_at > $${params.length}`;
    }

    const result = await this.options.pool.query<Record<string, unknown>>(
      `
        SELECT o.id, o.kind, o.content, o.metadata, o.created_at,
               o.server_session_id,
               ${PROJECT_LABEL_SQL} AS project_label,
               s.platform_source
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        LEFT JOIN projects p ON p.id = o.project_id
        WHERE ${kindClause}
          ${projectClause}
          ${sinceClause}
        ORDER BY o.created_at DESC
        LIMIT $1 OFFSET $2
      `,
      params,
    );

    return result.rows.map(row => (input.summaries ? this.toSummary(row) : this.toObservation(row)));
  }

  private async queryPrompts(input: {
    offset: number;
    limit: number;
    project: string | null;
    sinceEpoch?: number;
  }): Promise<Record<string, unknown>[]> {
    return this.queryAgentEventText({ ...input, eventType: 'user_prompt', payloadKey: 'prompt' });
  }

  /**
   * Conversation turns live in agent_events, one row per side: the question
   * under `user_prompt` (payload.prompt) and the answer under
   * `assistant_message` (payload.last_assistant_message). Both map onto the
   * viewer's UserPrompt shape, which is all the feed needs.
   */
  private async queryAgentEventText(input: {
    offset: number;
    limit: number;
    project: string | null;
    eventType: string;
    payloadKey: string;
    sinceEpoch?: number;
  }): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [input.limit, input.offset, input.eventType];
    let projectClause = '';
    if (input.project) {
      params.push(input.project);
      projectClause = `AND ${PROJECT_LABEL_SQL} = $${params.length}`;
    }
    let sinceClause = '';
    if (input.sinceEpoch) {
      params.push(new Date(input.sinceEpoch));
      sinceClause = `AND e.occurred_at > $${params.length}`;
    }

    const result = await this.options.pool.query<Record<string, unknown>>(
      `
        SELECT e.id, e.payload, e.occurred_at, e.platform_source,
               s.content_session_id,
               ${PROJECT_LABEL_SQL} AS project_label
        FROM agent_events e
        LEFT JOIN server_sessions s ON s.id = e.server_session_id
        LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.event_type = $3
          ${projectClause}
          ${sinceClause}
        ORDER BY e.occurred_at DESC
        LIMIT $1 OFFSET $2
      `,
      params,
    );

    return result.rows.map(row => this.toPrompt(row, input.payloadKey));
  }

  private async listProjects(): Promise<string[]> {
    const result = await this.options.pool.query<{ label: string }>(
      `
        SELECT DISTINCT COALESCE(s.metadata->>'project', p.name, 'unknown') AS label
        FROM server_sessions s
        LEFT JOIN projects p ON p.id = s.project_id
        ORDER BY label
      `,
      [],
    );
    return result.rows.map(row => row.label).filter(Boolean);
  }

  // --------------------------------------------------------------- mapping

  private toObservation(row: Record<string, unknown>): Record<string, unknown> {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      memory_session_id: row.server_session_id ?? '',
      project: row.project_label ?? 'unknown',
      platform_source: row.platform_source ?? 'claude-code',
      type: row.kind ?? 'observation',
      title: asText(metadata.title),
      subtitle: asText(metadata.subtitle),
      narrative: asText(metadata.narrative),
      text: asText(row.content),
      facts: asJsonArrayText(metadata.facts),
      concepts: asJsonArrayText(metadata.concepts),
      files_read: asJsonArrayText(metadata.files_read),
      files_modified: asJsonArrayText(metadata.files_modified),
      prompt_number: null,
      created_at: row.created_at,
      created_at_epoch: toEpoch(row.created_at as Date | string | null),
    };
  }

  private toSummary(row: Record<string, unknown>): Record<string, unknown> {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      session_id: row.server_session_id ?? '',
      project: row.project_label ?? 'unknown',
      platform_source: row.platform_source ?? 'claude-code',
      request: asText(metadata.request) ?? undefined,
      investigated: asText(metadata.investigated) ?? undefined,
      learned: asText(metadata.learned) ?? undefined,
      completed: asText(metadata.completed) ?? undefined,
      next_steps: asText(metadata.next_steps) ?? undefined,
      created_at_epoch: toEpoch(row.created_at as Date | string | null),
    };
  }

  private toPrompt(row: Record<string, unknown>, payloadKey = 'prompt'): Record<string, unknown> {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      content_session_id: row.content_session_id ?? '',
      project: row.project_label ?? 'unknown',
      platform_source: row.platform_source ?? 'claude-code',
      prompt_number: 0,
      prompt_text: asText(payload[payloadKey]) ?? '',
      created_at_epoch: toEpoch(row.occurred_at as Date | string | null),
    };
  }

  // ------------------------------------------------------------------ SSE

  /**
   * The viewer opens /stream and expects an `initial_load` followed by
   * new_observation / new_summary / new_prompt as work lands. Postgres has no
   * change feed wired here, so the connection polls for rows newer than the
   * last one it sent. The page is a dashboard for one operator, so a short
   * poll is cheaper than adding LISTEN/NOTIFY plumbing.
   */
  private handleStream(req: Request, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let closed = false;
    // Only rows created after the connection opened are pushed; the initial
    // page content comes from the paginated endpoints.
    let watermark = Date.now();

    const poll = async () => {
      if (closed) return;
      const since = watermark;
      const nextWatermark = Date.now();
      try {
        const [observations, summaries, prompts, messages] = await Promise.all([
          this.queryObservations({ offset: 0, limit: MAX_LIMIT, project: null, summaries: false, sinceEpoch: since }),
          this.queryObservations({ offset: 0, limit: MAX_LIMIT, project: null, summaries: true, sinceEpoch: since }),
          this.queryPrompts({ offset: 0, limit: MAX_LIMIT, project: null, sinceEpoch: since }),
          this.queryAgentEventText({
            offset: 0, limit: MAX_LIMIT, project: null, sinceEpoch: since,
            eventType: 'assistant_message', payloadKey: 'last_assistant_message',
          }),
        ]);
        for (const observation of observations.reverse()) send({ type: 'new_observation', observation });
        for (const summary of summaries.reverse()) send({ type: 'new_summary', summary });
        for (const prompt of prompts.reverse()) send({ type: 'new_prompt', prompt });
        for (const message of messages.reverse()) send({ type: 'new_message', message });
        watermark = nextWatermark;
      } catch (error) {
        logger.warn('SYSTEM', 'dashboard stream poll failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void this.listProjects()
      .then(projects => send({ type: 'initial_load', projects }))
      .catch(() => send({ type: 'initial_load', projects: [] }));

    const pollTimer = setInterval(() => void poll(), STREAM_POLL_MS);
    // A comment frame keeps proxies from closing an idle connection.
    const heartbeatTimer = setInterval(() => res.write(': keepalive\n\n'), STREAM_HEARTBEAT_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }
}
