import { describe, expect, it } from 'bun:test';
import { buildSearchTerms } from '../../../src/storage/postgres/search-terms.js';

describe('buildSearchTerms', () => {
  it('keeps both the inflected token and its stem so either form matches', () => {
    // The stored text says "prefix" — a query saying "prefix를" has to reach it.
    const terms = buildSearchTerms('prefix를 고쳤다');
    expect(terms).toContain('prefix를');
    expect(terms).toContain('prefix');
  });

  it('matches across different particles on the same stem', () => {
    const asked = buildSearchTerms('큐 prefix가 문제였나');
    const stored = buildSearchTerms('큐 prefix를 수정');
    // Neither full form appears in the other, but the shared stem does.
    expect(asked).toContain('prefix');
    expect(stored).toContain('prefix');
  });

  it('trims the longest matching particle, not the shortest', () => {
    // `에서` must win over `서`, otherwise the stem keeps a stray character.
    expect(buildSearchTerms('서버에서')).toContain('서버');
  });

  it('leaves a short word alone when it is itself a particle', () => {
    // Trimming here would leave nothing meaningful behind.
    const terms = buildSearchTerms('가 나');
    expect(terms).not.toContain('');
  });

  it('does not touch tokens without hangul', () => {
    const terms = buildSearchTerms('docker compose down');
    expect(terms).toEqual(['docker', 'compose', 'down']);
  });

  it('splits on punctuation but keeps identifier characters', () => {
    const terms = buildSearchTerms('CLAUDE_MEM_SERVER_MODEL, gemini-3.5-flash-lite');
    expect(terms).toContain('CLAUDE_MEM_SERVER_MODEL');
    expect(terms).toContain('gemini-3.5-flash-lite');
  });

  it('drops one-character noise', () => {
    expect(buildSearchTerms('a b 큐')).toEqual([]);
  });

  it('de-duplicates so a repeated word does not skew ranking', () => {
    const terms = buildSearchTerms('prefix prefix prefix를');
    expect(terms.filter(term => term === 'prefix')).toHaveLength(1);
  });

  it('caps the term count so a long prompt cannot bloat the query', () => {
    const long = Array.from({ length: 40 }, (_, i) => `token${i}`).join(' ');
    expect(buildSearchTerms(long).length).toBeLessThanOrEqual(12);
  });

  it('returns nothing for an empty query rather than a wildcard term', () => {
    expect(buildSearchTerms('   ')).toEqual([]);
  });
});
