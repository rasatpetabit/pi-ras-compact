/**
 * Charter retirement by correction (spec: Design > Charter, How an entry leaves).
 *
 * The judge only answers choice questions about entries that already exist; it never
 * writes text. For each operator message first seen in this compaction it answers
 * whether the message corrects or retracts an earlier live entry and, if so, which one.
 * An earlier entry is retired only on a confident answer; anything else (no answer, a
 * transport error, a low probability, an unknown label) retires nothing. Retiring is the
 * only lossy step for a directive, so every rule here biases toward keeping.
 */
import { admitCharterProposal, type CharterGate } from './charter-gate.js';
import type { CharterEntry, CharterState, RetireReason } from './charter.js';

/** The subset of the judge interface this module needs (CoreAsker satisfies it). */
export interface ChoiceAsker {
  ask(
    state: Record<string, unknown>,
    questions: Record<string, { type: 'choice' | 'noul'; instructions: string; criteria?: Record<string, string> }>,
  ): Promise<{ answers: Record<string, unknown> }>;
}

export interface RetireOptions {
  /** Optional veto of confirmed proposals only; absent preserves the legacy path. */
  gate?: CharterGate;
  /** Probability the chosen earlier entry must reach before it is retired. */
  threshold: number;
  /** The confirming yes/no ("does the earlier entry still apply?") must be at most this. */
  confirmMax: number;
  /** Earlier live entries offered as candidates, most recent first. */
  maxCandidates: number;
  /** Characters of each entry shown to the judge. Identification needs little text. */
  showChars: number;
}

export const DEFAULT_RETIRE_OPTIONS: RetireOptions = { threshold: 0.85, confirmMax: 0.15, maxCandidates: 12, showChars: 700 };

export interface RetireLog {
  /** The new message that was asked about. */
  by: string;
  /** Candidate label the judge chose, its probability, and what happened. */
  choice: string | null;
  p: number | null;
  /** The confirming answer: probability that the earlier entry still applies. */
  stillApplies?: number | null;
  retired: string | null;
  why: 'retired' | 'none' | 'below_threshold' | 'not_confirmed' | 'no_answer' | 'error' | 'no_candidates' | 'gate_kept';
}

/** Contiguous characters a fresh message must quote from a retired entry to reinstate it. */
export const REINSTATE_QUOTE_CHARS = 40;
const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();

/**
 * Reinstates retired entries a fresh operator message refers back to (spec: Charter >
 * Safeguards): by naming the entry's id, or by quoting 40 or more contiguous characters of it.
 * Deterministic; runs before the correction questions.
 */
