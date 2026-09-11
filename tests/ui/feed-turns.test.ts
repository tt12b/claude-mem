import { describe, expect, it } from 'bun:test';
import { groupIntoTurns, threadOf } from '../../src/ui/viewer/components/Feed.js';
import type { FeedItem } from '../../src/ui/viewer/types.js';

function prompt(id: number, at: number, session: string, project = 'p'): FeedItem {
  return {
    itemType: 'prompt', id, created_at_epoch: at, project,
    turn_session_id: session, content_session_id: session, prompt_text: `q${id}`,
  } as unknown as FeedItem;
}

function message(id: number, at: number, session: string, project = 'p'): FeedItem {
  return {
    itemType: 'message', id, created_at_epoch: at, project,
    turn_session_id: session, content_session_id: session, prompt_text: `a${id}`,
  } as unknown as FeedItem;
}

describe('feed turn grouping', () => {
  it('keeps two concurrent sessions apart', () => {
    // Interleaved in time: grouping on time alone attached B's answer to A's
    // question, so a question asked in one project looked answered by another.
    const turns = groupIntoTurns([
      prompt(1, 100, 'A', 'meditlink-api'),
      prompt(2, 110, 'B', 'claude-mem'),
      message(3, 120, 'B', 'claude-mem'),
      message(4, 130, 'A', 'meditlink-api'),
    ]);

    const byPrompt = new Map(turns.filter(t => t.prompt).map(t => [t.prompt!.id, t.items.map(i => i.id)]));
    expect(byPrompt.get(1)).toEqual([4]);
    expect(byPrompt.get(2)).toEqual([3]);
  });

  it('still attaches a reply to its own question in one session', () => {
    const turns = groupIntoTurns([
      prompt(1, 100, 'A'),
      message(2, 110, 'A'),
      prompt(3, 120, 'A'),
      message(4, 130, 'A'),
    ]);

    const byPrompt = new Map(turns.filter(t => t.prompt).map(t => [t.prompt!.id, t.items.map(i => i.id)]));
    expect(byPrompt.get(1)).toEqual([2]);
    expect(byPrompt.get(3)).toEqual([4]);
  });

  it('puts the newest conversation on top', () => {
    const turns = groupIntoTurns([prompt(1, 100, 'A'), prompt(2, 200, 'A')]);
    expect(turns[0].prompt?.id).toBe(2);
  });

  it('holds replies that arrived before any question, per session', () => {
    const turns = groupIntoTurns([message(1, 100, 'A'), message(2, 105, 'B')]);
    // One orphan group each, not one shared bucket.
    expect(turns.filter(t => t.prompt === null)).toHaveLength(2);
  });

  it('falls back to the project when a row carries no session id', () => {
    // Rows written before the server sent a session id must not all collapse
    // into a single thread.
    const older = { itemType: 'message', id: 9, created_at_epoch: 1, project: 'alpha' } as unknown as FeedItem;
    const other = { itemType: 'message', id: 10, created_at_epoch: 2, project: 'beta' } as unknown as FeedItem;
    expect(threadOf(older)).toBe('p:alpha');
    expect(threadOf(older)).not.toBe(threadOf(other));
  });

  it('prefers the session id over the project when both exist', () => {
    expect(threadOf(prompt(1, 1, 'S', 'proj'))).toBe('s:S');
  });
});
