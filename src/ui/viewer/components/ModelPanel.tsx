import React, { useCallback, useEffect, useState } from 'react';
import { ModelReport } from '../types';
import { API_ENDPOINTS } from '../constants/api';

const REFRESH_MS = 30_000;

/**
 * The model candidate list and what each has spent.
 *
 * Generation walks `CLAUDE_MEM_SERVER_MODEL` in order and falls through to
 * the next entry when one is out of quota, so the highlighted model is
 * whichever last produced a completed job — not necessarily the first.
 *
 * Remaining is shown only for models Google has already refused once: the
 * ceiling is reported in the 429 body and nowhere else, so before that it is
 * genuinely unknown and is left blank rather than guessed.
 */
export function ModelPanel() {
  const [report, setReport] = useState<ModelReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_ENDPOINTS.MODELS}?days=1`);
      if (!response.ok) throw new Error(response.statusText);
      setReport(await response.json() as ModelReport);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Selecting a model only moves it to the front of the candidate list; the
  // rest stay behind it, so a pick that turns out to be spent still falls
  // through to the next one instead of stalling generation.
  const select = useCallback(async (model: string) => {
    setPending(model);
    try {
      const response = await fetch(API_ENDPOINTS.MODELS_ACTIVE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) throw new Error(response.statusText);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }, [load]);

  if (error) {
    return <div className="model-panel model-panel-error">모델 정보를 불러오지 못했습니다: {error}</div>;
  }
  if (!report || report.models.length === 0) {
    return null;
  }

  return (
    <div className="model-panel">
      <div className="model-header">
        <span className="model-title">요약 모델 · 최근 {report.windowDays}일</span>
        <span className="model-provider">{report.provider ?? '미설정'}</span>
      </div>

      <ul className="model-list">
        {report.models.map(model => (
          <li key={model.name} className={`model-row${model.active ? ' model-row-active' : ''}`}>
            <button
              type="button"
              className="model-name model-select"
              onClick={() => void select(model.name)}
              disabled={!model.configured || pending !== null}
              title={model.configured ? '이 모델을 먼저 시도' : '설정 목록에 없어 선택할 수 없음'}
            >
              {model.active && <span className="model-dot" aria-hidden="true">●</span>}
              {model.name}
              {model.preferred && <span className="model-tag model-tag-pick">선택됨</span>}
              {!model.configured && <span className="model-tag">목록에서 제거됨</span>}
              {pending === model.name && <span className="model-tag">변경 중…</span>}
            </button>
            <span className="model-metrics">
              <Metric label="호출" value={model.calls.total} />
              <Metric label="성공" value={model.calls.succeeded} />
              <Metric label="실패" value={model.calls.failed} tone={model.calls.failed > 0 ? 'warn' : undefined} />
              <Metric label="토큰" value={model.tokens} />
              <Metric
                label="남음"
                value={model.remaining}
                suffix={model.limit !== null ? ` / ${model.limit}` : ''}
                unknownHint="한도 미확인"
              />
            </span>
          </li>
        ))}
      </ul>

      <p className="model-note">
        모델을 누르면 그 모델을 먼저 시도합니다. 한도에 걸리면 나머지 모델로 자동
        전환되므로 선택해도 생성이 멈추지 않습니다. 한도는 Google 이 요청을 거절할
        때만 알려주므로, 아직 거절당한 적 없는 모델은 남은 양을 알 수 없습니다.
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  suffix,
  unknownHint,
}: {
  label: string;
  value: number | null;
  tone?: 'warn';
  suffix?: string;
  unknownHint?: string;
}) {
  return (
    <span className={`model-metric${tone ? ` model-metric-${tone}` : ''}`}>
      <span className="model-metric-label">{label}</span>
      <span className="model-metric-value">
        {value === null ? (unknownHint ?? '—') : `${value.toLocaleString()}${suffix ?? ''}`}
      </span>
    </span>
  );
}
