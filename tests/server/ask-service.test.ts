import { afterEach, describe, expect, it } from 'bun:test';
import { AskService } from '../../src/server/ask/AskService.js';
import { resetVectorSupportCache } from '../../src/storage/postgres/vector-support.js';

function pool(rows: Array<Record<string, unknown>>) {
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

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'obs-1',
    content: '큐 접두사가 서버와 워커에서 달라 잡이 소비되지 않았다',
    created_at: new Date('2026-09-09T01:00:00.000Z'),
    project_label: 'claude-mem',
    ...overrides,
  };
}

function geminiOk(text: string) {
  return async () => new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

const ENV_KEYS = ['GEMINI_API_KEY', 'CLAUDE_MEM_SERVER_MODEL', 'CLAUDE_MEM_EMBEDDINGS'] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetVectorSupportCache(null);
});

describe('AskService', () => {
  it('answers from the retrieved records and reports which ones it used', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    const { pool: p } = pool([row()]);

    const result = await new AskService({ pool: p, fetchImpl: geminiOk('큐 접두사를 맞춰서 고쳤습니다') as never })
      .ask({ question: '큐 문제 어떻게 고쳤지' });

    expect(result.answer).toBe('큐 접두사를 맞춰서 고쳤습니다');
    expect(result.model).toBe('model-a');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].project).toBe('claude-mem');
    expect(result.empty).toBe(false);
  });

  it('says so without calling the provider when nothing matches', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    let calls = 0;
    const { pool: p } = pool([]);

    const result = await new AskService({
      pool: p,
      fetchImpl: (async () => { calls++; return new Response('{}'); }) as never,
    }).ask({ question: '존재하지 않는 주제' });

    // Spending one of a small daily allowance to say "I found nothing" is
    // the one call that is always wasted.
    expect(calls).toBe(0);
    expect(result.empty).toBe(true);
    expect(result.sources).toHaveLength(0);
  });

  it('sends the briefing and the records together as the prompt', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    let prompt = '';
    const { pool: p } = pool([row()]);

    await new AskService({
      pool: p,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        prompt = JSON.parse(String(init.body)).contents[0].parts[0].text;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
      }) as never,
    }).ask({ question: '큐 문제' });

    // The briefing is what teaches the model that "잡" and "워커" are terms
    // of art here rather than ordinary words.
    expect(prompt).toContain('여웅이 Mem');
    expect(prompt).toContain('## 참고할 기록');
    expect(prompt).toContain('큐 접두사가 서버와 워커에서');
    expect(prompt).toContain('## 질문');
    expect(prompt).toContain('큐 문제');
  });

  it('orders the records oldest first so a history reads in sequence', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    let prompt = '';
    const { pool: p } = pool([
      row({ id: 'b', content: '나중 기록', created_at: new Date('2026-09-10T00:00:00Z') }),
      row({ id: 'a', content: '먼저 기록', created_at: new Date('2026-09-08T00:00:00Z') }),
    ]);

    await new AskService({
      pool: p,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        prompt = JSON.parse(String(init.body)).contents[0].parts[0].text;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
      }) as never,
    }).ask({ question: '경위' });

    expect(prompt.indexOf('먼저 기록')).toBeLessThan(prompt.indexOf('나중 기록'));
  });

  it('moves to the next model when one is out of quota', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'spent,working';
    resetVectorSupportCache(false);
    const tried: string[] = [];
    const { pool: p } = pool([row()]);

    const result = await new AskService({
      pool: p,
      fetchImpl: (async (url: string) => {
        tried.push(url.includes('spent') ? 'spent' : 'working');
        if (url.includes('spent')) {
          return new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
        }
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '답' }] } }] }));
      }) as never,
    }).ask({ question: '질문' });

    expect(tried).toEqual(['spent', 'working']);
    expect(result.model).toBe('working');
  });

  it('stops on a non-quota failure instead of burning the rest of the list', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'a,b,c';
    resetVectorSupportCache(false);
    let calls = 0;
    const { pool: p } = pool([row()]);

    await expect(new AskService({
      pool: p,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 });
      }) as never,
    }).ask({ question: '질문' })).rejects.toThrow();

    expect(calls).toBe(1);
  });

  it('refuses an empty question', async () => {
    const { pool: p } = pool([]);
    await expect(new AskService({ pool: p }).ask({ question: '   ' })).rejects.toThrow('empty');
  });

  it('reports a missing key rather than silently answering nothing', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.CLAUDE_MEM_GEMINI_API_KEY;
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    const { pool: p } = pool([row()]);

    await expect(new AskService({ pool: p }).ask({ question: '질문' }))
      .rejects.toThrow('GEMINI_API_KEY');
  });

  it('scopes retrieval to a project when one is selected', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    const { calls, pool: p } = pool([row()]);

    await new AskService({ pool: p, fetchImpl: geminiOk('ok') as never })
      .ask({ question: '질문', project: 'claude-mem' });

    expect(calls[0].text).toContain("= $4");
    expect(calls[0].values).toContain('claude-mem');
  });

  it('leaves the vector cast out where pgvector is absent', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    const { calls, pool: p } = pool([row()]);

    await new AskService({ pool: p, fetchImpl: geminiOk('ok') as never }).ask({ question: '질문' });

    // A `::vector` cast on stock Postgres is a syntax error, not an empty
    // result — it would take the whole ask down.
    expect(calls[0].text).not.toContain('::vector');
  });
});
