import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import { CollapsiblePanel } from './CollapsiblePanel';

/**
 * Ask a question about what is stored, and get an answer back.
 *
 * The dashboard could show the records but not be asked anything; finding
 * "how did we fix the queue last month" meant scrolling. The server already
 * had the pieces — semantic search over the observations, and a provider key
 * — so this is the missing input box, not a new capability.
 *
 * The answer is grounded twice over: a briefing that teaches the model this
 * project's vocabulary, and the observations retrieved for the question. The
 * sources are listed under the answer so a claim can be checked rather than
 * taken on trust.
 */

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

interface AskPanelProps {
  /** Project filter in force, so the answer matches what the feed shows. */
  project: string | null;
}

export function AskPanel({ project }: AskPanelProps) {
  const [status, setStatus] = useState<AskStatus | null>(null);
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResponse | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(API_ENDPOINTS.ASK_STATUS);
        if (!response.ok) throw new Error(response.statusText);
        setStatus(await response.json() as AskStatus);
      } catch {
        // Leave status null — the panel still renders and the ask itself
        // will report the real problem.
      }
    })();
  }, []);

  const submit = useCallback(async () => {
    const trimmed = question.trim();
    if (trimmed === '' || pending) return;

    setPending(true);
    setError(null);
    setResult(null);
    setAsked(trimmed);
    try {
      const response = await fetch(API_ENDPOINTS.ASK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed, project }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message ?? response.statusText);
      setResult(body as AskResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, [question, pending, project]);

  // Enter sends, Shift+Enter makes a newline — a question is usually one
  // line, and reaching for a button for every one gets old.
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }, [submit]);

  const summary = status && !status.available
    ? '사용 불가 — API 키 또는 모델 미설정'
    : (asked ? `최근 질문: ${asked.slice(0, 40)}${asked.length > 40 ? '…' : ''}` : '기록에 대해 물어보기');

  return (
    <CollapsiblePanel storageKey="cm.panel.ask" title="물어보기" summary={summary}>
      <div className="ask-panel">
        {status && !status.available && (
          <p className="ask-unavailable">
            답변 기능이 꺼져 있습니다. <code>GEMINI_API_KEY</code> 와{' '}
            <code>CLAUDE_MEM_SERVER_MODEL</code> 을 설정하세요.
          </p>
        )}

        <div className="ask-input-row">
          <textarea
            ref={inputRef}
            className="ask-input"
            rows={2}
            placeholder={project
              ? `${project} 기록에 대해 물어보세요 (Enter 전송, Shift+Enter 줄바꿈)`
              : '저장된 기록에 대해 물어보세요 (Enter 전송, Shift+Enter 줄바꿈)'}
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
            {pending ? '찾는 중…' : '질문'}
          </button>
        </div>

        {error && <p className="ask-error">답변 실패: {error}</p>}

        {result && (
          <div className="ask-result">
            <p className="ask-answer">{result.answer}</p>
            {!result.empty && (
              <details className="ask-sources">
                <summary>
                  근거 {result.sources.length}건
                  {result.model && <span className="ask-model"> · {result.model}</span>}
                </summary>
                <ul>
                  {result.sources.map(source => (
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
        )}

        <p className="ask-note">
          저장된 <strong>요약 기록</strong>만 보고 답합니다. 대화 원문이 아니라
          10분 간격 요약이라 세부는 빠져 있을 수 있고, 기록에 없으면 없다고
          답합니다. 답변은 Gemini 가 만들며 요약과 같은 무료 한도를 씁니다.
        </p>
      </div>
    </CollapsiblePanel>
  );
}
