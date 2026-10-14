/**
 * The context-after budget (spec: "Context-after budget (amended 2026-09-24)").
 *
 * Pi's trigger bounds the context *before* a compaction. This module bounds the context *after*
 * one, measured the way Pi measures it: Pi's own projection over the entries, then Pi's own
 * estimate over the projected messages. No rendering of ours takes part, because a lossy
 * rendering misstates what Pi keeps.
 *
 * Everything Pi-specific is injected — `Estimator` and `productionEstimator` take Pi's
 * `buildSessionProjection` and `estimateTokens` as arguments — so this module imports nothing
 * from Pi and is testable against a fake projection.
 */

/** Pi's `estimateTokens` over a projection, with Pi's `buildSessionProjection` supplied by the caller. */
export interface Estimator {
  estimate(entries: readonly unknown[]): number;
  /**
   * Pi's `getCurrentSystemMessage` over the projection of these entries: the system message
   * `appendCompaction` records on a compaction entry (with a `timestamp` in epoch ms), or
   * undefined when the projection has no system message.
   */
  systemMessage(entries: readonly unknown[]): unknown | undefined;
}

export interface BudgetInput {
  targetContextTokens?: number;
  branchEntries: readonly unknown[];
  firstKeptEntryId: string;
  /** Pi's `tokensBefore` at the compaction's own snapshot. */
  tokensBefore: number;
  contextWindow: number;
  reserveTokens: number;
  /** Ceiling on the summary: `maxShare x T`. */
  maxShare: number;
  /** Share of the compactable context that may remain after the compaction. */
  maxAfterShare: number;
  model: { provider: string; id: string };
  estimator: Estimator;
}

export interface Budget {
  /** Pi's trigger: `contextWindow - reserveTokens`. */
  T: number;
  /**
   * The provider-counted content outside the message list. `calibrated` and `carried` are the
   * current model's own; `foreign` and `carried-foreign` come from another model; `none` assumes
   * no overhead at all (the difference is then absent from both the target and the check, so it
   * can only make the result more conservative).
   */
  O: number;
  provenance: 'calibrated' | 'carried' | 'foreign' | 'carried-foreign' | 'none';
  /** What the context holds after the compaction apart from the summary, in provider tokens (`r x E0`). */
  F: number;
  /** The preferred target: at most `maxAfterShare` of the context before, never more than `T`. */
  A: number;
  /**
   * The summary's own budget: normally `min(maxShare x T, A - F)` when the preferred target is
   * reachable, otherwise `min(maxShare x T, T - F)`. When that is non-positive (the fixed content
   * reaches the trigger, or the share floors to zero) the budget is the larger of the two terms,
   * so the pruner still has a positive budget to work against. Never a refusal.
   */
  budgetTokens: number;
  /** The fixed content reaches the trigger (`T - F <= 0`), the condition once named `no_room`. */
  overTrigger: boolean;
  /** The ordinary `min(maxShare x T, room)` was non-positive, so the floor budget was used. */
  noRoom: boolean;
  /** The predicted context `P` for a given summary. */
  projectedTokens(summary: string): number;
}

const PROBE_ID = 'jev-budget-probe';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Pi's `calculateContextTokens`: the native total when present, otherwise the components. */
function calculateContextTokens(usage: Record<string, unknown>): number {
  const total = usage.totalTokens;
  if (typeof total === 'number' && total > 0) return total;
  const component = (key: string): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
  return component('input') + component('output') + component('cacheRead') + component('cacheWrite');
}

/**
 * Pi's `getAssistantUsage`: a valid usage is a non-aborted, non-errored assistant response whose
 * counted tokens are greater than zero.
 */
function validAssistantUsage(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message) || message.role !== 'assistant' || !('usage' in message)) return undefined;
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return undefined;
  const usage = message.usage;
  if (!isRecord(usage)) return undefined;
  return calculateContextTokens(usage) > 0 ? usage : undefined;
}

