// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, JsonValue, PostgresQueryable } from './utils.js';
import {
  assertProjectOwnership,
  assertSessionOwnership,
  canonicalJson,
  deterministicKey,
  newId,
  queryOne,
  toEpoch,
  toJsonObject
} from './utils.js';
import { normalizePlatformSourceOrNull } from '../../shared/platform-source.js';
import { buildSearchTerms } from './search-terms.js';
import { EMBEDDING_COLUMN, toVectorLiteral, vectorSupport } from './vector-support.js';

/**
 * How far apart two vectors may be and still count as a match. Cosine
 * distance, so 0 is identical and 1 is unrelated; 0.45 keeps paraphrases and
 * cross-language restatements while dropping the merely topical.
 */
const MAX_SEMANTIC_DISTANCE = 0.45;

/**
 * Weight of the semantic score against the keyword score. The keyword side
 * contributes up to ~2 (ts_rank plus the share of terms found literally), so
 * 1.0 lets semantics break ties and surface a no-term-in-common hit without
 * letting it outrank an exact match.
 */
const SEMANTIC_WEIGHT = 1.0;

export type ObservationSourceType = 'agent_event' | 'session_summary' | 'observation_reindex' | 'manual';

export interface PostgresObservation {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  kind: string;
  content: string;
  generationKey: string | null;
  metadata: JsonObject;
  embedding: JsonValue | null;
  createdByJobId: string | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface PostgresObservationSource {
  id: string;
  observationId: string;
  agentEventId: string | null;
  generationJobId: string | null;
  sourceType: ObservationSourceType;
  sourceId: string;
  metadata: JsonObject;
  createdAtEpoch: number;
}

interface ObservationRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  kind: string;
  content: string;
  generation_key: string | null;
  metadata: unknown;
  embedding: unknown | null;
  created_by_job_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ObservationSourceRow {
  id: string;
  observation_id: string;
  agent_event_id: string | null;
  generation_job_id: string | null;
  source_type: ObservationSourceType;
  source_id: string;
  metadata: unknown;
  created_at: Date;
}

export class PostgresObservationRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    kind?: string;
    content: string;
    generationKey?: string | null;
    metadata?: JsonObject;
    embedding?: JsonValue | null;
    createdByJobId?: string | null;
  }): Promise<PostgresObservation> {
    await assertProjectOwnership(this.client, input.projectId, input.teamId);
    if (input.serverSessionId) {
      await assertSessionOwnership(this.client, input.serverSessionId, input.projectId, input.teamId);
    }
    if (input.createdByJobId) {
      await assertJobOwnership(this.client, input.createdByJobId, input.projectId, input.teamId);
    }

    const row = await queryOne<ObservationRow>(
      this.client,
      `
        INSERT INTO observations (
          id, project_id, team_id, server_session_id, kind, content,
          generation_key, metadata, embedding, created_by_job_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
        ON CONFLICT (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL DO UPDATE SET
          updated_at = observations.updated_at
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.projectId,
        input.teamId,
        input.serverSessionId ?? null,
        input.kind ?? 'observation',
        input.content,
        input.generationKey ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.embedding == null ? null : JSON.stringify(input.embedding),
        input.createdByJobId ?? null
      ]
    );
    return mapObservationRow(row!);
  }

  async getByIdForScope(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservation | null> {
    const row = await queryOne<ObservationRow>(
      this.client,
      'SELECT * FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    return row ? mapObservationRow(row) : null;
  }

  async listByProject(input: {
    projectId: string;
    teamId: string;
    serverSessionId?: string | null;
    limit?: number;
  }): Promise<PostgresObservation[]> {
    const result = await this.client.query<ObservationRow>(
      `
        SELECT * FROM observations
        WHERE project_id = $1
          AND team_id = $2
          AND ($3::text IS NULL OR server_session_id = $3)
        ORDER BY created_at DESC
        LIMIT $4
      `,
      [input.projectId, input.teamId, input.serverSessionId ?? null, input.limit ?? 100]
    );
    return result.rows.map(mapObservationRow);
  }

  /**
   * Rows whose embedding has not been computed yet, oldest first.
   *
   * Oldest first so a backlog drains in the order it accumulated; newest
   * first would leave the tail permanently unembedded whenever the backlog
   * grows faster than a tick can clear it.
   */
  async listMissingEmbeddings(input: { limit: number }): Promise<Array<{ id: string; content: string }>> {
    const result = await this.client.query<{ id: string; content: string }>(
      `
        SELECT id, content FROM observations
        WHERE ${EMBEDDING_COLUMN} IS NULL
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [input.limit]
    );
    return result.rows;
  }

  /**
   * Store a batch of vectors in one statement.
   *
   * Per-row updates would be one round trip each; at a few hundred rows of
   * backlog that dominates the tick.
   */
  async setEmbeddings(entries: ReadonlyArray<{ id: string; vector: readonly number[] }>): Promise<number> {
    if (entries.length === 0) return 0;
    const result = await this.client.query(
      `
        UPDATE observations AS o
        SET ${EMBEDDING_COLUMN} = data.vec::vector,
            updated_at = o.updated_at
        FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS vec) AS data
        WHERE o.id = data.id
      `,
      [entries.map(e => e.id), entries.map(e => toVectorLiteral(e.vector))]
    );
    return result.rowCount ?? 0;
  }

  async search(input: {
    projectId: string;
    teamId: string;
    query: string;
    limit?: number;
    platformSource?: string | null;
    /**
     * The query embedded with the same model as the stored vectors. When
     * given, semantically close observations are returned even with no term
     * in common; without it the search is keyword-only, exactly as before.
     */
    queryEmbedding?: readonly number[] | null;
  }): Promise<PostgresObservation[]> {
    const platformSource = normalizePlatformSourceOrNull(input.platformSource);
    const params: unknown[] = [
      input.projectId,
      input.teamId,
      input.query,
      input.limit ?? 20,
      platformSource,
      buildSearchTerms(input.query),
    ];

    // Only reference the `vector` type when the extension actually exists —
    // on a plain Postgres the cast itself is a syntax-level failure, not an
    // empty result.
    const semantic = vectorSupport() === true
      && Array.isArray(input.queryEmbedding)
      && input.queryEmbedding.length > 0;
    let semanticMatch = '';
    let semanticRank = '';
    if (semantic) {
      params.push(toVectorLiteral(input.queryEmbedding as readonly number[]));
      semanticMatch = `
            OR (
              observations.${EMBEDDING_COLUMN} IS NOT NULL
              AND observations.${EMBEDDING_COLUMN} <=> $7::vector < ${MAX_SEMANTIC_DISTANCE}
            )`;
      semanticRank = `
            + COALESCE(
                GREATEST(0, 1 - (observations.${EMBEDDING_COLUMN} <=> $7::vector)) * ${SEMANTIC_WEIGHT},
                0
              )`;
    }

    const result = await this.client.query<ObservationRow>(
      `
        -- Columns are listed one by one, not observations.*, so the 768-float
        -- embedding never crosses the wire: nothing downstream reads it, and
        -- at 20 rows a search it would dominate the response.
        SELECT
          observations.id,
          observations.project_id,
          observations.team_id,
          observations.server_session_id,
          observations.kind,
          observations.content,
          observations.generation_key,
          observations.metadata,
          observations.embedding,
          observations.created_by_job_id,
          observations.created_at,
          observations.updated_at
        FROM observations
        LEFT JOIN server_sessions
          ON server_sessions.id = observations.server_session_id
          AND server_sessions.project_id = observations.project_id
          AND server_sessions.team_id = observations.team_id
        WHERE observations.project_id = $1
          AND observations.team_id = $2
          AND (
            observations.content_search @@ websearch_to_tsquery('english', $3)
            -- Full-text runs an English configuration, which leaves Korean
            -- particles attached and so never matches a differently-inflected
            -- stored form. Substring matching on the extracted terms covers
            -- that; it widens the result set and never narrows it.
            OR EXISTS (
              SELECT 1 FROM unnest($6::text[]) AS term
              WHERE observations.content ILIKE '%' || term || '%'
            )${semanticMatch}
          )
          AND (
            $5::text IS NULL
            OR server_sessions.platform_source = $5
            OR (
              observations.server_session_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM observation_sources
                INNER JOIN agent_events
                  ON agent_events.id = observation_sources.agent_event_id
                  AND agent_events.project_id = observations.project_id
                  AND agent_events.team_id = observations.team_id
                WHERE observation_sources.observation_id = observations.id
                  AND observation_sources.source_type = 'agent_event'
                  AND agent_events.platform_source = $5
              )
            )
          )
        ORDER BY
          -- Rank on both signals: the full-text score, plus the share of
          -- query terms that appear literally. Neither alone orders a mixed
          -- Korean/English corpus sensibly.
          ts_rank(observations.content_search, websearch_to_tsquery('english', $3))
            + COALESCE((
                SELECT count(*)::float
                FROM unnest($6::text[]) AS term
                WHERE observations.content ILIKE '%' || term || '%'
              ) / NULLIF(array_length($6::text[], 1), 0), 0)${semanticRank}
            DESC,
          observations.updated_at DESC
        LIMIT $4
      `,
      params
    );
    return result.rows.map(mapObservationRow);
  }
}

