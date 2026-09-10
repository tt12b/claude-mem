import React, { useCallback, useEffect, useState } from 'react';
import { UsageReport } from '../types';
import { API_ENDPOINTS } from '../constants/api';

const REFRESH_MS = 30_000;

/**
 * Provider spend for the current window.
 *
 * Gemini exposes no quota-remaining read for an AI Studio key, so this shows
 * consumption rather than headroom: how many calls went out, how many failed
 * and why. `quota_exhausted` dominating the failure list is the signal that
 * the free tier is spent.
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
    return <div className="usage-panel usage-panel-error">Usage unavailable: {error}</div>;
  }
  if (!usage) {
    return <div className="usage-panel">Loading usage…</div>;
  }

  const totalTokens = usage.tokens.reduce((sum, row) => sum + row.total, 0);
  const model = usage.tokens.find(row => row.model)?.model ?? null;

  return (
    <div className="usage-panel">
      <div className="usage-header">
        <span className="usage-title">Provider usage · last {usage.windowDays}d</span>
        <span className="usage-provider">
          {usage.provider ?? 'unknown'}{model ? ` · ${model}` : ''}
        </span>
      </div>

      <div className="usage-stats">
        <Stat label="Calls" value={usage.calls.total} />
        <Stat label="Succeeded" value={usage.calls.succeeded} />
        <Stat label="Failed" value={usage.calls.failed} tone={usage.calls.failed > 0 ? 'warn' : undefined} />
        <Stat label="Tokens" value={totalTokens} />
      </div>

      {usage.failureReasons.length > 0 && (
        <ul className="usage-reasons">
          {usage.failureReasons.map(reason => (
            <li key={reason.classification}>
              <span className="usage-reason-name">{reason.classification}</span>
              <span className="usage-reason-count">{reason.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
