// SPDX-License-Identifier: Apache-2.0
//
// Publish generation jobs that Postgres says are due but BullMQ never got.
//
// Three code paths already write "the row stays queued and reconciliation
// will publish it" — the ingest path when the queue is down, the operator
// retry path when re-enqueueing throws, and markGenerationFailed when it
// sends a retryable failure back to `queued`. Nothing was doing the
// reconciling. The visible cost was 141 session summaries that failed once
// on a spent quota and were never attempted again; the quieter cost is that
// every retry in the system was decorative.
//
// The sweep is deliberately dumb: read the due rows, republish each one
// under its existing BullMQ job id. It does not decide anything the database
// has not already decided, so running it more often is never wrong — the
// worst case is republishing a job that is already queued in BullMQ, which
// collapses on the shared job id.

import { logger } from '../../utils/logger.js';
import { PostgresObservationGenerationJobRepository } from '../../storage/postgres/generation-jobs.js';
import type { PostgresObservationGenerationJob } from '../../storage/postgres/generation-jobs.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';

const DEFAULT_INTERVAL_MINUTES = 2;
const MIN_INTERVAL_MINUTES = 0.5;

/** Republished per sweep. Bounded so one tick cannot flood the workers. */
const MAX_JOBS_PER_TICK = 50;

export interface QueueLike {
  add(jobId: string, payload: unknown, options?: unknown): Promise<unknown>;
  remove(jobId: string): Promise<void>;
}

export interface QueuedJobReconcilerOptions {
  pool: PostgresPool;
  /** Lane for a job's source type, or null when that queue is unavailable. */
  resolveQueue: (sourceType: string) => QueueLike | null;
  intervalMs?: number;
}

export interface ReconcileTickResult {
  due: number;
  republished: number;
}

/**
 * `CLAUDE_MEM_REQUEUE_INTERVAL_MINUTES` overrides the default; `0` or a
 * negative value disables the sweep.
 */
export function resolveRequeueIntervalMs(): number {
  const raw = (process.env.CLAUDE_MEM_REQUEUE_INTERVAL_MINUTES ?? '').trim();
  if (raw === '') return DEFAULT_INTERVAL_MINUTES * 60_000;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(parsed, MIN_INTERVAL_MINUTES) * 60_000;
}

export class QueuedJobReconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly options: QueuedJobReconcilerOptions) {
    this.intervalMs = options.intervalMs ?? resolveRequeueIntervalMs();
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    // Sweep once at startup: a crash between insert and publish leaves rows
    // that would otherwise wait a full interval for no reason.
    void this.safeTick();
    this.timer = setInterval(() => {
      void this.safeTick();
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info('SYSTEM', 'queued job reconciler started', {
      intervalMinutes: this.intervalMs / 60_000,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('SYSTEM', 'queued job reconciler stopped', {});
  }

  private async safeTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.tick();
      if (result.republished > 0) {
        logger.info('SYSTEM', 'republished queued generation jobs', result);
      }
    } catch (error) {
      logger.warn('SYSTEM', 'queued job reconciliation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One sweep. Public so a test can drive it without the timer. */
  async tick(): Promise<ReconcileTickResult> {
    const repo = new PostgresObservationGenerationJobRepository(this.options.pool);
    const due = await repo.listDueQueued({ limit: MAX_JOBS_PER_TICK });
    if (due.length === 0) return { due: 0, republished: 0 };

    let republished = 0;
    for (const job of due) {
      if (await this.publish(job)) republished++;
    }
    return { due: due.length, republished };
  }

  private async publish(job: PostgresObservationGenerationJob): Promise<boolean> {
    // Without a BullMQ id there is no stable slot to publish into, and
    // inventing one would break the idempotency the id exists to provide.
    if (!job.bullmqJobId) return false;

    const queue = this.options.resolveQueue(job.sourceType);
    if (!queue) return false;

    try {
      // A completed or failed BullMQ slot keeps the id occupied and silently
      // swallows the add, so clear it first — the same order the operator
      // retry path uses. An active job cannot be removed, which is the
      // correct outcome: it is already running.
      try {
        await queue.remove(job.bullmqJobId);
      } catch {
        /* no slot to clear, or it is active — either way, carry on. */
      }
      await queue.add(job.bullmqJobId, job.payload);
      return true;
    } catch (error) {
      logger.warn('SYSTEM', 'failed to republish a queued generation job', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