export class PostgresObservationSourcesRepository {
  constructor(private client: PostgresQueryable) {}

  async addSource(input: {
    id?: string;
    observationId: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationSourceType;
    sourceId: string;
    agentEventId?: string | null;
    generationJobId?: string | null;
    metadata?: JsonObject;
  }): Promise<PostgresObservationSource> {
    const observation = await queryOne<{ id: string }>(
      this.client,
      'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.observationId, input.projectId, input.teamId]
    );
    if (!observation) {
      throw new Error('observation_id does not exist');
    }

    const agentEventId = input.sourceType === 'agent_event'
      ? input.agentEventId ?? input.sourceId
      : null;

    if (input.sourceType === 'agent_event') {
      if (agentEventId !== input.sourceId) {
        throw new Error('agent_event source_id must equal agent_event_id');
      }
      await assertAgentEventOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    } else if (input.sourceType === 'session_summary' && !input.generationJobId) {
      await assertSessionOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    } else if (input.sourceType === 'observation_reindex' && !input.generationJobId) {
      await assertObservationOwnership(this.client, input.sourceId, input.projectId, input.teamId);
    }
    if (input.generationJobId) {
      await assertGenerationJobMatchesSource(this.client, {
        generationJobId: input.generationJobId,
        projectId: input.projectId,
        teamId: input.teamId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        agentEventId
      });
    }

    const row = await queryOne<ObservationSourceRow>(
      this.client,
      `
        INSERT INTO observation_sources (
          id, observation_id, agent_event_id, generation_job_id,
          source_type, source_id, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (observation_id, source_type, source_id) DO UPDATE SET
          metadata = observation_sources.metadata || excluded.metadata
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.observationId,
        agentEventId,
        input.generationJobId ?? null,
        input.sourceType,
        input.sourceId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return mapObservationSourceRow(row!);
  }

  async listByObservationForScope(input: {
    observationId: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservationSource[]> {
    const result = await this.client.query<ObservationSourceRow>(
      `
        SELECT observation_sources.*
        FROM observation_sources
        INNER JOIN observations
          ON observations.id = observation_sources.observation_id
        WHERE observation_sources.observation_id = $1
          AND observations.project_id = $2
          AND observations.team_id = $3
        ORDER BY observation_sources.created_at ASC
      `,
      [input.observationId, input.projectId, input.teamId]
    );
    return result.rows.map(mapObservationSourceRow);
  }
}

export function buildObservationGenerationKey(input: {
  generationJobId: string;
  parsedObservationIndex: number;
  content: string;
}): string {
  return `generation:v1:${input.generationJobId}:${input.parsedObservationIndex}:${deterministicKey([
    canonicalJson(input.content.trim())
  ])}`;
}

async function assertJobOwnership(
  client: PostgresQueryable,
  generationJobId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM observation_generation_jobs WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [generationJobId, projectId, teamId]
  );
  if (!row) {
    throw new Error('generation_job_id must belong to project_id and team_id');
  }
}

async function assertGenerationJobMatchesSource(
  client: PostgresQueryable,
  input: {
    generationJobId: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationSourceType;
    sourceId: string;
    agentEventId: string | null;
  }
): Promise<void> {
  if (input.sourceType === 'manual') {
    throw new Error('manual observation sources cannot be linked to a generation_job_id');
  }

  const row = await queryOne<{
    id: string;
    source_type: string;
    source_id: string;
    agent_event_id: string | null;
  }>(
    client,
    `
      SELECT id, source_type, source_id, agent_event_id
      FROM observation_generation_jobs
      WHERE id = $1 AND project_id = $2 AND team_id = $3
    `,
    [input.generationJobId, input.projectId, input.teamId]
  );
  if (!row) {
    throw new Error('generation_job_id must belong to project_id and team_id');
  }
  if (row.source_type !== input.sourceType || row.source_id !== input.sourceId) {
    throw new Error('generation_job_id source model must match observation source');
  }
  if (input.sourceType === 'agent_event' && row.agent_event_id !== input.agentEventId) {
    throw new Error('generation_job_id agent_event_id must match observation source');
  }
}

async function assertAgentEventOwnership(
  client: PostgresQueryable,
  agentEventId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM agent_events WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [agentEventId, projectId, teamId]
  );
  if (!row) {
    throw new Error('agent_event_id must belong to project_id and team_id');
  }
}

async function assertObservationOwnership(
  client: PostgresQueryable,
  observationId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [observationId, projectId, teamId]
  );
  if (!row) {
    throw new Error('observation_reindex source_id must belong to project_id and team_id');
  }
}

function mapObservationRow(row: ObservationRow): PostgresObservation {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    kind: row.kind,
    content: row.content,
    generationKey: row.generation_key,
    metadata: toJsonObject(row.metadata),
    embedding: row.embedding,
    createdByJobId: row.created_by_job_id,
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}

function mapObservationSourceRow(row: ObservationSourceRow): PostgresObservationSource {
  return {
    id: row.id,
    observationId: row.observation_id,
    agentEventId: row.agent_event_id,
    generationJobId: row.generation_job_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at)
  };
}
