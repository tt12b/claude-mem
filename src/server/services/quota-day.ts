// SPDX-License-Identifier: Apache-2.0
//
// When a provider's daily request allowance starts over.
//
// Google resets request-per-day quotas at midnight Pacific
// (https://ai.google.dev/gemini-api/docs/rate-limits), so "used today" has to
// be counted from that boundary — a rolling 24h window would keep charging
// for calls the provider has already forgiven.
//
// Two callers need the same answer and must not disagree: the dashboard,
// which shows how much of the day's allowance is left, and the retry
// scheduler, which parks a quota-exhausted job until the allowance actually
// returns. Keeping the boundary in one place is what makes the panel's
// countdown and the job's wake-up time the same instant.
//
// Derived through Intl rather than a fixed offset so the DST switch is
// handled without a timezone library.

const QUOTA_TIMEZONE = process.env.CLAUDE_MEM_QUOTA_TIMEZONE ?? 'America/Los_Angeles';

export function msSinceLocalMidnight(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: QUOTA_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? '0');
  // en-GB renders midnight as 24 in some runtimes; normalise it to 0.
  const hour = get('hour') % 24;
  return ((hour * 60 + get('minute')) * 60 + get('second')) * 1000 + at.getMilliseconds();
}

/** Start of the current quota day, as an instant. */
export function quotaDayStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - msSinceLocalMidnight(now));
}

/** The next reset boundary. Stepping 36h forward lands safely inside the
 *  following local day even when that day is 23 or 25 hours long. */
export function nextQuotaReset(now: Date = new Date()): Date {
  const probe = new Date(quotaDayStart(now).getTime() + 36 * 60 * 60 * 1000);
  return quotaDayStart(probe);
}

export { QUOTA_TIMEZONE };
