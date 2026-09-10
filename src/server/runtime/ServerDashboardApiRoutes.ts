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

import type { Application, Request, Response } from 'express';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_LIMIT = 50;
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
    app.get('/api/context/preview', this.wrap(this.handleContextPreview));
    app.get('/api/logs', (_req: Request, res: Response) => {
      // The worker streams its own log file here. The server runtime logs to
      // the container's stdout/log file instead, so report empty rather than
      // 404 — the viewer's log modal then renders as "nothing to show".
      res.json({ logs: [] });
    });
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

    const [calls, tokens, active, limits] = await Promise.all([
      this.options.pool.query<{ model: string | null; event_type: string; count: string }>(
        `SELECT details->>'model' AS model, event_type, count(*)::text AS count
           FROM observation_generation_job_events
          WHERE event_type IN ('completed', 'failed') AND created_at >= $1
          GROUP BY 1, 2`,
        [since],
      ),
      this.options.pool.query<{ model: string | null; total: string }>(
        `SELECT metadata->>'model' AS model, COALESCE(sum(quantity), 0)::text AS total
           FROM usage_events
          WHERE kind = 'tokens' AND created_at >= $1
          GROUP BY 1`,
        [since],
      ),
      this.options.pool.query<{ model: string | null }>(
        `SELECT details->>'model' AS model
           FROM observation_generation_job_events
          WHERE event_type = 'completed' AND details->>'model' IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [],
      ),
      // The ceiling Google last enforced, parsed out of the quota message.
      this.options.pool.query<{ reason: string | null }>(
        `SELECT last_error->>'reason' AS reason
           FROM observation_generation_jobs
          WHERE status = 'failed' AND last_error->>'reason' LIKE '%limit=%'
          ORDER BY updated_at DESC
          LIMIT 50`,
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

    const tokensByModel = new Map<string, number>(
      tokens.rows.map(row => [row.model ?? 'unknown', Number(row.total)]),
    );

    const limitByModel = new Map<string, number>();
    for (const row of limits.rows) {
      const text = row.reason ?? '';
      const limit = /limit=([0-9]+)/.exec(text)?.[1];
      const model = /model=([A-Za-z0-9._-]+)/.exec(text)?.[1];
      if (limit && model && !limitByModel.has(model)) limitByModel.set(model, Number(limit));
    }

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
      activeModel,
      models: names.map(name => {
        const c = callsByModel.get(name) ?? { succeeded: 0, failed: 0 };
        const used = c.succeeded + c.failed;
        const limit = limitByModel.get(name) ?? null;
        return {
          name,
          configured: configured.includes(name),
          active: name === activeModel,
          priority: configured.indexOf(name),
          calls: { total: used, succeeded: c.succeeded, failed: c.failed },
          tokens: tokensByModel.get(name) ?? 0,
          limit,
          remaining: limit !== null ? Math.max(0, limit - used) : null,
        };
      }).sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        return a.priority - b.priority;
      }),
    });
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
