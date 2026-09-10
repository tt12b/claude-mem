// SPDX-License-Identifier: Apache-2.0
//
// Turning observation text into vectors.
//
// Kept deliberately narrow: one method, one batch in, one batch out. The
// generation providers carry prompts, modes, failover and quota accounting;
// none of that applies here, and reusing that interface would drag all of it
// along for what is a single stateless call.

export interface EmbeddingProvider {
  /** Shown in logs so an operator can tell which service produced a vector. */
  readonly label: string;
  /** Width of the vectors returned. Must match the storage column. */
  readonly dimensions: number;
  /**
   * Embed a batch, returning one vector per input in the same order.
   *
   * Implementations either return a full result set or throw. A partial
   * batch would silently mis-align vectors with their observations, which is
   * far worse than retrying the batch later.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Largest batch handed to a provider in one call. */
export const MAX_EMBEDDING_BATCH = 50;
