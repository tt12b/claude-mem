import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The viewer's whole stylesheet is one inline <style> block, and nothing
 * validates it: a malformed rule costs no build error, no console warning,
 * and no failing test — the page just renders wrong.
 *
 * It already happened. Removing the upstream promo CTA left its comment
 * unterminated, and the missing star swallowed 326 lines — the card, feed
 * and select rules among them — so the dashboard shipped with unstyled
 * full-bleed cards and a native OS dropdown.
 */

const template = readFileSync(
  join(import.meta.dir, '../../src/ui/viewer-template.html'),
  'utf8',
);

function stylesheet(): string {
  const match = /<style>([\s\S]*?)<\/style>/.exec(template);
  expect(match).not.toBeNull();
  return match![1];
}

/** The stylesheet with comments removed, i.e. what the browser acts on. */
function effectiveCss(): string {
  return stylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('viewer stylesheet', () => {
  it('closes every comment it opens', () => {
    const css = stylesheet();
    // An unterminated /* runs to the next */, silently commenting out every
    // rule in between. Counting is enough: CSS has no nested comments.
    expect(css.split('/*').length - 1).toBe(css.split('*/').length - 1);
  });

  it('balances its braces', () => {
    const css = effectiveCss();
    expect(css.split('{').length - 1).toBe(css.split('}').length - 1);
  });

  it('keeps the layout rules out of any comment', () => {
    const css = effectiveCss();
    // The rules that decide whether the dashboard looks like a dashboard.
    // Each was inside the unterminated comment when this broke.
    for (const selector of [
      '.feed {',
      '.feed-content {',
      '.card {',
      '.card-header {',
      '.card-header-left {',
      '.card-type {',
      '.card-meta {',
      '.status select {',
    ]) {
      expect(css).toContain(selector);
    }
  });

  it('leaves no selector without a declaration block', () => {
    // A selector list ending in a comma absorbs whichever rule follows it,
    // which is how deleting a rule's last selector goes unnoticed: the
    // survivors quietly inherit the next rule's declarations.
    const orphans: string[] = [];
    const lines = effectiveCss().split('\n');
    // Only lines in selector position can be selectors. A multi-line value
    // (`linear-gradient(to bottom,`) also ends in a comma, so track whether
    // we are inside a declaration block rather than pattern-matching text.
    const stack: Array<'rule' | 'at'> = [];
    let pending = '';

    for (const raw of lines) {
      const line = raw.trim();
      const inDeclarations = stack.includes('rule');

      if (!inDeclarations && line.endsWith(',')) {
        pending = pending === '' ? line : pending;
        continue;
      }
      if (!inDeclarations && pending !== '' && line !== '' && !line.includes('{')) {
        orphans.push(pending);
        pending = '';
      }
      if (line.includes('{')) {
        // Only these at-rules nest further rules. @font-face and friends
        // hold plain declarations, where a trailing comma is a wrapped
        // value (`src: url(...) format(...),`) rather than a selector.
        const nesting = /^@(media|supports|keyframes|layer|container|scope)\b/.test(line);
        stack.push(nesting ? 'at' : 'rule');
        pending = '';
      }
      if (line.includes('}')) stack.pop();
    }

    expect(orphans).toEqual([]);
  });

  it('declares no empty rule or media query', () => {
    const css = effectiveCss();
    // An empty block is what a deleted rule leaves behind; it is harmless
    // on its own but marks a removal that was not finished.
    expect(css).not.toMatch(/\{\s*\}/);
  });
});
