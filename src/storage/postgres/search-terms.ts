// SPDX-License-Identifier: Apache-2.0
//
// Break a query into terms that can be matched as substrings.
//
// Postgres full-text search runs through an English configuration here, which
// stems English fine and does nothing useful for Korean: `를`, `가`, `에서`
// and friends stay glued to the noun, so "prefix를" and "prefix가" are two
// unrelated tokens and neither matches a stored "prefix". Substring matching
// sidesteps the tokenizer entirely, and trimming a trailing particle is what
// makes the two forms meet.
//
// This is a heuristic, not morphology. It is used to widen a search, never to
// narrow one — full-text results are still unioned in — so a wrong trim costs
// a slightly noisier result list rather than a missed hit.

/**
 * Particles trimmed from the end of a token. Longest first so `에서` wins
 * over `서`, and `이라고` over `고`.
 */
const KOREAN_PARTICLES = [
  '이라고', '라고', '에게서', '한테서', '에서', '에게', '한테', '으로', '까지', '부터',
  '처럼', '보다', '마다', '조차', '마저', '이나', '나마', '이며', '이고',
  '은', '는', '이', '가', '을', '를', '에', '의', '와', '과', '도', '만', '로', '고',
];

/** Below this a trimmed token is too generic to be worth matching. */
const MIN_TERM_LENGTH = 2;
/** Enough to characterise a prompt; more just slows the query down. */
const MAX_TERMS = 12;

function hasHangul(text: string): boolean {
  return /[가-힣]/.test(text);
}

/**
 * Drop one trailing particle, but only from a token long enough that what
 * remains is still a word. `가` on its own is a word; `prefix가` is not.
 */
function trimParticle(token: string): string {
  if (!hasHangul(token)) return token;
  for (const particle of KOREAN_PARTICLES) {
    if (token.length > particle.length + 1 && token.endsWith(particle)) {
      return token.slice(0, -particle.length);
    }
  }
  return token;
}

/**
 * Terms to substring-match, in query order and de-duplicated.
 *
 * Both the original token and its trimmed form are kept: the untrimmed one
 * matches text that carries the same particle, the trimmed one matches the
 * stem wherever it appears.
 */
export function buildSearchTerms(query: string): string[] {
  const tokens = query
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= MIN_TERM_LENGTH);

  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    for (const candidate of [token, trimParticle(token)]) {
      const key = candidate.toLowerCase();
      if (candidate.length < MIN_TERM_LENGTH || seen.has(key)) continue;
      seen.add(key);
      terms.push(candidate);
      if (terms.length >= MAX_TERMS) return terms;
    }
  }
  return terms;
}
