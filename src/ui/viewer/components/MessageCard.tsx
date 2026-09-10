import React from 'react';
import { AssistantMessage } from '../types';
import { formatDate } from '../utils/formatters';

interface MessageCardProps {
  message: AssistantMessage;
}

/**
 * The assistant side of a turn. Paired with PromptCard so the feed shows both
 * halves of a conversation rather than only the questions and the generated
 * observations.
 */
export function MessageCard({ message }: MessageCardProps) {
  const date = formatDate(message.created_at_epoch);

  return (
    <div className="card message-card">
      <div className="card-header">
        <div className="card-header-left">
          <span className="card-type">Response</span>
          <span className={`card-source source-${message.platform_source || 'claude'}`}>
            {message.platform_source || 'claude'}
          </span>
          <span className="card-project">{message.project}</span>
        </div>
      </div>
      <div className="card-content">
        {message.prompt_text}
      </div>
      <div className="card-meta">
        <span className="meta-date">#{message.id} • {date}</span>
      </div>
    </div>
  );
}
