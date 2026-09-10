export interface Observation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project?: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string;
  project: string;
  platform_source: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

/**
 * An assistant turn. The server stores it as an `assistant_message`
 * agent_event and serves it in the same shape as a prompt, so the feed can
 * treat both sides of a conversation identically.
 */
export type AssistantMessage = UserPrompt;

export type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' })
  | (AssistantMessage & { itemType: 'message' });

export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'new_message' | 'processing_status';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  messages?: AssistantMessage[];
  projects?: string[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  message?: AssistantMessage;
  isProcessing?: boolean;
  queueDepth?: number;
}

/** Response shape of /api/models — candidate list and per-model spend. */
export interface ModelReport {
  windowDays: number;
  provider: string | null;
  /** Counts are metered from this instant — the provider's own reset point. */
  quotaDayStartEpoch: number;
  quotaResetsAtEpoch: number;
  quotaTimezone: string;
  activeModel: string | null;
  /** What the operator asked to try first; differs from active when spent. */
  preferredModel: string | null;
  models: Array<{
    name: string;
    configured: boolean;
    /** Usable right now: no quota refusal since this model last answered. */
    status: 'available' | 'exhausted';
    exhaustedAtEpoch: number | null;
    active: boolean;
    preferred: boolean;
    priority: number;
    calls: { total: number; succeeded: number; failed: number };
    tokens: number;
    /** Ceiling in force: measured from a 429 if seen, else the configured figure. */
    limit: number | null;
    /** Where `limit` came from — a measured value supersedes a configured one. */
    limitSource: 'measured' | 'configured' | null;
    remaining: number | null;
  }>;
}

/** Response shape of /api/usage — provider spend for the current window. */
export interface UsageReport {
  windowDays: number;
  since: string;
  provider: string | null;
  calls: { total: number; succeeded: number; failed: number };
  tokens: Array<{ provider: string | null; model: string | null; total: number }>;
  jobs: Record<string, number>;
  failureReasons: Array<{ classification: string; count: number }>;
}

export interface ProjectCatalog {
  projects: string[];
  sources: string[];
  projectsBySource: Record<string, string[]>;
}

export interface Settings {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;

  CLAUDE_MEM_PROVIDER?: string;  
  CLAUDE_MEM_GEMINI_API_KEY?: string;
  CLAUDE_MEM_GEMINI_MODEL?: string;  
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED?: string;  
  CLAUDE_MEM_OPENROUTER_API_KEY?: string;
  CLAUDE_MEM_OPENROUTER_MODEL?: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL?: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME?: string;

  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  CLAUDE_MEM_CONTEXT_FULL_COUNT?: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD?: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT?: string;

  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;
}
