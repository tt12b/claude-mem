import { afterEach, describe, expect, it } from 'bun:test';
import { GeminiEmbeddingProvider } from '../../src/server/generation/embeddings/GeminiEmbeddingProvider.js';
import { ObservationEmbeddingScheduler } from '../../src/server/services/ObservationEmbeddingScheduler.js';
import { EMBEDDING_DIMENSIONS, resetVectorSupportCache } from '../../src/storage/postgres/vector-support.js';
import type { EmbeddingProvider } from '../../src/server/generation/embeddings/EmbeddingProvider.js';

function values(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => seed);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  resetVectorSupportCache(null);
});

describe('GeminiEmbeddingProvider', () => {
  it('sends the whole batch as one request', async () => {
    let calls = 0;
    let body: any;
    const provider = new GeminiEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls++;
        body = JSON.parse(String(init.body));
        return jsonResponse({ embeddings: [{ values: values(1) }, { values: values(2) }] });
      }) as unknown as typeof fetch,
    });

    const result = await provider.embed(['first', 'second']);

    // The free tier meters requests, not tokens — batching is the whole point.
    expect(calls).toBe(1);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].outputDimensionality).toBe(EMBEDDING_DIMENSIONS);
    expect(result).toHaveLength(2);
  });

  it('makes no request at all for an empty batch', async () => {
    let calls = 0;
    const provider = new GeminiEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async () => { calls++; return jsonResponse({}); }) as unknown as typeof fetch,
    });

    expect(await provider.embed([])).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects a short response instead of mis-pairing vectors with rows', async () => {
    const provider = new GeminiEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async () => jsonResponse({ embeddings: [{ values: values(1) }] })) as unknown as typeof fetch,
    });

    // Two texts in, one vector back: silently keeping it would attach the
    // first text's vector to whichever row happened to be second.
    await expect(provider.embed(['a', 'b'])).rejects.toThrow('1 embeddings for 2 inputs');
  });

  it('rejects a vector of the wrong width', async () => {
    const provider = new GeminiEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async () => jsonResponse({ embeddings: [{ values: [1, 2, 3] }] })) as unknown as typeof fetch,
    });

    await expect(provider.embed(['a'])).rejects.toThrow('3 dimensions');
  });

  it('surfaces the provider message on an HTTP error', async () => {
    const provider = new GeminiEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async () => jsonResponse({ error: { message: 'quota gone' } }, 429)) as unknown as typeof fetch,
    });

    await expect(provider.embed(['a'])).rejects.toThrow('quota gone');
  });
});

class FakeProvider implements EmbeddingProvider {
  readonly label = 'fake';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly batches: string[][] = [];

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.batches.push([...texts]);
    return texts.map((_, index) => values(index));
  }
}

function fakePool(rows: Array<{ id: string; content: string }>) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    pool: {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, values: params });
        if (text.includes('SELECT id, content')) {
          return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
        }
        return { command: 'UPDATE', rowCount: rows.length, oid: 0, fields: [], rows: [] };
      },
    } as never,
  };
}

describe('ObservationEmbeddingScheduler', () => {
  it('does nothing when pgvector is not available', async () => {
    resetVectorSupportCache(false);
    const provider = new FakeProvider();
    const { calls, pool } = fakePool([{ id: 'obs-1', content: 'hello' }]);

    const result = await new ObservationEmbeddingScheduler({ pool, provider }).tick();

    // `skipped` separates "could not run" from "nothing to do" — both used
    // to be silent, which is what made a stalled backfill hard to spot.
    expect(result).toEqual({ considered: 0, embedded: 0, skipped: true });
    expect(provider.batches).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('embeds pending rows and writes them back', async () => {
    resetVectorSupportCache(true);
    const provider = new FakeProvider();
    const { pool } = fakePool([
      { id: 'obs-1', content: 'hello' },
      { id: 'obs-2', content: 'world' },
    ]);

    const result = await new ObservationEmbeddingScheduler({ pool, provider }).tick();

    expect(provider.batches).toEqual([['hello', 'world']]);
    expect(result.considered).toBe(2);
    expect(result.embedded).toBe(2);
  });

  it('skips the provider call when nothing is pending', async () => {
    resetVectorSupportCache(true);
    const provider = new FakeProvider();
    const { pool } = fakePool([]);

    expect(await new ObservationEmbeddingScheduler({ pool, provider }).tick())
      .toEqual({ considered: 0, embedded: 0 });
    expect(provider.batches).toHaveLength(0);
  });

  it('runNow sweeps immediately instead of waiting for the interval', async () => {
    resetVectorSupportCache(true);
    const provider = new FakeProvider();
    const { pool } = fakePool([{ id: 'obs-1', content: 'hello' }]);

    const result = await new ObservationEmbeddingScheduler({ pool, provider }).runNow();

    expect(result.embedded).toBe(1);
    expect(provider.batches).toEqual([['hello']]);
  });

  it('runNow does nothing while a tick is already in flight', async () => {
    resetVectorSupportCache(true);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: EmbeddingProvider = {
      label: 'slow',
      dimensions: EMBEDDING_DIMENSIONS,
      async embed(texts) { await gate; return texts.map((_, i) => values(i)); },
    };
    const { pool } = fakePool([{ id: 'obs-1', content: 'hello' }]);
    const scheduler = new ObservationEmbeddingScheduler({ pool, provider });

    // Two overlapping sweeps would embed the same rows twice and spend the
    // provider budget for nothing.
    const first = scheduler.runNow();
    const second = await scheduler.runNow();
    release();
    await first;

    expect(second).toEqual({ considered: 0, embedded: 0 });
  });

  it('truncates a long observation so the model does not reject the batch', async () => {
    resetVectorSupportCache(true);
    const provider = new FakeProvider();
    const { pool } = fakePool([{ id: 'obs-1', content: 'x'.repeat(20_000) }]);

    await new ObservationEmbeddingScheduler({ pool, provider }).tick();

    expect(provider.batches[0][0].length).toBe(6_000);
  });
});
