// SPDX-License-Identifier: Apache-2.0
//
// Answering a question from the dashboard, out of what is already stored.
//
// The dashboard could already *show* observations; it could not be *asked*
// anything. Everything the answer needs was already here — the observations,
// the pgvector index that finds them by meaning, and a Gemini key — so this
// is the retrieval and the prompt, not a new subsystem.
//
// Deliberately server-side. Routing the question to the user's Claude Code
// would mean an inbound channel into a running session, which the hooks do
// not provide (all six fire outbound), and would stop working the moment the
// laptop is closed. The observations live on the server; so does the answer.
//
// Grounding comes from two places: a hand-written briefing that explains what
// the records are and what the project's vocabulary means, and the retrieved
// observations themselves. Without the briefing the model reads "잡", "워커"
// and "관측치" as ordinary words and answers confidently about the wrong
// thing.

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { getPackageRoot } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { classifyHttpProviderError } from '../generation/providers/shared/error-classification.js';
import { embedSearchQuery } from '../generation/embeddings/query-embedding.js';
import { buildSearchTerms } from '../../storage/postgres/search-terms.js';
import { EMBEDDING_COLUMN, toVectorLiteral, vectorSupport } from '../../storage/postgres/vector-support.js';
import { PostgresUsageRepository } from '../../storage/postgres/usage.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Classifications that mean "this model is spent, try the next one". */
const FAILOVER_KINDS = new Set(['quota_exhausted', 'insufficient_quota', 'resource_exhausted', 'rate_limit']);

/** Observations handed to the model. Enough to answer, few enough to stay cheap. */
const DEFAULT_SOURCES = 8;
const MAX_SOURCES = 20;

/** Per observation. A summary runs ~700 chars, so this rarely truncates. */
const MAX_SOURCE_CHARS = 2_000;

export const MAX_QUESTION_CHARS = 2_000;

/**
 * Prior exchanges carried into a follow-up. Two is enough for "그럼 왜
 * 그랬어?" to resolve and keeps the prompt from growing without bound.
 */
export const MAX_HISTORY_TURNS = 2;

export interface AskTurn {
  question: string;
  answer: string;
}

export interface AskSource {
  id: string;
  project: string | null;
  createdAtEpoch: number;
  excerpt: string;
}

export interface AskResult {
  answer: string;
  model: string;
  sources: AskSource[];
  /** True when retrieval found nothing — the answer will say so. */
  empty: boolean;
}

interface SourceRow {
  id: string;
  content: string;
  created_at: Date;
  project_label: string | null;
  team_id: string;
  project_id: string;
}

/**
 * The briefing, read once at boot.
 *
 * Shipped inside the image next to the other plugin assets so it travels
 * with the deployment; `CLAUDE_MEM_ASK_CONTEXT_FILE` points elsewhere when an
 * operator wants to edit it without rebuilding.
 */
const briefing: string = (() => {
  const override = process.env.CLAUDE_MEM_ASK_CONTEXT_FILE?.trim();
  const root = getPackageRoot();
  // In the image the bundle sits at <root>/scripts, so getPackageRoot() is
  // /opt/claude-mem and the first candidate hits. Running from source the
  // root is <repo>/src, which is why the repo-relative candidate is here.
  const candidates = [
    ...(override ? [override] : []),
    path.join(root, 'ask', 'context.md'),
    path.join(root, 'plugin', 'ask', 'context.md'),
    path.join(root, '..', 'plugin', 'ask', 'context.md'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const text = readFileSync(candidate, 'utf8');
        logger.info('SYSTEM', 'ask briefing loaded', { path: candidate, bytes: text.length });
        return text;
      }
    } catch {
      // Try the next candidate.
    }
  }
  logger.warn('SYSTEM', 'ask briefing not found; answers will be less grounded', { candidates });
  return '';
})();

export function askBriefingLoaded(): boolean {
  return briefing.length > 0;
}

