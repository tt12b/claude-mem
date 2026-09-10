import { describe, expect, it } from 'bun:test';
import { QueuedJobReconciler, type QueueLike } from '../../src/server/services/QueuedJobReconciler.js';

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    project_id: 'project-1',
    team_id: 'team-1',
    agent_event_id: null,
    source_type: 'session_summary',
    source_id: 'session-1',
    server_session_id: 'session-1',
    job_type: 'observation_generate_session_summary',
    status: 'queued',
    idempotency_key: 'idem-1',
    bullmq_job_id: 'sum_abc',
    attempts: 1,
    max_attempts: 3,
    next_attempt_at: null,
    locked_at: null,
    locked_by: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_error: null,
    payload: { kind: 'summary' },
    created_at: new Date('2026-09-10T00:00:00.000Z'),
    updated_at: new Date('2026-09-10T00:00:00.000Z'),
    ...overrides,
  };
}

function fakePool(rows: unknown[]) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    pool: {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
      },
    } as never,
  };
}

class RecordingQueue implements QueueLike {
  readonly added: Array<{ id: string; payload: unknown }> = [];
  readonly removed: string[] = [];

  async add(jobId: string, payload: unknown): Promise<unknown> {
    this.added.push({ id: jobId, payload });
    return undefined;
  }

  async remove(jobId: string): Promise<void> {
    this.removed.push(jobId);
  }
}

describe('QueuedJobReconciler', () => {
  it('republishes a due job under its existing BullMQ id', async () => {
    const queue = new RecordingQueue();
    const { pool } = fakePool([jobRow()]);

    const result = await new QueuedJobReconciler({ pool, resolveQueue: () => queue }).tick();

    expect(result).toEqual({ due: 1, republished: 1 });
    // Clearing the old slot first is what lets a terminal BullMQ entry be
    // replaced instead of silently swallowing the add.
    expect(queue.removed).toEqual(['sum_abc']);
    expect(queue.added).toEqual([{ id: 'sum_abc', payload: { kind: 'summary' } }]);
  });

  it('only asks for queued, unlocked jobs whose next attempt is due', async () => {
    const { calls, pool } = fakePool([]);

    await new QueuedJobReconciler({ pool, resolveQueue: () => new RecordingQueue() }).tick();

    const [call] = calls;
    expect(call.text).toContain("status = 'queued'");
    expect(call.text).toContain('locked_at IS NULL');
    expect(call.text).toContain('next_attempt_at IS NULL OR next_attempt_at <= now()');
  });

  it('routes a summary job and an event job to different lanes', async () => {
    const seen: string[] = [];
    const { pool } = fakePool([
      jobRow({ id: 'job-1', source_type: 'session_summary', bullmq_job_id: 'sum_a' }),
      jobRow({ id: 'job-2', source_type: 'agent_event', bullmq_job_id: 'evt_b' }),
    ]);

    await new QueuedJobReconciler({
      pool,
      resolveQueue: (sourceType) => { seen.push(sourceType); return new RecordingQueue(); },
    }).tick();

    expect(seen).toEqual(['session_summary', 'agent_event']);
  });

  it('skips a job with no BullMQ id rather than inventing one', async () => {
    const queue = new RecordingQueue();
    const { pool } = fakePool([jobRow({ bullmq_job_id: null })]);

    const result = await new QueuedJobReconciler({ pool, resolveQueue: () => queue }).tick();

    // A made-up id would defeat the deduplication the id exists to provide.
    expect(result).toEqual({ due: 1, republished: 0 });
    expect(queue.added).toHaveLength(0);
  });

  it('reports nothing republished when the queue is unavailable', async () => {
    const { pool } = fakePool([jobRow()]);

    const result = await new QueuedJobReconciler({ pool, resolveQueue: () => null }).tick();

    expect(result).toEqual({ due: 1, republished: 0 });
  });

  it('keeps going after one job fails to publish', async () => {
    const good = new RecordingQueue();
    const bad: QueueLike = {
      async add() { throw new Error('queue is down'); },
      async remove() { /* nothing to clear */ },
    };
    const { pool } = fakePool([
      jobRow({ id: 'job-1', source_type: 'agent_event', bullmq_job_id: 'evt_a' }),
      jobRow({ id: 'job-2', source_type: 'session_summary', bullmq_job_id: 'sum_b' }),
    ]);

    const result = await new QueuedJobReconciler({
      pool,
      resolveQueue: sourceType => (sourceType === 'agent_event' ? bad : good),
    }).tick();

    expect(result).toEqual({ due: 2, republished: 1 });
    expect(good.added).toHaveLength(1);
  });

  it('does no work when nothing is due', async () => {
    const queue = new RecordingQueue();
    const { pool } = fakePool([]);

    expect(await new QueuedJobReconciler({ pool, resolveQueue: () => queue }).tick())
      .toEqual({ due: 0, republished: 0 });
    expect(queue.added).toHaveLength(0);
  });
});
