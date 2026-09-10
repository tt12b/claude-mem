// SPDX-License-Identifier: Apache-2.0
//
// Try a list of models in order, moving on when one is out of quota.
//
// Gemini's free tier meters per project AND per model
// (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`), so a key that is
// exhausted on one model still has a full allowance on another — measured on
// this deployment: `gemini-flash-latest` returned 429 with `limit: 20` while
// `gemini-3.5-flash-lite` answered normally on the same key. Without failover
// a single exhausted model stops summarisation for the rest of the day.
//
// Only quota-shaped failures advance to the next candidate. A bad API key or
// a malformed request would fail identically everywhere, so those propagate
// immediately rather than burning the whole list.

import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';
import { logger } from '../../../utils/logger.js';

/** Classifications that mean "this model is spent, try another". */
const FAILOVER_KINDS = new Set(['quota_exhausted', 'insufficient_quota', 'resource_exhausted', 'rate_limit']);

function classificationOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

export interface FailoverCandidate {
  readonly modelId: string;
  readonly provider: ServerGenerationProvider;
}

export interface FailoverOptions {
  /**
   * Model the operator picked, read fresh before each job. The worker builds
   * its provider once at startup, so without a per-call lookup a dashboard
   * change would not take effect until the container restarted.
   */
  readonly resolvePreferredModel?: () => Promise<string | null>;
}

export class FailoverObservationProvider implements ServerGenerationProvider {
  readonly providerLabel: ServerGenerationProvider['providerLabel'];

  constructor(
    private readonly candidates: readonly FailoverCandidate[],
    private readonly options: FailoverOptions = {},
  ) {
    if (candidates.length === 0) {
      throw new Error('FailoverObservationProvider requires at least one candidate');
    }
    this.providerLabel = candidates[0]!.provider.providerLabel;
  }

  /**
   * Candidates with the operator's pick moved to the front. The rest keep
   * their configured order, so a preference changes which model is tried
   * first without giving up the fallback chain behind it.
   */
  private async orderedCandidates(): Promise<readonly FailoverCandidate[]> {
    const resolve = this.options.resolvePreferredModel;
    if (!resolve) return this.candidates;

    let preferred: string | null = null;
    try {
      preferred = await resolve();
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'preferred model lookup failed; using configured order', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.candidates;
    }

    if (!preferred) return this.candidates;
    const index = this.candidates.findIndex(candidate => candidate.modelId === preferred);
    if (index <= 0) return this.candidates;
    return [this.candidates[index]!, ...this.candidates.filter((_, i) => i !== index)];
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    let lastError: unknown;
    const candidates = await this.orderedCandidates();

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      try {
        return await candidate.provider.generate(context, signal);
      } catch (error: unknown) {
        lastError = error;
        const kind = classificationOf(error);
        const isLast = index === candidates.length - 1;

        if (!kind || !FAILOVER_KINDS.has(kind) || isLast) {
          throw error;
        }

        logger.warn('SYSTEM', 'model out of quota; falling back to next candidate', {
          jobId: context.job.id,
          exhaustedModel: candidate.modelId,
          nextModel: candidates[index + 1]!.modelId,
          classification: kind,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError;
  }
}
