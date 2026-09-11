import { afterEach, describe, expect, it } from 'bun:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import {
  EMBEDDING_DIMENSIONS,
  resetVectorSupportCache,
  toVectorLiteral,
  vectorSupport,
} from '../../../src/storage/postgres/vector-support.js';
import type { PostgresQueryable } from '../../../src/storage/postgres/utils.js';

class CapturingClient implements PostgresQueryable {
  readonly calls: Array<{ text: string; values?: unknown[] }> = [];

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    this.calls.push({ text, values });
    return { command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] };
  }
}

class CountingClient implements PostgresQueryable {
  constructor(private readonly row: Record<string, unknown>) {}

  async query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> {
    return { command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [this.row as T] };
  }
}

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);

afterEach(() => {
  resetVectorSupportCache(null);
});

describe('toVectorLiteral', () => {
  it('formats as pgvector text input, not a Postgres array', () => {
    // node-postgres would send `{1,2,3}` for a JS array, which `vector` rejects.
    expect(toVectorLiteral([1, 2, 3])).toBe('[1,2,3]');
  });
});

describe('observation search with pgvector available', () => {
  it('adds the distance filter and blends the similarity into the ranking', async () => {
    resetVectorSupportCache(true);
    const client = new CapturingClient();

    await new PostgresObservationRepository(client).search({
      projectId: 'project-1',
      teamId: 'team-1',
      query: '큐 접두어',
      queryEmbedding: vector,
    });

    const [call] = client.calls;
    expect(call.text).toContain('embedding_vector <=> $7::vector');
    // Both halves must be present: the filter widens the candidate set, the
    // rank term is what actually orders a no-keyword-in-common hit.
    expect(call.text).toContain('GREATEST(0, 1 - (observations.embedding_vector <=> $7::vector))');
    expect(call.values?.[6]).toBe(toVectorLiteral(vector));
  });

  it('stays keyword-only when the caller supplies no embedding', async () => {
    resetVectorSupportCache(true);
    const client = new CapturingClient();

    await new PostgresObservationRepository(client).search({
      projectId: 'project-1',
      teamId: 'team-1',
      query: 'queue prefix',
    });

    const [call] = client.calls;
    expect(call.text).not.toContain('::vector');
    expect(call.values).toHaveLength(6);
  });
});

describe('observation search without pgvector', () => {
  it('never emits a vector cast, because the type does not exist there', async () => {
    // On stock Postgres `$7::vector` is not an empty result — it is an error
    // that would take down search entirely.
    resetVectorSupportCache(false);
    const client = new CapturingClient();

    await new PostgresObservationRepository(client).search({
      projectId: 'project-1',
      teamId: 'team-1',
      query: 'queue prefix',
      queryEmbedding: vector,
    });

    const [call] = client.calls;
    expect(call.text).not.toContain('::vector');
    expect(call.values).toHaveLength(6);
  });

  it('is also skipped before the probe has run', async () => {
    resetVectorSupportCache(null);
    expect(vectorSupport()).toBeNull();
    const client = new CapturingClient();

    await new PostgresObservationRepository(client).search({
      projectId: 'project-1',
      teamId: 'team-1',
      query: 'queue prefix',
      queryEmbedding: vector,
    });

    expect(client.calls[0]?.text).not.toContain('::vector');
  });
});

describe('embedding backfill queries', () => {
  it('asks for the oldest unembedded rows first so a backlog drains in order', async () => {
    const client = new CapturingClient();
    await new PostgresObservationRepository(client).listMissingEmbeddings({ limit: 10 });

    const [call] = client.calls;
    expect(call.text).toContain('embedding_vector IS NULL');
    expect(call.text).toContain('ORDER BY created_at ASC');
    expect(call.values).toEqual([10]);
  });

  it('writes a whole batch in one statement', async () => {
    const client = new CapturingClient();
    await new PostgresObservationRepository(client).setEmbeddings([
      { id: 'obs-1', vector: [1, 2] },
      { id: 'obs-2', vector: [3, 4] },
    ]);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].values).toEqual([['obs-1', 'obs-2'], ['[1,2]', '[3,4]']]);
  });

  it('does not touch the database for an empty batch', async () => {
    const client = new CapturingClient();
    const written = await new PostgresObservationRepository(client).setEmbeddings([]);

    expect(written).toBe(0);
    expect(client.calls).toHaveLength(0);
  });
});

describe('embedding status query', () => {
  it('reports progress and the last write time together', async () => {
    // The count alone cannot tell "all done" from "died with a gap", which
    // is exactly the failure that went unnoticed; the timestamp is what
    // separates them.
    const client = new CapturingClient();
    await new PostgresObservationRepository(client).embeddingStats();

    const [call] = client.calls;
    expect(call.text).toContain('FILTER (WHERE embedding_vector IS NOT NULL)');
    expect(call.text).toContain('max(embedded_at)');
  });

  it('coerces Postgres bigint counts, which arrive as strings', async () => {
    const client = new CountingClient({ embedded: '12', total: '40', last_embedded_at: null });
    const stats = await new PostgresObservationRepository(client).embeddingStats();

    expect(stats).toEqual({ embedded: 12, total: 40, lastEmbeddedAtEpoch: null });
  });

  it('returns the last write as an epoch', async () => {
    const at = new Date('2026-09-11T01:02:03.000Z');
    const client = new CountingClient({ embedded: '1', total: '1', last_embedded_at: at });
    const stats = await new PostgresObservationRepository(client).embeddingStats();

    expect(stats.lastEmbeddedAtEpoch).toBe(at.getTime());
  });

  it('reads zero from an empty table rather than NaN', async () => {
    const client = new CapturingClient();
    expect(await new PostgresObservationRepository(client).embeddingStats())
      .toEqual({ embedded: 0, total: 0, lastEmbeddedAtEpoch: null });
  });
});

describe('setEmbeddings', () => {
  it('stamps the write time but leaves updated_at alone', async () => {
    // Filling a vector must not reorder the feed, so updated_at is pinned;
    // embedded_at exists precisely because of that.
    const client = new CapturingClient();
    await new PostgresObservationRepository(client).setEmbeddings([{ id: 'o1', vector: [1] }]);

    const [call] = client.calls;
    expect(call.text).toContain('embedded_at = now()');
    expect(call.text).toContain('updated_at = o.updated_at');
  });
});
