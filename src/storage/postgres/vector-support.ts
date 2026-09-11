// SPDX-License-Identifier: Apache-2.0
//
// Optional pgvector storage for observation embeddings.
//
// Keyword search cannot find a memory that says the same thing in different
// words — and after the Korean particle work it still cannot match "큐 접두어"
// against a stored "queue prefix". Embeddings close that gap.
//
// pgvector is an extension, not core Postgres, so it may simply not be there:
// the stock `postgres:17-alpine` image has no `vector` type, and CI runs
// against exactly that. Probing for it is therefore part of the design, not a
// workaround — the server has to keep booting and keyword search has to keep
// working on a plain Postgres. Every vector code path is gated on the answer.
//
// The probe is deliberately separate from `bootstrapServerPostgresSchema`:
// that migration runs as one transaction, and a failed CREATE EXTENSION
// inside it would abort the entire schema bootstrap.

import { logger } from '../../utils/logger.js';
import type { PostgresQueryable } from './utils.js';

/**
 * Embedding width. Gemini's `text-embedding-004` is natively 768, and
 * `gemini-embedding-001` is asked for 768 via `outputDimensionality`, so both
 * land in the same column.
 *
 * The column is typed with this width, so changing it means an ALTER and a
 * re-embed of every stored row — it is not a runtime knob.
 */
export const EMBEDDING_DIMENSIONS = 768;

export const EMBEDDING_COLUMN = 'embedding_vector';
export const EMBEDDED_AT_COLUMN = 'embedded_at';

/**
 * Formats a vector the way pgvector's text input expects: `[1,2,3]`.
 * Passing the array through node-postgres directly would send a Postgres
 * array literal (`{1,2,3}`), which the `vector` type rejects.
 */
export function toVectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

let cached: boolean | null = null;

/** Test seam — lets a suite assert both the supported and unsupported paths. */
export function resetVectorSupportCache(value: boolean | null = null): void {
  cached = value;
}

/**
 * Whether the last probe found pgvector. `null` until `ensureVectorSupport`
 * has run, so callers can tell "no" apart from "not asked yet".
 */
export function vectorSupport(): boolean | null {
  return cached;
}

/**
 * Create the extension, column and index if the server has pgvector.
 *
 * Idempotent and safe to call on every boot. Each statement runs on its own
 * so that a Postgres too old for HNSW still gets the column — search then
 * falls back to a sequential distance scan, which at this corpus size is
 * fine.
 */
export async function ensureVectorSupport(client: PostgresQueryable): Promise<boolean> {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  } catch (error) {
    cached = false;
    logger.info('SYSTEM', 'pgvector unavailable; semantic search stays off', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  try {
    await client.query(
      `ALTER TABLE observations ADD COLUMN IF NOT EXISTS ${EMBEDDING_COLUMN} vector(${EMBEDDING_DIMENSIONS})`
    );
    // When the vector was written. `updated_at` cannot answer this — the
    // backfill deliberately leaves it alone so filling a vector does not
    // reorder the feed — and without a timestamp there is no way to tell a
    // backfill that is keeping up from one that died hours ago.
    await client.query(
      `ALTER TABLE observations ADD COLUMN IF NOT EXISTS ${EMBEDDED_AT_COLUMN} TIMESTAMPTZ`
    );
  } catch (error) {
    cached = false;
    logger.warn('SYSTEM', 'pgvector present but the embedding column could not be added', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  try {
    // Cosine distance, matching how the query ranks. HNSW needs pgvector
    // 0.5+; without it the column still works, just unindexed.
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_observations_embedding_vector
         ON observations USING hnsw (${EMBEDDING_COLUMN} vector_cosine_ops)`
    );
  } catch (error) {
    logger.info('SYSTEM', 'embedding index not created; scanning without one', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  cached = true;
  logger.info('SYSTEM', 'pgvector ready; semantic search enabled', {
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return true;
}
