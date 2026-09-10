// SPDX-License-Identifier: Apache-2.0
//
// Gemini embeddings over the AI Studio REST API.
//
// `batchEmbedContents` embeds many texts in ONE request, which matters here:
// the free tier meters requests per day, not tokens, so embedding 50
// observations one at a time would cost 50x what the same work costs
// batched — and the summary pipeline is already competing for that budget.

import { logger } from '../../../utils/logger.js';
import { EMBEDDING_DIMENSIONS } from '../../../storage/postgres/vector-support.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * `text-embedding-004` is natively 768-dimensional and generally available,
 * so it needs no dimensionality negotiation. `gemini-embedding-001` also
 * works — it honours the `outputDimensionality` we send.
 */
const DEFAULT_MODEL = 'text-embedding-004';

export interface GeminiEmbeddingProviderOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

interface BatchEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
  error?: { code?: number; status?: string; message?: string };
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiEmbeddingProviderOptions) {
    if (!options.apiKey) throw new Error('GeminiEmbeddingProvider requires an apiKey');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get label(): string {
    return `gemini:${this.model}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `${GEMINI_API_URL}/${encodeURIComponent(this.model)}:batchEmbedContents`
      + `?key=${encodeURIComponent(this.apiKey)}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
    });

    const body = await response.json().catch(() => ({})) as BatchEmbedResponse;
    if (!response.ok) {
      const detail = body.error?.message ?? response.statusText;
      throw new Error(`gemini embedding failed (${response.status}): ${detail}`);
    }

    const vectors = body.embeddings ?? [];
    // A short or ragged response would pair vectors with the wrong rows, so
    // reject the whole batch rather than write a mis-aligned subset.
    if (vectors.length !== texts.length) {
      throw new Error(
        `gemini returned ${vectors.length} embeddings for ${texts.length} inputs`
      );
    }

    return vectors.map((entry, index) => {
      const values = entry.values ?? [];
      if (values.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `embedding ${index} has ${values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`
        );
      }
      return values;
    });
  }
}

/**
 * Build the configured provider, or `null` when embeddings are off.
 *
 * Off means either an explicit `CLAUDE_MEM_EMBEDDINGS=false` or no API key —
 * both are ordinary states, not errors, so this returns null rather than
 * throwing and search simply stays keyword-only.
 */
export function resolveEmbeddingProvider(): EmbeddingProvider | null {
  const flag = (process.env.CLAUDE_MEM_EMBEDDINGS ?? '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return null;

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.CLAUDE_MEM_GEMINI_API_KEY ?? '';
  if (!apiKey) {
    logger.debug('SYSTEM', 'no Gemini key; embeddings stay off', {});
    return null;
  }

  return new GeminiEmbeddingProvider({
    apiKey,
    model: process.env.CLAUDE_MEM_EMBEDDING_MODEL?.trim() || undefined,
  });
}