/** The newest assistant response on the branch with valid usage, or undefined. */
function newestAssistantMessage(entries: readonly unknown[]): Record<string, unknown> | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isRecord(entry) && entry.type === 'message' && validAssistantUsage(entry.message)) return entry;
  }
  return undefined;
}

interface OverheadRecord {
  tokens: number;
  provider: string;
  model: string;
}

/**
 * The overhead a previous compaction recorded, scanning back past a native compaction (Pi's own
 * entries carry no `details.jev` at all, so stopping at the first compaction entry lost a hook
 * value underneath one). The value is returned whatever its model; the caller decides whether it
 * is the current one.
 */
function newestCarriedOverhead(entries: readonly unknown[]): OverheadRecord | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isRecord(entry) || entry.type !== 'compaction') continue;
    const details = entry.details;
    const overhead = isRecord(details) && isRecord(details.jev) ? details.jev.overhead : undefined;
    if (!isRecord(overhead)) continue;
    const tokens = overhead.tokens;
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) continue;
    if (typeof overhead.provider !== 'string' || typeof overhead.model !== 'string') continue;
    return { tokens, provider: overhead.provider, model: overhead.model };
  }
  return undefined;
}

/**
 * The compaction entry standing in for the summary Pi will project, at the given summary.
 * `appendCompaction` also records the branch's current system message on the entry, and Pi
 * projects it ahead of the summary, so the probe carries it too.
 */
function probe(
  entries: readonly unknown[],
  firstKeptEntryId: string,
  tokensBefore: number,
  summary: string,
  systemMessage: unknown,
) {
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const id = isRecord(last) && typeof last.id === 'string' ? last.id : null;
  const timestamp = isRecord(last) && last.timestamp !== undefined ? last.timestamp : new Date(0).toISOString();
  return {
    type: 'compaction',
    id: PROBE_ID,
    parentId: id,
    timestamp,
    summary,
    firstKeptEntryId,
    tokensBefore,
    ...(systemMessage !== undefined
      ? { systemMessage: { ...(systemMessage as object), timestamp: new Date(timestamp as string).getTime() } }
      : {}),
  };
}

export function computeBudget(input: BudgetInput): Budget {
  const { branchEntries, firstKeptEntryId, tokensBefore, contextWindow, reserveTokens, maxShare, maxAfterShare, model, estimator } = input;

  const T = contextWindow - reserveTokens;
  const estimateOf = (entries: readonly unknown[]): number => estimator.estimate(entries);

  const E = estimateOf(branchEntries);
  const d = tokensBefore - E;
  const assistant = newestAssistantMessage(branchEntries);
  const sameModelAssistant =
    d > 0 &&
    assistant !== undefined &&
    isRecord(assistant.message) &&
    assistant.message.provider === model.provider &&
    assistant.message.model === model.id;
  const carried = newestCarriedOverhead(branchEntries);
  const sameModelCarried =
    carried !== undefined && carried.provider === model.provider && carried.model === model.id;

  // O, in the documented order: a positive difference from the current model's own response,
  // the current model's own carried value, the same difference from any other model's response
  // (`foreign`), any other model's carried value (`carried-foreign`), else none. A positive
  // difference from another model is still provider-counted content outside the message list;
  // measuring it is always better than assuming no overhead, and the operator's rule is that a
  // Jev compaction is never refused over the context-after budget (2026-09-25).
  let O: number;
  let provenance: Budget['provenance'];
  if (sameModelAssistant) {
    O = d;
    provenance = 'calibrated';
  } else if (sameModelCarried) {
    O = carried!.tokens;
    provenance = 'carried';
  } else if (d > 0 && assistant !== undefined) {
    O = d;
    provenance = 'foreign';
  } else if (carried !== undefined) {
    O = carried.tokens;
    provenance = 'carried-foreign';
  } else {
    O = 0;
    provenance = 'none';
  }

  // Pi computes the system message once, from the branch, when it writes the compaction entry.
  const systemMessage = estimator.systemMessage(branchEntries);
  const withProbe = (summary: string) => [
    ...branchEntries,
    probe(branchEntries, firstKeptEntryId, tokensBefore, summary, systemMessage),
  ];

  // The provider's count scales with the conversation, not by a fixed amount: on Claude the
  // difference O grows with the context (150K to 470K on 1M-window sessions), so adding it to the
  // estimate after a compaction overstated the result by a median 43%. Scaling the estimate by the
  // provider's own ratio r = (E + O) / E missed the next provider count by a median 5.6%
  // (15 compactions, 2026-09-26). The budget is in estimator tokens, which the pruner counts in.
  const r = E > 0 ? (E + O) / E : 1;
  const E0 = estimateOf(withProbe(''));
  const F = Math.round(r * E0);
  const suppliedTarget = input.targetContextTokens;
  const A = Math.min(maxAfterShare * (E + O), T, typeof suppliedTarget === 'number' && Number.isFinite(suppliedTarget) && suppliedTarget > 0 ? suppliedTarget : Infinity);
  // The budget is the smaller of the config's own share of the trigger and the room under the
  // target. When the kept content alone passes the target, the room keeps `maxAfterShare` of
  // what sits above the kept content, so the compaction still shrinks the context; it is capped
  // by the room under the trigger. When that is non-positive there is no summary it can describe:
  // the fixed content reaches the trigger, or the share floors to zero. It becomes the larger of
  // the two terms, so the pruner still has a positive budget to work against. The context-after
  // budget guides pruning and never refuses a compaction (operator decision 2026-09-25);
  // `overTrigger`/`noRoom` carry what the old `no_room` failure recorded.
  const share = (maxShare * T) / r;
  const room = A - F > 0 ? (A - F) / r : Math.min(maxAfterShare * (E - E0), (T - F) / r);
  const smaller = Math.floor(Math.min(share, room));
  const noRoom = smaller <= 0;

  return {
    T,
    O,
    provenance,
    F,
    A,
    budgetTokens: noRoom ? Math.max(0, Math.floor(Math.max(share, room))) : smaller,
    overTrigger: T - F <= 0,
    noRoom,
    projectedTokens: (summary: string) => Math.round(r * estimateOf(withProbe(summary))),
  };
}

