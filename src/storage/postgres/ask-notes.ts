// SPDX-License-Identifier: Apache-2.0
//
// Things the dashboard assistant was asked to remember.
//
// Separate from the briefing file on purpose. That file ships inside the
// image, so anything written to it at runtime disappears on the next
// deploy, and it holds the answering rules — a model that can edit its own
// rules can also delete them. Notes live here instead: persistent, listable,
// and deletable, with the rules staying under human control.

import { newId, type PostgresQueryable } from './utils.js';

export interface AskNote {
  id: string;
  content: string;
  createdAtEpoch: number;
}

/** Ceiling on a single note. A note is a fact, not a document. */
export const MAX_NOTE_CHARS = 500;

/**
 * Ceiling on how many notes ride along in every prompt. Each one costs
 * tokens on every question, so the list has to stay small enough to be free.
 */
export const MAX_NOTES = 50;

export class PostgresAskNotesRepository {
  constructor(private readonly client: PostgresQueryable) {}

  /** Oldest first — the prompt reads better in the order they were added. */
  async list(): Promise<AskNote[]> {
    const result = await this.client.query<{ id: string; content: string; created_at: Date }>(
      'SELECT id, content, created_at FROM ask_notes ORDER BY created_at ASC LIMIT $1',
      [MAX_NOTES],
    );
    return result.rows.map(row => ({
      id: row.id,
      content: row.content,
      createdAtEpoch: new Date(row.created_at).getTime(),
    }));
  }

  /**
   * Store a note, ignoring one that is already recorded.
   *
   * Re-asking for the same thing is normal in a chat, and a list with the
   * same fact five times just costs tokens on every later question.
   */
  async add(content: string): Promise<AskNote | null> {
    const trimmed = content.trim().slice(0, MAX_NOTE_CHARS);
    if (trimmed === '') return null;

    const existing = await this.client.query<{ id: string }>(
      'SELECT id FROM ask_notes WHERE content = $1',
      [trimmed],
    );
    if (existing.rows.length > 0) return null;

    const result = await this.client.query<{ id: string; content: string; created_at: Date }>(
      `INSERT INTO ask_notes (id, content) VALUES ($1, $2)
       RETURNING id, content, created_at`,
      [newId(), trimmed],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, content: row.content, createdAtEpoch: new Date(row.created_at).getTime() }
      : null;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.client.query('DELETE FROM ask_notes WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
