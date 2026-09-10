import { describe, expect, it } from 'bun:test';
import { nextQuotaReset, quotaDayStart } from '../../src/server/services/quota-day.js';

describe('quota day boundary', () => {
  it('places the next reset strictly after now', () => {
    const now = new Date();
    expect(nextQuotaReset(now).getTime()).toBeGreaterThan(now.getTime());
  });

  it('lands the reset within a day and a bit, never a fixed 24h from now', () => {
    // The boundary is a wall-clock instant in Pacific time, so the distance
    // from an arbitrary "now" is anywhere from a moment to a full day.
    const now = new Date('2026-09-10T09:22:34.000Z');
    const gap = nextQuotaReset(now).getTime() - now.getTime();
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
  });

  it('treats every instant within one Pacific day as the same day start', () => {
    // 08:00 and 20:00 UTC on the same date are both after Pacific midnight
    // and before the next one, so the allowance they draw from is the same.
    const morning = quotaDayStart(new Date('2026-09-10T08:00:00.000Z'));
    const evening = quotaDayStart(new Date('2026-09-10T20:00:00.000Z'));
    expect(morning.getTime()).toBe(evening.getTime());
  });

  it('rolls the day start forward once the boundary is crossed', () => {
    const before = quotaDayStart(new Date('2026-09-10T06:00:00.000Z'));
    const after = quotaDayStart(new Date('2026-09-11T06:00:00.000Z'));
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('makes the reset the day start of the following day', () => {
    const now = new Date('2026-09-10T09:22:34.000Z');
    // Anything else would mean the panel counts down to one instant while a
    // parked job wakes at another.
    expect(nextQuotaReset(now).getTime())
      .toBe(quotaDayStart(new Date(now.getTime() + 25 * 60 * 60 * 1000)).getTime());
  });
});