/**
 * Pi's own estimate of a projection's messages: the newest system message once, then every
 * non-system message in order. The system message is charged first, as Pi sends it first.
 */
export function projectionTokens(
  messages: readonly unknown[],
  estimateTokens: (message: unknown) => number,
): number {
  let newestSystemIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRecord(messages[i]) && messages[i].role === 'system') {
      newestSystemIndex = i;
      break;
    }
  }
  let total = 0;
  if (newestSystemIndex >= 0) total += estimateTokens(messages[newestSystemIndex]);
  for (let i = 0; i < messages.length; i++) {
    if (i === newestSystemIndex) continue;
    if (isRecord(messages[i]) && messages[i].role === 'system') continue;
    total += estimateTokens(messages[i]);
  }
  return total;
}

/**
 * The production `Estimator`: Pi's `buildSessionProjection` over the entries, then Pi's
 * `estimateTokens` over non-system messages plus the fully replayed system prompt. The same
 * `getCurrentSystemMessage` supplies the system message Pi records on the compaction. All three
 * are injected, so this module stays free of Pi imports and the caller owns the Pi version it is
 * bound to.
 */
export function productionEstimator(
  buildSessionProjection: (entries: readonly unknown[]) => { messages: readonly unknown[] },
  estimateTokens: (message: unknown) => number,
  getCurrentSystemMessage: (messages: readonly unknown[]) => unknown | undefined,
): Estimator {
  return {
    estimate(entries) {
      const messages = buildSessionProjection(entries).messages;
      // The provider consumes the replayed prompt, not just the newest section patch.
      // Charge that same complete system message before calibration and after the probe.
      const system = getCurrentSystemMessage(messages);
      return (system === undefined ? 0 : estimateTokens(system)) + messages.reduce<number>((sum, message) =>
        isRecord(message) && message.role === 'system' ? sum : sum + estimateTokens(message), 0);
    },
    systemMessage(entries) {
      return getCurrentSystemMessage(buildSessionProjection(entries).messages);
    },
  };
}
