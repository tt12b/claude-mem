import React, { useMemo, useRef, useEffect } from 'react';
import { Observation, Summary, UserPrompt, AssistantMessage, FeedItem } from '../types';
import { ObservationCard } from './ObservationCard';
import { SummaryCard } from './SummaryCard';
import { PromptCard } from './PromptCard';
import { MessageCard } from './MessageCard';
import { ScrollToTop } from './ScrollToTop';
import { UI } from '../constants/ui';

interface FeedProps {
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  messages: AssistantMessage[];
  onLoadMore: () => void;
  isLoading: boolean;
  hasMore: boolean;
}

/**
 * One conversation turn: the question, then everything that followed it until
 * the next question — answers first, plus whatever observations and summaries
 * were generated from that stretch of work.
 *
 * `prompt` is null for the leading group, which holds items that arrived
 * before any captured question (older sessions, or work that started before
 * prompt capture was added).
 */
interface Turn {
  key: string;
  prompt: UserPrompt | null;
  items: FeedItem[];
}

/**
 * Which conversation an item belongs to.
 *
 * Grouping used to follow time alone, so a reply joined whichever question
 * came last — and with two sessions running at once their turns interleaved:
 * a question asked in one project appeared answered by the other. Falling
 * back to the project label keeps older rows, written before the server sent
 * a session id, from all collapsing into one thread.
 */
export function threadOf(item: FeedItem): string {
  const session = (item as { turn_session_id?: string }).turn_session_id;
  if (session) return `s:${session}`;
  return `p:${item.project ?? 'unknown'}`;
}

export function groupIntoTurns(items: FeedItem[]): Turn[] {
  // Ascending, so a prompt is seen before the replies that belong to it.
  const ascending = [...items].sort((a, b) => a.created_at_epoch - b.created_at_epoch);

  const turns: Turn[] = [];
  // One open turn per conversation, so concurrent sessions do not capture
  // each other's replies.
  const open = new Map<string, Turn>();

  for (const item of ascending) {
    const thread = threadOf(item);
    if (item.itemType === 'prompt') {
      const turn: Turn = { key: `turn-${item.id}`, prompt: item, items: [] };
      open.set(thread, turn);
      turns.push(turn);
      continue;
    }
    let current = open.get(thread);
    if (!current) {
      current = { key: `turn-leading-${thread}`, prompt: null, items: [] };
      open.set(thread, current);
      turns.push(current);
    }
    current.items.push(item);
  }

  // Newest conversation on top, but each turn reads top-down: question first,
  // then the replies in the order they happened.
  return turns.reverse();
}

export function Feed({ observations, summaries, prompts, messages, onLoadMore, isLoading, hasMore }: FeedProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first.isIntersecting && hasMore && !isLoading) {
          onLoadMoreRef.current?.();
        }
      },
      { threshold: UI.LOAD_MORE_THRESHOLD }
    );

    observer.observe(element);

    return () => {
      if (element) {
        observer.unobserve(element);
      }
      observer.disconnect();
    };
  }, [hasMore, isLoading]);

  const turns = useMemo<Turn[]>(() => {
    const combined: FeedItem[] = [
      ...observations.map(o => ({ ...o, itemType: 'observation' as const })),
      ...summaries.map(s => ({ ...s, itemType: 'summary' as const })),
      ...prompts.map(p => ({ ...p, itemType: 'prompt' as const })),
      ...messages.map(m => ({ ...m, itemType: 'message' as const }))
    ];

    return groupIntoTurns(combined);
  }, [observations, summaries, prompts, messages]);

  const itemCount = useMemo(
    () => turns.reduce((sum, turn) => sum + turn.items.length + (turn.prompt ? 1 : 0), 0),
    [turns]
  );

  return (
    <div className="feed" ref={feedRef}>
      <ScrollToTop targetRef={feedRef} />
      <div className="feed-content">
        {turns.map(turn => (
          <div className="turn" key={turn.key}>
            {turn.prompt && <PromptCard prompt={turn.prompt} />}
            {turn.items.length > 0 && (
              <div className="turn-replies">
                {turn.items.map(item => {
                  const key = `${item.itemType}-${item.id}`;
                  if (item.itemType === 'observation') {
                    return <ObservationCard key={key} observation={item} />;
                  }
                  if (item.itemType === 'summary') {
                    return <SummaryCard key={key} summary={item} />;
                  }
                  if (item.itemType === 'message') {
                    return <MessageCard key={key} message={item} />;
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        ))}
        {itemCount === 0 && !isLoading && (
          <div style={{ textAlign: 'center', padding: '40px', color: '#8b949e' }}>
            No items to display
          </div>
        )}
        {isLoading && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#8b949e' }}>
            <div className="spinner" style={{ display: 'inline-block', marginRight: '10px' }}></div>
            Loading more...
          </div>
        )}
        {hasMore && !isLoading && itemCount > 0 && (
          <div ref={loadMoreRef} style={{ height: '20px', margin: '10px 0' }} />
        )}
        {!hasMore && itemCount > 0 && (
          <div style={{ textAlign: 'center', padding: '20px', color: '#8b949e', fontSize: '14px' }}>
            No more items to load
          </div>
        )}
      </div>
    </div>
  );
}
