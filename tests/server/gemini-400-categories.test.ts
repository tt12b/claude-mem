import { describe, expect, it } from 'bun:test';
import { categorizeGeminiBadRequest } from '../../src/server/generation/providers/GeminiObservationProvider.js';

describe('categorizeGeminiBadRequest — added categories', () => {
  // A 400 is terminal: the job is never retried, so the category is the
  // only account of what was lost. The body itself is deliberately not
  // recorded — it can echo the prompt back, and `last_error` is served by
  // an unauthenticated dashboard route.
  it('names a safety refusal', () => {
    expect(categorizeGeminiBadRequest('{"error":{"message":"PROHIBITED_CONTENT"}}'))
      .toBe('safety_blocked');
  });

  it('names an unsupported region', () => {
    expect(categorizeGeminiBadRequest('User location is not supported for the API use'))
      .toBe('location_unsupported');
  });

  it('names an empty request', () => {
    expect(categorizeGeminiBadRequest('contents is not specified')).toBe('empty_content');
  });

  it('names a malformed request', () => {
    expect(categorizeGeminiBadRequest('Invalid JSON payload received. Unknown name "foo"'))
      .toBe('invalid_argument');
  });

  it('prefers the role diagnosis when the body names the turn roles', () => {
    expect(categorizeGeminiBadRequest('Invalid value at contents[0].role: expected user or model'))
      .toBe('role_sequence');
  });

  it('settles for the generic diagnosis when it cannot tell more', () => {
    // No mention of a turn role, so "the request shape was wrong" is the
    // most that can honestly be said — still better than 'unknown'.
    expect(categorizeGeminiBadRequest('Invalid value at generation_config.top_k'))
      .toBe('invalid_argument');
  });

  it('keeps the existing categories intact', () => {
    expect(categorizeGeminiBadRequest('API key not valid')).toBe('api_key');
    expect(categorizeGeminiBadRequest('input is too long')).toBe('context_limit');
    expect(categorizeGeminiBadRequest('model not found')).toBe('model_unsupported');
  });

  it('still falls back when nothing matches', () => {
    expect(categorizeGeminiBadRequest('something entirely new')).toBe('unknown_bad_request');
  });
});
