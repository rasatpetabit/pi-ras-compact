import { tokensForChars } from '../../src/core/prune.js';
import type { Estimator } from '../../src/pi/context-budget.js';

export interface FakeEstimatorOptions {
  /** Tokens charged for one projected message entry with no `tokens` of its own. */
  defaultMessageTokens?: number;
  /** Tokens charged for a projected summary message; the default is Pi's chars/4. */
  summaryTokens?: (summary: string) => number;
}

/**
 * Stands in for Pi's `buildSessionProjection` + `estimateTokens` in tests. It models a
 * projection the way Pi builds one: the newest compaction's summary message, then the
 * message entries kept from that compaction's `firstKeptEntryId` to the end of the branch.
 * A message entry may carry a fixture-only `tokens` field to place the projection exactly.
 * System messages are not dropped the way Pi drops them from the kept range, so tests keep
 * system entries out of the branch except where the entry's own `systemMessage` is the point.
 */
export function fakeEstimator(options: FakeEstimatorOptions = {}): Estimator & { calls: unknown[][] } {
  const defaultMessageTokens = options.defaultMessageTokens ?? 100;
  const summaryTokens = options.summaryTokens ?? (summary => tokensForChars(summary.length));
  const calls: unknown[][] = [];
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const isMessage = (entry: unknown): entry is Record<string, unknown> => record(entry) && entry.type === 'message';
  const cost = (entry: Record<string, unknown>): number =>
    typeof entry.tokens === 'number' ? entry.tokens : defaultMessageTokens;
  /** Pi's `getCurrentSystemMessage` stand-in: the newest system message entry on the branch. */
  const systemMessage = (entries: readonly unknown[]): unknown | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (isMessage(entry) && record(entry.message) && entry.message.role === 'system') return entry.message;
    }
    return undefined;
  };
  return {
    calls,
    systemMessage,
    estimate(entries) {
      calls.push([...entries]);
      let compactionIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (record(entry) && entry.type === 'compaction') {
          compactionIndex = i;
          break;
        }
      }
      if (compactionIndex < 0) {
        return entries.filter(isMessage).reduce((sum, entry) => sum + cost(entry), 0);
      }
      const compaction = entries[compactionIndex] as Record<string, unknown>;
      const firstKept = entries.findIndex(entry => record(entry) && entry.id === compaction.firstKeptEntryId);
      const from = firstKept >= 0 && firstKept < compactionIndex ? firstKept : compactionIndex + 1;
      const kept = entries.slice(from).filter(isMessage).reduce((sum, entry) => sum + cost(entry), 0);
      // The system message Pi records on the entry is projected ahead of the summary. A
      // fixture-only `tokens` field places it; the default is none, as in Pi's own entries.
      const carried = record(compaction.systemMessage) && typeof compaction.systemMessage.tokens === 'number'
        ? compaction.systemMessage.tokens
        : 0;
      return carried + summaryTokens(typeof compaction.summary === 'string' ? compaction.summary : '') + kept;
    },
  };
}
