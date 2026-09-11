import React from 'react';
import { ThemeToggle } from './ThemeToggle';
import { ThemePreference } from '../hooks/useTheme';
import { useSpinningFavicon } from '../hooks/useSpinningFavicon';
import { Glossary } from './Glossary';

interface HeaderProps {
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  isProcessing: boolean;
  queueDepth: number;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onContextPreviewToggle: () => void;
  onShowHelp?: () => void;
}

export function Header({
  projects,
  currentFilter,
  onFilterChange,
  isProcessing,
  queueDepth,
  themePreference,
  onThemeChange,
  onContextPreviewToggle,
  onShowHelp
}: HeaderProps) {
  useSpinningFavicon(isProcessing);

  return (
    <div className="header">
      <div className="header-main">
        <h1>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <img src="yeoung-mem-logomark.png" alt="" className={`logomark ${isProcessing ? 'spinning' : ''}`} />
            {queueDepth > 0 && (
              <div className="queue-bubble">
                {queueDepth}
              </div>
            )}
          </div>
          <span className="logo-text">여웅이 Mem</span>
        </h1>
        <Glossary />
      </div>
      <div className="status">
        <select
          value={currentFilter}
          onChange={e => onFilterChange(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects.map(project => (
            <option key={project} value={project}>{project}</option>
          ))}
        </select>
        <ThemeToggle
          preference={themePreference}
          onThemeChange={onThemeChange}
        />
        <button
          className="settings-btn"
          onClick={() => onShowHelp?.()}
          title="Show welcome card"
          aria-label="Show welcome card"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </button>
        <button
          className="settings-btn"
          onClick={onContextPreviewToggle}
          title="Settings"
        >
          <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        </button>
      </div>
    </div>
  );
}
