// SPDX-License-Identifier: Apache-2.0

// Server-beta-local copy of the worker provider error classification model.
// Phase 5 anti-pattern guard: src/server/* must not import from
// src/services/worker/*, so we duplicate the small, stable error model here.
// Worker code keeps src/services/worker/provider-errors.ts unchanged.

export type ServerProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'parse_error'
  | (string & {});

export class ServerClassifiedProviderError extends Error {
  readonly kind: ServerProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly cause: unknown;

  constructor(
    message: string,
    opts: {
      kind: ServerProviderErrorClass;
      cause: unknown;
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = 'ServerClassifiedProviderError';
    this.kind = opts.kind;
    this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
  }
}

/**
 * Parse Retry-After header (seconds or HTTP-date). Returns ms or undefined.
 * Behavior intentionally mirrors the worker providers' helper so server
 * retries match worker retry policy.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

interface ClassifyHttpInput {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  providerLabel: string;
}

/**
 * Generic HTTP-error → ServerClassifiedProviderError mapping shared by
 * Gemini and OpenRouter server adapters. Provider-specific overrides (e.g.
 * Anthropic OverloadedError, Gemini quota body markers) are layered on top
 * by the per-provider classifier wrappers in this module.
 */
/**
 * Pull `limit: <n>` and `model: <id>` out of a provider quota message.
 * Returns null when the body carries neither, so a provider that does not
 * report its ceiling simply adds nothing to the message.
 */
export function extractQuotaDetail(body: string): string | null {
  if (!body) return null;
  const limit = /\blimit:\s*([0-9]+)/i.exec(body)?.[1] ?? null;
  const model = /\bmodel:\s*([A-Za-z0-9._-]+)/i.exec(body)?.[1] ?? null;
  const parts: string[] = [];
  if (limit) parts.push(`limit=${limit}`);
  if (model) parts.push(`model=${model}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function classifyHttpProviderError(input: ClassifyHttpInput): ServerClassifiedProviderError {
  const { status, providerLabel } = input;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const retryAfterMs = input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined;
  const cause = status === undefined
    ? input.cause
    : new Error(`${providerLabel} HTTP error (status ${status})`);

  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota') ||
    lower.includes('resource_exhausted') ||
    lower.includes('key limit exceeded') ||
    // "Rate limit exceeded" on a 429 is a rate limit, not quota — the generic
    // marker only applies off the 429 path (the key-limit marker always wins).
    (lower.includes('limit exceeded') && status !== 429) ||
    lower.includes('negative credit') ||
    status === 402
  ) {
    // Google reports the ceiling it enforced right in the 429 body
    // ("limit: 20, model: gemini-3.8-flash"). There is no quota-remaining
    // API for an AI Studio key, so this is the only place the number is
    // ever visible — carry it in the message so the failure row keeps it and
    // the dashboard can show headroom instead of guessing.
    const quotaDetail = extractQuotaDetail(body);
    return new ServerClassifiedProviderError(
      `${providerLabel} quota exhausted${status !== undefined ? ` (status ${status})` : ''}`
        + (quotaDetail ? ` [${quotaDetail}]` : ''),
      { kind: 'quota_exhausted', cause },
    );
  }

  if (status === 429) {
    return new ServerClassifiedProviderError(`${providerLabel} rate limit (429)`, {
      kind: 'rate_limit',
      cause,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  if (status === 401 || status === 403) {
    return new ServerClassifiedProviderError(`${providerLabel} auth error (status ${status})`, {
      kind: 'auth_invalid',
      cause,
    });
  }

  if (status === 400 || status === 404) {
    return new ServerClassifiedProviderError(`${providerLabel} bad request (status ${status})`, {
      kind: 'unrecoverable',
      cause,
    });
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ServerClassifiedProviderError(`${providerLabel} upstream error (status ${status})`, {
      kind: 'transient',
      cause,
    });
  }

  if (status === undefined) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    return new ServerClassifiedProviderError(`${providerLabel} network error: ${message}`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  return new ServerClassifiedProviderError(
    `${providerLabel} API error (status ${status})`,
    { kind: 'unrecoverable', cause },
  );
}