export function reinstateReferenced(
  all: readonly CharterEntry[],
  fresh: ReadonlySet<string>,
  state: CharterState,
): { state: CharterState; reinstated: string[] } {
  const retiredIds = Object.keys(state.retired);
  if (retiredIds.length === 0) return { state, reinstated: [] };
  const byId = new Map(all.map(e => [e.id, e]));
  const freshTexts = all.filter(e => e.kind === 'said' && fresh.has(e.id)).map(e => ({ raw: e.text, flat: squash(e.text).slice(0, 4000) }));
  const reinstated: string[] = [];
  for (const id of retiredIds) {
    const target = byId.get(id);
    const hay = target ? squash(target.text) : '';
    const hit = freshTexts.some(f => {
      if (f.raw.includes(id)) return true;
      if (hay.length < REINSTATE_QUOTE_CHARS) return false;
      for (let i = 0; i + REINSTATE_QUOTE_CHARS <= f.flat.length; i++) {
        if (hay.includes(f.flat.slice(i, i + REINSTATE_QUOTE_CHARS))) return true;
      }
      return false;
    });
    if (hit) reinstated.push(id);
  }
  if (reinstated.length === 0) return { state, reinstated };
  const retired: CharterState['retired'] = {};
  for (const [k, v] of Object.entries(state.retired)) {
    if (!reinstated.includes(k)) Object.defineProperty(retired, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return { state: { version: 1, retired }, reinstated };
}

const clip = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n)} …[${text.length - n} more chars]`);

const NONE = 'none';

function readChoice(answer: unknown): { choice: string; p: number } | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const a = answer as Record<string, unknown>;
  if (typeof a.choice !== 'string') return undefined;
  const probs = a.probabilities as Record<string, unknown> | undefined;
  const p = probs && typeof probs[a.choice] === 'number' ? (probs[a.choice] as number) : undefined;
  if (p === undefined || !Number.isFinite(p)) return undefined;
  return { choice: a.choice, p };
}

/**
 * Asks, for each entry in `fresh` (operator messages first compacted now, oldest first),
 * which earlier live entry it corrects. Returns the new state and a log line per question.
 * Entries retired earlier in the same call are no longer candidates for later ones.
 */
export async function retireCorrected(
  all: readonly CharterEntry[],
  fresh: ReadonlySet<string>,
  state: CharterState,
  gen: number,
  asker: ChoiceAsker,
  options: RetireOptions = DEFAULT_RETIRE_OPTIONS,
): Promise<{ state: CharterState; log: RetireLog[] }> {
  const retired: CharterState['retired'] = { ...state.retired };
  const log: RetireLog[] = [];
  const isLive = (e: CharterEntry) => !Object.prototype.hasOwnProperty.call(retired, e.id);
  for (const entry of all) {
    if (entry.kind !== 'said' || !fresh.has(entry.id)) continue;
    const earlier = all.filter(e => e.order < entry.order && isLive(e)).slice(-options.maxCandidates).reverse();
    if (earlier.length === 0) {
      log.push({ by: entry.id, choice: null, p: null, retired: null, why: 'no_candidates' });
      continue;
    }
    const criteria: Record<string, string> = { [NONE]: 'It corrects or retracts none of them (it adds to them, answers something, or is unrelated).' };
    const labelOf = new Map<string, string>();
    earlier.forEach((e, i) => {
      const label = `E${i + 1}`;
      labelOf.set(label, e.id);
      criteria[label] = clip(e.text, options.showChars);
    });
    const proposalState = { new_operator_message: clip(entry.text, options.showChars * 2) };
    const proposalQuestions = {
      corrects: {
        type: 'choice' as const,
        instructions:
          'The operator has just sent new_operator_message. Does it correct, reverse or retract one of the earlier operator ' +
          'messages or answers listed as options, so that the earlier one no longer applies? Choose that earlier entry only if ' +
          'the new message clearly replaces it. Adding a requirement, narrowing it, or asking a new question is not a correction: choose none.',
        criteria,
      },
    };
    let answers: Record<string, unknown>;
    try {
      ({ answers } = await asker.ask(proposalState, proposalQuestions));
    } catch {
      log.push({ by: entry.id, choice: null, p: null, retired: null, why: 'error' });
      continue;
    }
    const read = readChoice(answers.corrects);
    if (!read) {
      log.push({ by: entry.id, choice: null, p: null, retired: null, why: 'no_answer' });
      continue;
    }
    const target = labelOf.get(read.choice);
    if (read.choice === NONE || target === undefined) {
      log.push({ by: entry.id, choice: read.choice, p: read.p, retired: null, why: 'none' });
      continue;
    }
    if (read.p < options.threshold) {
      log.push({ by: entry.id, choice: read.choice, p: read.p, retired: null, why: 'below_threshold' });
      continue;
    }
    // Second, independent answer: the earlier entry must be judged no longer to apply.
    let stillApplies: number | undefined;
    try {
      const confirm = await asker.ask(
        { earlier_operator_message: clip(earlier.find(e => e.id === target)!.text, options.showChars * 2), new_operator_message: clip(entry.text, options.showChars * 2) },
        { still_applies: { type: 'noul', instructions: 'After new_operator_message, does earlier_operator_message still apply, in whole or in part?' } },
      );
      const n = (confirm.answers.still_applies as { noul?: unknown } | undefined)?.noul;
      stillApplies = typeof n === 'number' && Number.isFinite(n) ? n : undefined;
    } catch {
      stillApplies = undefined;
    }
    if (stillApplies === undefined || stillApplies > options.confirmMax) {
      log.push({ by: entry.id, choice: read.choice, p: read.p, stillApplies: stillApplies ?? null, retired: null, why: 'not_confirmed' });
      continue;
    }
    if (options.gate && !await admitCharterProposal(options.gate, proposalState, proposalQuestions, read.choice)) {
      log.push({ by: entry.id, choice: read.choice, p: read.p, stillApplies, retired: null, why: 'gate_kept' });
      continue;
    }
    const reason: RetireReason = 'corrected';
    Object.defineProperty(retired, target, { value: { reason, by: entry.id, gen }, enumerable: true, writable: true, configurable: true });
    log.push({ by: entry.id, choice: read.choice, p: read.p, stillApplies, retired: target, why: 'retired' });
  }
  return { state: { version: 1, retired }, log };
}
