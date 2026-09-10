// SPDX-License-Identifier: Apache-2.0
//
// Embedding a search query, on the read path.
//
// Semantic search needs the query in the same vector space as the stored
// observations, which means one provider call per search. Two things keep
// that from being expensive:
//
//   - it is skipped entirely unless pgvector is present, so a deployment
//     without it never pays for a call it could not use;
//   - identical queries are cached briefly, because the session-init hook
//     asks the same question every time a session starts.
//
// Failure here is never fatal. A null return means "no semantic signal", and
// the caller falls back to keyword search — which is the behaviour that
// shipped before embeddings existed.

import { logger } from '../../../utils/logger.js';
import { vectorSupport } from '../../../storage/postgres/vector-support.js';
import { resolveEmbeddingProvider } from './GeminiEmbeddingProvider.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';

/** How long a query's vector stays reusable. */
const CACHE_TTL_MS = 10 * 60_000;
/** Cap on distinct cached queries; evicts oldest-inserted first. */
const CACHE_MAX = 200;

interface CacheEntry {
  vector: number[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

let provider: EmbeddingProvider | null | undefined;

function currentProvider(): EmbeddingProvider | null {
  if (provider === undefined) provider = resolveEmbeddingProvider();
  return provider;
}

/** Test seam: drop the memoised provider and every cached vector. */
export function resetQueryEmbeddingState(): void {
  provider = undefined;
  cache.clear();
}

export async function embedSearchQuery(query: string): Promise<number[] | null> {
  const trimmed = query.trim();
  if (trimmed === '') return null;
  if (vectorSupport() !== true) return null;

  const active = currentProvider();
  if (!active) return null;

  const now = Date.now();
  const hit = cache.get(trimmed);
  if (hit && hit.expiresAt > now) return hit.vector;

  try {
    const [vector] = await active.embed([trimmed]);
    if (!vector) return null;
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(trimmed, { vector, expiresAt: now + CACHE_TTL_MS });
    return vector;
  } catch (error) {
    logger.debug('SYSTEM', 'query embedding failed; keyword search only', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
