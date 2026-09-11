import React, { useCallback, useEffect, useState } from 'react';
import { UsageReport } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { CollapsiblePanel } from './CollapsiblePanel';

const REFRESH_MS = 30_000;

/**
 * Failure reasons come back as the classifier's own identifiers
 * (src/server/generation/providers/shared/error-classification.ts). They are
 * meaningless to a reader, so map the ones that actually occur; anything new
 * falls through as its raw id rather than being hidden.
 */
const FAILURE_LABELS: Record<string, string> = {
  quota_exhausted: '무료 한도 소진',
  insufficient_quota: '할당량 부족',
  resource_exhausted: '리소스 초과',
  rate_limit: '요청 속도 제한',
  auth_invalid: '인증 실패',
  parse_error: '응답 형식 오류',
  transient: '일시적 오류',
  unrecoverable: '복구 불가 오류',
  unknown: '원인 미상',
};

/**
 * What the provider was asked to do in this window.
 *
 * Gemini exposes no quota-remaining read for an AI Studio key, so this is
 * consumption, not headroom. One call is one summarisation attempt — not one
 * conversation and not one observation.
 */
export function UsagePanel() {
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_ENDPOINTS.USAGE}?days=1`);
      if (!response.ok) throw new Error(response.statusText);
      setUsage(await response.json() as UsageReport);
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

  if (error) {
    return <div className="usage-panel usage-panel-error">사용량을 불러오지 못했습니다: {error}</div>;
  }
  if (!usage) {
    return <div className="usage-panel">사용량 불러오는 중…</div>;
  }

  const totalTokens = usage.tokens.reduce((sum, row) => sum + row.total, 0);
  const model = usage.tokens.find(row => row.model)?.model ?? null;

  return (
    <CollapsiblePanel
      storageKey="cm.panel.usage"
      title="요약 생성 사용량"
      // Folded shows the three counts and nothing else; the token figure,
      // the per-model breakdown and the failure reasons wait for a click.
      summary={`시도 ${usage.calls.total.toLocaleString()}`
        + ` · 성공 ${usage.calls.succeeded.toLocaleString()}`
        + ` · 실패 ${usage.calls.failed.toLocaleString()}`}
    >
    <div className="usage-panel">
      <div className="usage-header">
        <span className="usage-title">최근 {usage.windowDays}일</span>
        <span className="usage-provider">
          {usage.provider ?? '미설정'}{model ? ` · ${model}` : ''}
        </span>
      </div>

      <div className="usage-stats">
        <Stat label="요약 시도" value={usage.calls.total} />
        <Stat label="요약 성공" value={usage.calls.succeeded} />
        <Stat label="요약 실패" value={usage.calls.failed} tone={usage.calls.failed > 0 ? 'warn' : undefined} />
        <Stat label="사용 토큰" value={totalTokens} />
      </div>

      <p className="usage-note">
        대화 기록 자체는 {usage.provider ?? '모델'} 을 쓰지 않습니다. 위 숫자는 대화를
        요약해 관측치를 만드는 작업에만 해당합니다.
      </p>

      {usage.failureReasons.length > 0 && (
        <div className="usage-reasons-block">
          {/* A breakdown of the failure count above, so a single reason
              legitimately equals the total — label it to avoid reading as a
              second, unrelated number. */}
          <span className="usage-reasons-title">실패 {usage.calls.failed}건의 사유</span>
          <ul className="usage-reasons">
            {usage.failureReasons.map(reason => (
              <li key={reason.classification}>
                <span className="usage-reason-name">
                  {FAILURE_LABELS[reason.classification] ?? reason.classification}
                </span>
                <span className="usage-reason-count">{reason.count}건</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
    </CollapsiblePanel>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div className={`usage-stat${tone ? ` usage-stat-${tone}` : ''}`}>
      <span className="usage-stat-value">{value.toLocaleString()}</span>
      <span className="usage-stat-label">{label}</span>
    </div>
  );
}
