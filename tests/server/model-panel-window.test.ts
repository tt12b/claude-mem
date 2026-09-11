import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';

const source = readFileSync('src/server/runtime/ServerDashboardApiRoutes.ts', 'utf8');

/** The body of handleModels, where the panel's figures are gathered. */
function handleModelsBody(): string {
  const start = source.indexOf('private async handleModels(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  private ', start + 10);
  return source.slice(start, end === -1 ? undefined : end);
}

describe('model panel measurement window', () => {
  it('measures every counted figure from the quota day', () => {
    // "요청 6" sat next to "남은 요청 14/20" while the database held 13
    // calls: the counts were a rolling 24h and the remaining figure was the
    // quota day, so the two could never agree.
    const body = handleModelsBody();
    expect(body).not.toContain('[since]');
  });

  it('still derives the quota day from the provider reset', () => {
    expect(handleModelsBody()).toContain('quotaDayStart()');
  });

  it('leaves the usage panel free to show a wider window', () => {
    // /api/usage is history, not headroom — it may span days.
    const usage = source.slice(source.indexOf('private async handleUsage('));
    expect(usage).toContain('[since]');
  });
});
