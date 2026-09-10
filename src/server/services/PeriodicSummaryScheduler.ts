// SPDX-License-Identifier: Apache-2.0
//
// Periodic session summarisation.
//
// The default pipeline queues one generation job per ingested event, which
// means one provider call per tool use. On a free-tier key that exhausts the
// quota inside a single session — 34 tool calls produced 34 calls and 32
// `quota_exhausted` failures here.
//
// This scheduler runs on an interval instead. Each tick asks Postgres which
// sessions have events newer than their generation watermark
// (`server_sessions.last_generated_at`) and queues ONE summary job per such
// session. When nothing has arrived the tick queues nothing, so an idle
// machine makes no provider calls at all.
//
// Pair it with CLAUDE_MEM_GENERATE_PER_EVENT=false; leaving per-event
// generation on would defeat the batching.

import {
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository,
} from '../../storage/postgres/generation-jobs.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { withPostgresTransaction } from '../../storage/postgres/pool.js';
import { PostgresServerSessionsRepository } from '../../storage/postgres/server-sessions.js';
import { newId } from '../../storage/postgres/utils.js';
import { buildSummaryJobPayload } from '../runtime/SessionGenerationPolicy.js';
import { buildServerJobId } from '../jobs/job-id.js';
import { logger } from '../../utils/logger.js';
import type { EventQueueLike } from './IngestEventsService.js';

const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_INTERVAL_MINUTES = 1;
const MAX_SESSIONS_PER_TICK = 25;

export interface PeriodicSummarySchedulerOptions {
  pool: PostgresPool;
  resolveSummaryQueue: () => EventQueueLike | null;
  intervalMs?: number;
}

export interface SummaryTickResult {
  sessionsConsidered: number;
  jobsQueued: number;
}

/**
 * Interval between ticks. `CLAUDE_MEM_SUMMARY_INTERVAL_MINUTES` overrides the
 * default; `0` (or a negative value) disables the scheduler entirely so an
 * operator can fall back to per-event generation.
 */
export function resolveSummaryIntervalMs(): number {
  const raw = (process.env.CLAUDE_MEM_SUMMARY_INTERVAL_MINUTES ?? '').trim();
  if (raw === '') return DEFAULT_INTERVAL_MINUTES * 60_000;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(parsed, MIN_INTERVAL_MINUTES) * 60_000;
}

export class PeriodicSummaryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly options: PeriodicSummarySchedulerOptions) {
    this.intervalMs = options.intervalMs ?? resolveSummaryIntervalMs();
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    // unref so a pending tick never holds the process open during shutdown.
    this.timer = setInterval(() => {
      void this.safeTick();
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info('SYSTEM', 'periodic summary scheduler started', {
      intervalMinutes: this.intervalMs / 60_000,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('SYSTEM', 'periodic summary scheduler stopped', {});
  }

  /** Ticks are skipped while one is in flight so a slow tick cannot pile up. */
  private async safeTick(): Promise<void> {
    if (this.running) {
      logger.debug('SYSTEM', 'periodic summary tick skipped; previous tick still running', {});
      return;
    }
    this.running = true;
    try {
      const result = await this.tick();
      if (result.jobsQueued > 0) {
        logger.info('SYSTEM', 'periodic summary tick queued jobs', result);
      }
    } catch (error) {
      logger.warn('SYSTEM', 'periodic summary tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * One pass. Public so a test (or an operator endpoint) can drive it
   * directly instead of waiting for the interval.
   */
  async tick(): Promise<SummaryTickResult> {
    const sessionsRepo = new PostgresServerSessionsRepository(this.options.pool);
    const pending = await sessionsRepo.listSessionsWithNewEvents({ limit: MAX_SESSIONS_PER_TICK });
    if (pending.length === 0) {
      return { sessionsConsidered: 0, jobsQueued: 0 };
    }

    let jobsQueued = 0;
    for (const session of pending) {
      const queued = await this.queueSummaryFor(session);
      if (queued) jobsQueued++;
    }
    return { sessionsConsidered: pending.length, jobsQueued };
  }

  private async queueSummaryFor(session: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<boolean> {
    // The job identity includes a time bucket. Both `idempotency_key` and
    // `bullmq_job_id` derive from (team, project, sourceType, sourceId,
    // jobType), and for a summary sourceId is the session id — without the
    // bucket the second tick for a session would collide with the first and
    // silently update the completed row instead of queueing new work.
    const jobType = `observation_generate_session_summary:${this.currentBucket()}`;

    try {
      const outbox = await withPostgresTransaction(this.options.pool, async (client) => {
        const jobsRepo = new PostgresObservationGenerationJobRepository(client);
        const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
        const outboxId = newId();
        const payload = buildSummaryJobPayload({
          serverSessionId: session.id,
          teamId: session.teamId,
          projectId: session.projectId,
          generationJobId: outboxId,
          apiKeyId: null,
          actorId: 'system:periodic-summary',
          sourceAdapter: null,
        });
        const created = await jobsRepo.create({
          id: outboxId,
          projectId: session.projectId,
          teamId: session.teamId,
          sourceType: 'session_summary',
          sourceId: session.id,
          serverSessionId: session.id,
          jobType,
          bullmqJobId: buildServerJobId({
            kind: 'summary',
            team_id: session.teamId,
            project_id: session.projectId,
            source_type: 'session_summary',
            source_id: `${session.id}:${jobType}`,
          }),
          payload: payload as unknown as Record<string, unknown>,
        });
        await eventsLogRepo.append({
          generationJobId: created.id,
          projectId: created.projectId,
          teamId: created.teamId,
          eventType: 'queued',
          statusAfter: created.status,
          attempt: created.attempts,
          details: { source: 'periodic_summary_scheduler' },
        });
        return created;
      });

      // A tick that lands on an already-queued bucket returns the existing
      // row; re-publishing it to BullMQ is harmless (same job id) but there
      // is nothing new to do, so skip.
      if (outbox.status !== 'queued') return false;

      const queue = this.options.resolveSummaryQueue();
      if (!queue) {
        // Persisted but not published. Reconciliation picks these up.
        return true;
      }
      await queue.add(outbox.bullmqJobId ?? outbox.id, outbox.payload);
      return true;
    } catch (error) {
      logger.warn('SYSTEM', 'failed to queue periodic summary job', {
        serverSessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Bucket label for the job identity — the interval start, so every tick
   * within the same window collapses onto one job.
   */
  private currentBucket(): string {
    const bucket = Math.floor(Date.now() / this.intervalMs) * this.intervalMs;
    return new Date(bucket).toISOString();
  }
}
