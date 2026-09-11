import React, { useCallback, useEffect, useState } from 'react';
import { ModelReport } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { CollapsiblePanel } from './CollapsiblePanel';

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

  const emb = report.embeddings;
  // Folded, the question is only ever "what is running right now and how
  // much is left on it" — the other candidates matter when choosing one,
  // which is what unfolding is for.
  const current = report.models.find(m => m.active)
    ?? report.models.find(m => m.name === report.preferredModel)
    ?? report.models.find(m => m.status === 'available' && m.configured);
  const summary = current
    ? [
        current.name,
        `요청 ${current.calls.total.toLocaleString()}`,
        current.remaining !== null
          ? `남은 요청 ${current.remaining.toLocaleString()}${current.limit !== null ? `/${current.limit}` : ''}`
          : '한도 미확인',
        current.status === 'exhausted' ? '한도 소진' : null,
        emb?.enabled ? `임베딩 ${emb.embedded}/${emb.total}${emb.stalled ? ' ⚠' : ''}` : null,
      ].filter(Boolean).join(' · ')
    : '사용 가능한 모델 없음';

  return (
    <CollapsiblePanel storageKey="cm.panel.models" title="요약 모델" summary={summary}>
    <div className="model-panel">
      <div className="model-header">
        <span className="model-title">오늘 사용량 · {resetLabel(report.quotaResetsAtEpoch)} 초기화</span>
        <span className="model-provider">{report.provider ?? '미설정'}</span>
      </div>

      <ul className="model-list">
        {report.models.map(model => (
          // Colour carries one meaning each: green says the model can be
          // used, blue says it is the operator's pick, grey says it is spent.
          // A picked model that runs out goes grey like any other — the pick
          // is an intent, not a claim that it works.
          <li
            key={model.name}
            className={[
              'model-row',
              `model-row-${model.status}`,
              model.preferred ? 'model-row-preferred' : '',
            ].filter(Boolean).join(' ')}
          >
            <button
              type="button"
              className="model-name model-select"
              onClick={() => void select(model.name)}
              disabled={!model.configured || pending !== null}
              title={model.configured ? '이 모델을 먼저 시도' : '설정 목록에 없어 선택할 수 없음'}
            >
              <span className="model-dot" aria-hidden="true">●</span>
              {model.name}
              {model.preferred && <span className="model-tag model-tag-pick">선택됨</span>}
              {model.status === 'exhausted' && (
                <span className="model-tag model-tag-out">
                  한도 소진{model.exhaustedAtEpoch !== null ? ` · ${sinceLabel(model.exhaustedAtEpoch)}` : ''}
                </span>
              )}
              {!model.configured && <span className="model-tag">목록에서 제거됨</span>}
              {pending === model.name && <span className="model-tag">변경 중…</span>}
            </button>
            <span className="model-metrics">
              <Metric label="요청" value={model.calls.total} />
              <Metric label="성공" value={model.calls.succeeded} />
              <Metric label="실패" value={model.calls.failed} tone={model.calls.failed > 0 ? 'warn' : undefined} />
              <Metric label="쓴 토큰" value={model.tokens} />
              {/* The free tier meters requests per day, not tokens — keep the
                  unit in the label so this is not read as a token budget. */}
              <Metric
                label="남은 요청"
                value={model.remaining}
                suffix={
                  model.limit !== null
                    ? ` / ${model.limit}${model.limitSource === 'configured' ? ' 추정' : ''}`
                    : ''
                }
                unknownHint="한도 미확인"
              />
            </span>
          </li>
        ))}
      </ul>

      <EmbeddingRow embeddings={report.embeddings} />

      <p className="model-note">
        <strong>초록</strong>은 지금 쓸 수 있는 모델, <strong>회색</strong>은 한도가
        소진된 모델, <strong>파랑</strong>은 먼저 시도하도록 고른 모델입니다.
        사용량과 소진 표시 모두 Google 의 초기화 시점(태평양 시간 자정)부터 셉니다.
        회색은 초기화되거나 그 모델로 다시 성공하면 초록으로 돌아옵니다.
        무료 한도는 <strong>하루 요청 횟수</strong> 기준이라 토큰 소비량과는 별개입니다.
        모델을 누르면 그 모델을 먼저 시도하고, 한도에 걸리면 나머지 모델로 자동
        전환되므로 선택해도 생성이 멈추지 않습니다. “추정”은 공개 문서 기준값이고,
        Google 이 실제로 요청을 거절하면 그때 알려준 값으로 교정됩니다.
      </p>
    </div>
    </CollapsiblePanel>
  );
}

/**
 * Semantic-search health.
 *
 * Shown here rather than in its own panel because it is the same question
 * the model rows answer — is a provider still saying yes — and because a
 * second panel is what the operator already asked to stop having.
 */
function EmbeddingRow({ embeddings }: { embeddings: ModelReport['embeddings'] }) {
  if (!embeddings) return null;

  if (!embeddings.enabled) {
    return (
      <div className="embedding-row embedding-row-off">
        <span className="embedding-label">의미 검색</span>
        <span className="embedding-detail">{offReason(embeddings.reason)} · 키워드 검색만 동작합니다</span>
      </div>
    );
  }

  const done = embeddings.pending === 0;
  const tone = embeddings.stalled ? 'warn' : (done ? 'ok' : 'busy');

  return (
    <div className={`embedding-row embedding-row-${tone}`}>
      <span className="embedding-label">의미 검색</span>
      <span className="embedding-detail">
        <span className="embedding-model">{embeddings.model}</span>
        <span className="embedding-count">{embeddings.embedded.toLocaleString()} / {embeddings.total.toLocaleString()} 임베딩</span>
        {embeddings.pending > 0 && (
          <span className="embedding-pending">대기 {embeddings.pending.toLocaleString()}</span>
        )}
        {embeddings.lastEmbeddedAtEpoch !== null && (
          <span className="embedding-when">마지막 {sinceLabel(embeddings.lastEmbeddedAtEpoch)}</span>
        )}
        {embeddings.stalled && (
          <span className="embedding-warn">
            멈춘 것으로 보입니다 — 로그에서 embedding tick 을 확인하세요
          </span>
        )}
      </span>
    </div>
  );
}

function offReason(reason: string | null): string {
  if (reason === 'pgvector_unavailable') return 'pgvector 없음';
  if (reason === 'not_configured') return 'API 키 없음 또는 비활성';
  if (reason === 'unreadable') return '상태를 읽지 못함';
  return '꺼짐';
}

/**
 * When the daily allowance next resets, in the reader's own clock. Google
 * meters at midnight Pacific, which is rarely a round hour locally, so
 * showing the converted time beats naming a timezone the reader has to
 * convert themselves.
 */
function resetLabel(epoch: number): string {
  const at = new Date(epoch);
  const hours = Math.max(0, Math.round((epoch - Date.now()) / 3_600_000));
  const clock = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${clock} (${hours}시간 후)`;
}

/** Rough age of a refusal, so a stale grey row is recognisable as stale. */
function sinceLabel(epoch: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - epoch) / 60_000));
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  return `${hours}시간 전`;
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
