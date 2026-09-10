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
