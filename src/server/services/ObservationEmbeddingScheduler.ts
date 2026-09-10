// SPDX-License-Identifier: Apache-2.0
//
// Backfill embeddings for observations that do not have one yet.
//
// Embedding on the write path was the obvious alternative and is the wrong
// one here: observations are persisted inside a Postgres transaction, and
// holding that transaction open across an HTTP call to Google would tie the
// database's fate to a third party's latency. Worse, it would leave every
// observation written before this feature existed permanently unsearchable
// by meaning.
//
// So the vectors are filled in behind the write, on a timer. A row is
// keyword-searchable the moment it lands and becomes semantically searchable
// a tick later; nothing is lost if a tick fails, because the row simply
// stays in the "missing" set and is picked up next time.

import { logger } from '../../utils/logger.js';
import { PostgresObservationRepository } from '../../storage/postgres/observations.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { vectorSupport } from '../../storage/postgres/vector-support.js';
import { MAX_EMBEDDING_BATCH, type EmbeddingProvider } from '../generation/embeddings/EmbeddingProvider.js';

const DEFAULT_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MINUTES = 1;

/**
 * Rows embedded per tick. One provider call covers a whole batch, so this is
 * bounded by how much work should happen between ticks rather than by cost.
 */
const MAX_ROWS_PER_TICK = MAX_EMBEDDING_BATCH;

/**
 * Characters of an observation actually sent. The embedding models cap
 * their input at a couple of thousand tokens and a summary can run longer;
 * the opening of an observation carries its subject, so a head truncation
 * loses least.
 */
const MAX_CHARS_PER_TEXT = 6_000;

export interface ObservationEmbeddingSchedulerOptions {
  pool: PostgresPool;
  provider: EmbeddingProvider;
  intervalMs?: number;
}

export interface EmbeddingTickResult {
  considered: number;
  embedded: number;
}

/**
 * `CLAUDE_MEM_EMBEDDING_INTERVAL_MINUTES` overrides the default; `0` or a
 * negative value disables the backfill while leaving query-time embedding
 * (and any vectors already stored) working.
 */
export function resolveEmbeddingIntervalMs(): number {
  const raw = (process.env.CLAUDE_MEM_EMBEDDING_INTERVAL_MINUTES ?? '').trim();
  if (raw === '') return DEFAULT_INTERVAL_MINUTES * 60_000;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(parsed, MIN_INTERVAL_MINUTES) * 60_000;
}

export class ObservationEmbeddingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;

  constructor(private readonly options: ObservationEmbeddingSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? resolveEmbeddingIntervalMs();
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    // Sweep once at startup. Without it every restart pushes the next embed
    // a full interval out, so a run of deploys can starve the backfill
    // entirely — which is exactly what happened while this was being wired up.
    void this.safeTick();
    this.timer = setInterval(() => {
      void this.safeTick();
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info('SYSTEM', 'observation embedding scheduler started', {
      intervalMinutes: this.intervalMs / 60_000,
      provider: this.options.provider.label,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('SYSTEM', 'observation embedding scheduler stopped', {});
  }

  private async safeTick(): Promise<void> {
    if (this.running) {
      logger.debug('SYSTEM', 'embedding tick skipped; previous tick still running', {});
      return;
    }
    this.running = true;
    try {
      const result = await this.tick();
      if (result.embedded > 0) {
        logger.info('SYSTEM', 'embedded observations', result);
      }
    } catch (error) {
      // A provider outage or a spent quota is expected, not exceptional:
      // the rows stay unembedded and the next tick tries again.
      logger.warn('SYSTEM', 'embedding tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** One pass. Public so a test can drive it without waiting for the timer. */
  async tick(): Promise<EmbeddingTickResult> {
    if (vectorSupport() !== true) return { considered: 0, embedded: 0 };

    const repo = new PostgresObservationRepository(this.options.pool);
    const pending = await repo.listMissingEmbeddings({ limit: MAX_ROWS_PER_TICK });
    if (pending.length === 0) return { considered: 0, embedded: 0 };

    const vectors = await this.options.provider.embed(
      pending.map(row => row.content.slice(0, MAX_CHARS_PER_TEXT))
    );

    const embedded = await repo.setEmbeddings(
      pending.map((row, index) => ({ id: row.id, vector: vectors[index] }))
    );
    return { considered: pending.length, embedded };
  }
}
