import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_ENDPOINTS } from '../constants/api';

/**
 * A chat docked to the right edge, asking questions of the stored records.
 *
 * It sits beside the feed rather than above it because the two are read
 * together: you ask about something, then scroll the timeline to check it.
 * As a top panel it pushed the feed down and had to be folded away to get
 * the timeline back, which is the opposite of how it gets used.
 *
 * Each answer is grounded in observations retrieved for the question, and
 * the sources are listed under it so a claim can be checked. Follow-ups
 * work: the last turns are sent back so "그럼 왜?" resolves against the
 * thread instead of being read as a fresh question.
 */

const OPEN_KEY = 'cm.ask.open';
const TURNS_KEY = 'cm.ask.turns';
/** Turns sent back for context. Matches the server's own cap. */
const HISTORY_TURNS = 2;
/**
 * Turns kept across reloads. The thread is a convenience, not a record, so
 * it is capped: localStorage is a few MB per origin and a long thread with
 * its sources would crowd out everything else the viewer stores.
 */
const KEPT_TURNS = 30;

interface AskSource {
  id: string;
  project: string | null;
  createdAtEpoch: number;
  excerpt: string;
}

interface AskResponse {
  answer: string;
  model: string;
  sources: AskSource[];
  empty: boolean;
}

interface AskStatus {
  available: boolean;
  briefingLoaded: boolean;
  models: string[];
}

interface Turn {
  question: string;
  answer: string;
  model: string;
  sources: AskSource[];
  failed?: boolean;
}

export function readAskOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeAskOpen(value: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, value ? '1' : '0');
  } catch {
    // Not remembered; the chat still works this session.
  }
}

/**
 * The thread survives a reload. It lives only in this browser — the server
 * keeps no record of a question beyond the usage counter — so treat a miss
 * or a malformed value as "no thread yet" rather than an error.
 */
function readTurns(): Turn[] {
  try {
    const raw = localStorage.getItem(TURNS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((turn): turn is Turn =>
        typeof turn === 'object' && turn !== null
        && typeof (turn as Turn).question === 'string'
        && typeof (turn as Turn).answer === 'string')
      .map(turn => ({
        question: turn.question,
        answer: turn.answer,
        model: typeof turn.model === 'string' ? turn.model : '',
        sources: Array.isArray(turn.sources) ? turn.sources : [],
        failed: turn.failed === true,
      }))
      .slice(-KEPT_TURNS);
  } catch {
    return [];
  }
}

function writeTurns(turns: Turn[]): void {
  try {
    if (turns.length === 0) {
      localStorage.removeItem(TURNS_KEY);
      return;
    }
    localStorage.setItem(TURNS_KEY, JSON.stringify(turns.slice(-KEPT_TURNS)));
  } catch {
    // Over quota or storage blocked. The thread still works this session.
  }
}

interface AskChatProps {
  /** Project filter in force, so answers match what the feed shows. */
  project: string | null;
  /** Owned by the parent: the content shift has to render with the panel. */
  open: boolean;
  onToggle: () => void;
}

export function AskChat({ project, open, onToggle }: AskChatProps) {
  const [status, setStatus] = useState<AskStatus | null>(null);
  const [turns, setTurns] = useState<Turn[]>(readTurns);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(API_ENDPOINTS.ASK_STATUS);
        if (response.ok) setStatus(await response.json() as AskStatus);
      } catch {
        // The ask itself will report the real problem.
      }
    })();
  }, []);

  // Keep the newest exchange in view as answers land.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, pending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Persist the thread so a reload does not wipe what was asked.
  useEffect(() => {
    writeTurns(turns);
  }, [turns]);

  const submit = useCallback(async () => {
    const trimmed = question.trim();
    if (trimmed === '' || pending) return;

    setQuestion('');
    setPending(true);
    const history = turns
      .filter(turn => !turn.failed)
      .slice(-HISTORY_TURNS)
      .map(turn => ({ question: turn.question, answer: turn.answer }));

    try {
      const response = await fetch(API_ENDPOINTS.ASK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed, project, history }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message ?? response.statusText);
      const result = body as AskResponse;
      setTurns(prev => [...prev, {
        question: trimmed,
        answer: result.answer,
        model: result.model,
        sources: result.sources,
      }]);
    } catch (err) {
      setTurns(prev => [...prev, {
        question: trimmed,
        answer: `답변 실패: ${err instanceof Error ? err.message : String(err)}`,
        model: '',
        sources: [],
        failed: true,
      }]);
    } finally {
      setPending(false);
    }
  }, [question, pending, project, turns]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }, [submit]);

  if (!open) {
    return (
      <button type="button" className="ask-launcher" onClick={onToggle} title="기록에 물어보기">
        💬 물어보기
      </button>
    );
  }

  return (
    <aside className="ask-chat" aria-label="기록에 물어보기">
      <header className="ask-chat-header">
        <span className="ask-chat-title">
          물어보기
          {project && <span className="ask-chat-scope">{project}</span>}
        </span>
        <div className="ask-chat-actions">
          {turns.length > 0 && (
            <button type="button" className="ask-chat-icon" onClick={() => setTurns([])} title="대화 비우기">
              지우기
            </button>
          )}
          <button type="button" className="ask-chat-icon" onClick={onToggle} title="닫기">✕</button>
        </div>
      </header>

      <div className="ask-chat-body" ref={scrollRef}>
        {status && !status.available && (
          <p className="ask-chat-warn">
            답변 기능이 꺼져 있습니다. <code>GEMINI_API_KEY</code> 와{' '}
            <code>CLAUDE_MEM_SERVER_MODEL</code> 을 설정하세요.
          </p>
        )}

        {turns.length === 0 && (
          <div className="ask-chat-empty">
            <p>저장된 기록에 대해 물어보세요.</p>
            <p className="ask-chat-hint">
              10분 간격으로 저장된 <strong>요약 기록</strong>을 근거로 답합니다.
              대화 원문이 아니라 세부는 빠져 있을 수 있고, 기록에 없으면 없다고
              답합니다. 요약과 같은 무료 한도를 씁니다.
            </p>
          </div>
        )}

        {turns.map((turn, index) => (
          <div className="ask-turn" key={index}>
            <div className="ask-bubble ask-bubble-you">{turn.question}</div>
            <div className={`ask-bubble ask-bubble-answer${turn.failed ? ' ask-bubble-failed' : ''}`}>
              {turn.answer}
              {turn.sources.length > 0 && (
                <details className="ask-sources">
                  <summary>
                    근거 {turn.sources.length}건
                    {turn.model && <span className="ask-model"> · {turn.model}</span>}
                  </summary>
                  <ul>
                    {turn.sources.map(source => (
                      <li key={source.id}>
                        <span className="ask-source-meta">
                          {new Date(source.createdAtEpoch).toLocaleString()} · {source.project ?? 'unknown'}
                        </span>
                        <span className="ask-source-text">{source.excerpt}…</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        ))}

        {pending && <div className="ask-bubble ask-bubble-answer ask-bubble-pending">찾는 중…</div>}
      </div>

      <footer className="ask-chat-input-row">
        <textarea
          ref={inputRef}
          className="ask-input"
          rows={2}
          placeholder="질문 (Enter 전송, Shift+Enter 줄바꿈)"
          value={question}
          onChange={event => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={pending}
        />
        <button
          type="button"
          className="ask-submit"
          onClick={() => void submit()}
          disabled={pending || question.trim() === ''}
        >
          전송
        </button>
      </footer>
    </aside>
  );
}
