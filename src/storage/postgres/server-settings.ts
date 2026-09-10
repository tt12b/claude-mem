// SPDX-License-Identifier: Apache-2.0
//
// Operator-set runtime knobs.
//
// The HTTP server and the generation worker are separate containers, so a
// setting changed from the dashboard cannot be delivered through the
// environment — the worker would need a restart to see it. Postgres is the
// one thing both already share, so a change takes effect on the next job.
//
// Deliberately tiny: `key` → arbitrary JSON. Anything that needs structure or
// history belongs in a table of its own.

import type { PostgresQueryable } from './utils.js';

/** Model the operator picked in the dashboard; overrides the env order. */
export const PREFERRED_MODEL_KEY = 'generation.preferred_model';

export class PostgresServerSettingsRepository {
  constructor(private readonly client: PostgresQueryable) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const result = await this.client.query<{ value: T }>(
      'SELECT value FROM server_settings WHERE key = $1',
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.client.query(
      `INSERT INTO server_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.query('DELETE FROM server_settings WHERE key = $1', [key]);
  }
}
