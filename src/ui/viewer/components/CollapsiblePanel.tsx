import React, { useCallback, useState } from 'react';

/**
 * A panel that folds away, remembering the choice per viewer.
 *
 * The model and usage strips are reference material, not the thing being
 * read — collapsed they should cost one line, and the state should survive a
 * reload so the operator is not re-collapsing them every visit.
 *
 * localStorage can throw outright (private windows, blocked site data), so
 * both the read and the write are guarded and the panel simply falls back to
 * its default state.
 */
function readStored(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Nothing to do — the panel still works, it just will not be remembered.
  }
}

interface CollapsiblePanelProps {
  storageKey: string;
  title: string;
  /** Shown next to the title while collapsed, so the panel stays useful folded. */
  summary?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}

export function CollapsiblePanel({
  storageKey,
  title,
  summary,
  defaultCollapsed = true,
  children,
}: CollapsiblePanelProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => readStored(storageKey, defaultCollapsed));

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      writeStored(storageKey, next);
      return next;
    });
  }, [storageKey]);

  return (
    <section className={`panel-shell${collapsed ? ' panel-shell-collapsed' : ''}`}>
      <button
        type="button"
        className="panel-toggle"
        onClick={toggle}
        aria-expanded={!collapsed}
      >
        <span className="panel-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        <span className="panel-toggle-title">{title}</span>
        {collapsed && summary && <span className="panel-toggle-summary">{summary}</span>}
      </button>
      {!collapsed && <div className="panel-body">{children}</div>}
    </section>
  );
}
