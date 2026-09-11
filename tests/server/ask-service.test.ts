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
    team_id: 'team-1',
    project_id: 'project-1',
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

  it('still answers when retrieval finds nothing, and says there were no records', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    let prompt = '';
    const { pool: p } = pool([]);

    // Short-circuiting here saved a call but made a chat window look broken:
    // "안녕" matches no record, and got "관련된 기록을 찾지 못했습니다".
    const result = await new AskService({
      pool: p,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        prompt = JSON.parse(String(init.body)).contents[0].parts[0].text;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '안녕하세요' }] } }] }));
      }) as never,
    }).ask({ question: '안녕' });

    expect(result.answer).toBe('안녕하세요');
    expect(prompt).toContain('관련된 기록을 찾지 못했습니다');
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

describe('AskService metering', () => {
  it('records the call so the model panel counts it against the same allowance', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    const { calls, pool: p } = pool([row()]);

    await new AskService({
      pool: p,
      fetchImpl: (async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '답' }] } }],
        usageMetadata: { totalTokenCount: 1234 },
      }))) as never,
    }).ask({ question: '질문' });

    const inserts = calls.filter(call => call.text.includes('INSERT INTO usage_events'));
    // Asking spends the same daily budget as summarising; without both rows
    // the gauge keeps counting down only summaries and overstates headroom.
    expect(inserts).toHaveLength(2);
    expect(inserts.some(call => call.values?.includes('request'))).toBe(true);
    expect(inserts.some(call => call.values?.includes(1234))).toBe(true);
    expect(inserts[0].values?.[1]).toBe('team-1');
  });

  it('skips the token row when the provider reported no count', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    const { calls, pool: p } = pool([row()]);

    await new AskService({ pool: p, fetchImpl: geminiOk('답') as never }).ask({ question: '질문' });

    const inserts = calls.filter(call => call.text.includes('INSERT INTO usage_events'));
    expect(inserts).toHaveLength(1);
  });
});

describe('AskService follow-ups', () => {
  it('searches on the thread so a terse follow-up still retrieves', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    const { calls, pool: p } = pool([row()]);

    await new AskService({ pool: p, fetchImpl: geminiOk('답') as never }).ask({
      question: '그럼 왜 그랬어?',
      history: [{ question: '큐 접두사 문제', answer: '불일치였습니다' }],
    });

    // "그럼 왜 그랬어?" alone retrieves nothing useful; the earlier question
    // is what carries the topic.
    expect(String(calls[0].values?.[1])).toContain('큐 접두사 문제');
    expect(String(calls[0].values?.[1])).toContain('그럼 왜 그랬어?');
  });

  it('shows the model the prior exchange', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    let prompt = '';
    const { pool: p } = pool([row()]);

    await new AskService({
      pool: p,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        prompt = JSON.parse(String(init.body)).contents[0].parts[0].text;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
      }) as never,
    }).ask({
      question: '왜?',
      history: [{ question: '무슨 문제였어', answer: '접두사 불일치' }],
    });

    expect(prompt).toContain('## 이전 대화');
    expect(prompt).toContain('접두사 불일치');
  });

  it('keeps only the last two turns so the prompt cannot grow without bound', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.CLAUDE_MEM_SERVER_MODEL = 'model-a';
    resetVectorSupportCache(false);
    let prompt = '';
    const { pool: p } = pool([row()]);

    await new AskService({
      pool: p,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        prompt = JSON.parse(String(init.body)).contents[0].parts[0].text;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
      }) as never,
    }).ask({
      question: '지금',
      history: [
        { question: '아주오래된질문', answer: 'a' },
        { question: '두번째질문', answer: 'b' },
        { question: '세번째질문', answer: 'c' },
      ],
    });

    expect(prompt).not.toContain('아주오래된질문');
    expect(prompt).toContain('세번째질문');
  });
});
