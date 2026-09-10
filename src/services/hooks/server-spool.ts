// SPDX-License-Identifier: Apache-2.0
//
// Hold events the server could not accept, and replay them once it is back.
//
// When a server call fails the hook falls back to the local worker so nothing
// is lost on the machine — but nothing carried those events over to the
// server afterwards either, so an outage permanently split the record: the
// conversation from that window lived only in the local SQLite file while
// everything before and after it lived in Postgres.
//
// This is a plain append-only JSONL file rather than a table. The hook is a
// short-lived process spawned per tool call, so the store has to be usable
// with no connection, no migration, and no daemon — and has to survive the
// process exiting mid-write.
//
// Replay is safe to repeat: the server derives `idempotency_key` from the
// event's own content (buildAgentEventIdempotencyKey), so a duplicate
// delivery collapses onto the existing row.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../../utils/logger.js';
import type { ServerClient, ServerRecordEventRequest } from './server-client.js';

/** Events replayed per drain. Bounded so a hook invocation stays quick. */
const MAX_REPLAY_PER_DRAIN = 25;

/**
 * Ceiling on the spool. An outage that outlasts this drops the oldest
 * entries — an unbounded file on the user's disk is the worse failure, and
 * the local worker still holds its own copy of everything.
 */
const MAX_SPOOL_BYTES = 8 * 1024 * 1024;

interface SpoolEntry {
  /** Schema marker so a future change can migrate or discard old lines. */
  v: 1;
  spooledAtEpoch: number;
  event: ServerRecordEventRequest;
}

function spoolPath(dataDir: string): string {
  return join(dataDir, 'server-outbox.jsonl');
}

/**
 * Record an event the server refused or never answered.
 *
 * Best-effort by design: this runs on a path that has already failed once,
 * and a spool problem must not turn a degraded hook into a broken one.
 */
export function spoolServerEvent(dataDir: string, event: ServerRecordEventRequest): void {
  try {
    const path = spoolPath(dataDir);
    mkdirSync(dirname(path), { recursive: true });

    if (existsSync(path) && statSync(path).size > MAX_SPOOL_BYTES) {
      // Keep the newest half. Losing the oldest beats growing without limit.
      const kept = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      writeFileSync(path, kept.slice(Math.floor(kept.length / 2)).join('\n') + '\n', 'utf8');
      logger.warn('HOOK', 'server outbox exceeded its ceiling; dropped the oldest half', {
        remaining: Math.ceil(kept.length / 2),
      });
    }

    const entry: SpoolEntry = { v: 1, spooledAtEpoch: Date.now(), event };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error: unknown) {
    logger.debug('HOOK', 'could not spool event for later replay', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function spoolDepth(dataDir: string): number {
  try {
    const path = spoolPath(dataDir);
    if (!existsSync(path)) return 0;
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Send what is waiting, oldest first, and put back anything still unsent.
 *
 * Call this only after a server request has just succeeded — that success is
 * the evidence the server is reachable, and it avoids paying a timeout on
 * every hook while the outage is ongoing.
 *
 * The file is claimed by rename so two concurrent hooks cannot replay the
 * same entries; whoever loses the race simply finds nothing to do.
 */
export async function drainServerSpool(
  dataDir: string,
  client: Pick<ServerClient, 'recordEvent'>,
): Promise<{ replayed: number; remaining: number }> {
  const path = spoolPath(dataDir);
  if (!existsSync(path)) return { replayed: 0, remaining: 0 };

  const claim = `${path}.claim.${process.pid}`;
  try {
    renameSync(path, claim);
  } catch {
    // Another hook got there first, or the file vanished.
    return { replayed: 0, remaining: 0 };
  }

  let entries: SpoolEntry[] = [];
  try {
    entries = readFileSync(claim, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as SpoolEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is SpoolEntry => entry !== null && entry.v === 1);
  } catch {
    entries = [];
  }

  const batch = entries.slice(0, MAX_REPLAY_PER_DRAIN);
  let replayed = 0;

  for (const entry of batch) {
    try {
      await client.recordEvent(entry.event);
      replayed++;
    } catch (error: unknown) {
      // The server went away again mid-drain. Stop here: everything from
      // this entry on stays queued, still in order.
      logger.debug('HOOK', 'replay interrupted; leaving the rest queued', {
        replayed,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  const leftover = entries.slice(replayed);
  try {
    if (leftover.length > 0) {
      // Anything spooled while we held the claim goes after the leftovers so
      // the queue stays in chronological order.
      const arrivedDuringDrain = existsSync(path) ? readFileSync(path, 'utf8') : '';
      writeFileSync(
        path,
        leftover.map(entry => JSON.stringify(entry)).join('\n') + '\n' + arrivedDuringDrain,
        'utf8',
      );
    }
    unlinkSync(claim);
  } catch (error: unknown) {
    logger.warn('HOOK', 'failed to restore the server outbox after replay', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (replayed > 0) {
    logger.info('HOOK', 'replayed events buffered during a server outage', {
      replayed,
      remaining: leftover.length,
    });
  }
  return { replayed, remaining: leftover.length };
}