/** Candidate models, in the order generation tries them. */
export function askModels(): string[] {
  return (process.env.CLAUDE_MEM_SERVER_MODEL ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function askApiKey(): string {
  return process.env.GEMINI_API_KEY ?? process.env.CLAUDE_MEM_GEMINI_API_KEY ?? '';
}

export interface AskServiceOptions {
  pool: PostgresPool;
  fetchImpl?: typeof fetch;
}

export class AskService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AskServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async ask(input: {
    question: string;
    project?: string | null;
    limit?: number;
    history?: AskTurn[];
  }): Promise<AskResult> {
    const question = input.question.trim();
    if (question === '') throw new Error('question is empty');

    const history = (input.history ?? []).slice(-MAX_HISTORY_TURNS);
    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_SOURCES), MAX_SOURCES);
    // A follow-up is often too terse to retrieve on ("그럼 왜 그랬어?"), so
    // the thread's earlier questions carry the topic into the search.
    const retrievalQuery = [...history.map(turn => turn.question), question].join(' ');
    const rows = await this.retrieve(retrievalQuery, input.project ?? null, limit);

    const sources: AskSource[] = rows.map(row => ({
      id: row.id,
      project: row.project_label,
      createdAtEpoch: new Date(row.created_at).getTime(),
      excerpt: row.content.slice(0, 240),
    }));

    // Retrieval finding nothing used to short-circuit with a canned line, to
    // save a call. In a chat window that reads as broken: "안녕" matches no
    // record, so a greeting got answered with "관련된 기록을 찾지 못했습니다".
    // The model is asked either way and told there were no records, so it can
    // greet, explain itself, or say the lookup came up empty — whichever the
    // message actually calls for. One request is worth not feeling dead.
    const prompt = this.buildPrompt(question, rows, history);
    const { answer, model, tokensUsed } = await this.generate(prompt);
    // Attribute the spend to the team whose records were read. Without this
    // the dashboard's "남은 요청" keeps counting down only summarisation
    // while asking quietly draws from the same daily allowance.
    await this.meter({ row: rows[0], model, tokensUsed });
    return { answer, model, sources, empty: rows.length === 0 };
  }

  /**
   * Observations most likely to answer the question.
   *
   * Same blend the search endpoint uses — semantic distance where pgvector
   * is present, literal term matching always — because either alone misses:
   * embeddings blur an exact identifier, keywords miss a paraphrase.
   */
  private async retrieve(question: string, project: string | null, limit: number): Promise<SourceRow[]> {
    const terms = buildSearchTerms(question);
    const embedding = await embedSearchQuery(question);
    const semantic = vectorSupport() === true && Array.isArray(embedding) && embedding.length > 0;

    const params: unknown[] = [limit, question, terms];
    let projectClause = '';
    if (project) {
      params.push(project);
      projectClause = `AND COALESCE(s.metadata->>'project', p.name, 'unknown') = $${params.length}`;
    }

    let semanticMatch = '';
    let semanticRank = '';
    if (semantic) {
      params.push(toVectorLiteral(embedding as number[]));
      const idx = params.length;
      semanticMatch = `
          OR (o.${EMBEDDING_COLUMN} IS NOT NULL AND o.${EMBEDDING_COLUMN} <=> $${idx}::vector < 0.45)`;
      semanticRank = `
          + COALESCE(GREATEST(0, 1 - (o.${EMBEDDING_COLUMN} <=> $${idx}::vector)), 0)`;
    }

    const result = await this.options.pool.query<SourceRow>(
      `
        SELECT o.id, o.content, o.created_at, o.team_id, o.project_id,
               COALESCE(s.metadata->>'project', p.name, 'unknown') AS project_label
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        LEFT JOIN projects p ON p.id = o.project_id
        WHERE (
            o.content_search @@ websearch_to_tsquery('english', $2)
            OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS term WHERE o.content ILIKE '%' || term || '%')
            ${semanticMatch}
          )
          ${projectClause}
        ORDER BY
          ts_rank(o.content_search, websearch_to_tsquery('english', $2))
          + COALESCE((
              SELECT count(*)::float FROM unnest($3::text[]) AS term
              WHERE o.content ILIKE '%' || term || '%'
            ) / NULLIF(array_length($3::text[], 1), 0), 0)
          ${semanticRank}
          DESC,
          o.created_at DESC
        LIMIT $1
      `,
      params,
    );
    return result.rows;
  }

  private buildPrompt(question: string, rows: SourceRow[], history: AskTurn[] = []): string {
    // Oldest first: the records often revisit the same problem, and a reader
    // asked to describe "how we fixed X" needs them in the order they happened.
    const ordered = [...rows].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const records = ordered.length === 0
      ? '(이 질문과 관련된 기록을 찾지 못했습니다.)'
      : ordered.map((row, index) => {
      const when = new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 16);
      return `### 기록 ${index + 1} · ${when} · ${row.project_label ?? 'unknown'}\n`
        + row.content.slice(0, MAX_SOURCE_CHARS);
      }).join('\n\n');

    const priorTurns = history.length > 0
      ? ['---', '## 이전 대화', history
          .map(turn => `**질문:** ${turn.question}\n**답변:** ${turn.answer}`)
          .join('\n\n')]
      : [];

    return [
      briefing,
      '---',
      '## 참고할 기록',
      records,
      ...priorTurns,
      '---',
      '## 질문',
      question,
    ].filter(part => part.length > 0).join('\n\n');
  }

  /**
   * Ask each candidate model in turn, moving on only when one is out of
   * quota. Any other failure is the answer failing, not the model being
   * spent, so it stops there rather than burning the rest of the list.
   */
  /**
   * Record the call so the model panel counts it.
   *
   * Best-effort: an answer already produced must not be thrown away because
   * bookkeeping failed. Both rows carry `source: 'ask'` so the two consumers
   * can be told apart later.
   */
  private async meter(input: {
    row: SourceRow | undefined;
    model: string;
    tokensUsed: number | null;
  }): Promise<void> {
    // A question that retrieved nothing still spent a request, so it still
    // has to be counted; with no row to attribute it to, any team will do on
    // a single-tenant deployment.
    const teamId = input.row?.team_id ?? await this.anyTeamId();
    if (!teamId) return;
    try {
      const repo = new PostgresUsageRepository(this.options.pool);
      const metadata = { model: input.model, source: 'ask' };
      await repo.record({
        teamId,
        projectId: input.row?.project_id ?? null,
        kind: 'request',
        quantity: 1,
        metadata,
      });
      if (input.tokensUsed !== null) {
        await repo.record({
          teamId,
          projectId: input.row?.project_id ?? null,
          kind: 'tokens',
          quantity: input.tokensUsed,
          metadata,
        });
      }
    } catch (error) {
      logger.warn('SYSTEM', 'could not meter an ask call', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async anyTeamId(): Promise<string | null> {
    try {
      const result = await this.options.pool.query<{ id: string }>('SELECT id FROM teams LIMIT 1');
      return result.rows[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  private async generate(prompt: string): Promise<{ answer: string; model: string; tokensUsed: number | null }> {
    const apiKey = askApiKey();
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

    const models = askModels();
    if (models.length === 0) throw new Error('CLAUDE_MEM_SERVER_MODEL lists no models');

    let lastError: unknown;
    for (const model of models) {
      try {
        const { text, tokensUsed } = await this.callGemini(apiKey, model, prompt);
        return { answer: text, model, tokensUsed };
      } catch (error) {
        lastError = error;
        const kind = (error as { kind?: string })?.kind;
        if (!kind || !FAILOVER_KINDS.has(kind)) throw error;
        logger.info('SYSTEM', 'ask: model out of quota, trying the next', { model });
      }
    }
    throw lastError ?? new Error('no model answered');
  }

  private async callGemini(
    apiKey: string,
    model: string,
    prompt: string,
  ): Promise<{ text: string; tokensUsed: number | null }> {
    const url = `${GEMINI_API_URL}/${encodeURIComponent(model)}:generateContent`
      + `?key=${encodeURIComponent(apiKey)}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`Gemini HTTP ${response.status}`),
        providerLabel: 'gemini',
      });
    }

    let data: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { totalTokenCount?: number };
      error?: { message?: string };
    };
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new Error('Gemini returned invalid JSON');
    }
    if (data.error) throw new Error(data.error.message ?? 'Gemini returned an error');

    const text = data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim() ?? '';
    if (!text) throw new Error('Gemini returned an empty answer');
    const total = data.usageMetadata?.totalTokenCount;
    return { text, tokensUsed: typeof total === 'number' ? total : null };
  }
}
