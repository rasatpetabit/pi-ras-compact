import { decideCall, questionsFor } from '../vendor/pi-jev/compaction/decision.js';
import {
  collectToolCalls,
  estimateTokens,
  fitState,
  goalFromMessages,
  STATE_CONTEXT,
  type FittedState,
  type JevAnswer,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import type { SegmentStatus } from './render.js';
import type { Segment } from './segments.js';

/** Which judge round a batch belongs to: the new span, or step 3's re-judge of the carry. */
export type JudgeRound = 'span' | 'carry';

/**
 * The asker the core calls. `call` names the batch inside this round so the
 * adapter can log it with the request; it is optional because a host asker
 * that ignores telemetry still satisfies the vendored `JevAsker`.
 */
export interface CoreAsker {
  ask(state: JevState, questions: JevQuestions, call?: { round: JudgeRound; batch: number }): Promise<JevResponse>;
}

export type Verdict =
  | { kind: 'call'; answers: Record<string, JevAnswer> }
  | { kind: 'text'; keep: number | undefined };

export interface JudgeUsage {
  requests: number;
  input: number;
  output: number;
}

export interface JudgeOptions {
  goal: string;
  maxStateTokens: number;
  maxRequestTokens: number;
}

/** A call's answers are stored under this id so `decideCall` can be re-run at any threshold. */
export const VERDICT_ID = 'x';

/*
 * What Jev is asked. Upstream asks whether a call's output must stay "verbatim"
 * because "re-running the tool would not do", a conjunction Jev answers no to
 * for nearly everything: on this host's live sessions it kept 0 of 2,203 calls.
 * Each question below asks one thing, in the "still needed" direction, and the
 * output question shows the output's start and end, which the state omits.
 * Upstream's staleness question and its decision rule are kept unchanged.
 */
/** Characters of an output, head and tail together, shown in its question. */
export const PREVIEW_CHARS = 300;
/** Replaces upstream's state framing, which tells Jev anything can be re-run. */
export const STATE_FRAMING =
  'A coding assistant conversation is being compacted to free context. `history` is part of the conversation, oldest first; tool outputs are replaced by a short note and long texts may be abridged. `goal` is what the user asked for most recently. Each question asks whether one item still holds information the assistant needs to continue the current task correctly.';
export const RESULT_TRUE =
  'The assistant will need this output again to continue correctly: the error being fixed, file contents it is editing, a value or constraint it relies on';
export const RESULT_FALSE =
  'The output only confirmed a step, was superseded by a later call, or its content was already restated by the assistant';
/**
 * The newest text entries of the whole candidate, added to every window's state
 * so a window of older history still shows where the work went. Upstream's
 * default count of protected recent messages.
 */
export const CONTEXT_TAIL = 6;
/**
 * The lossiest upstream fitting stage at which every entry is still readable:
 * inputs cut and long texts abridged, but nothing collapsed, one-lined or left
 * out. A state past it is split, and an entry that cannot be shown at it is not
 * asked about.
 */
export const MAX_READABLE_STAGE = 'texts abridged';
const STAGES = ['full', 'inputs<=200', 'inputs<=60', 'texts abridged'];

/** The output's head and tail, whitespace collapsed, within `chars`. */
export function preview(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= chars) return flat;
  const half = Math.floor(chars / 2);
  return `${flat.slice(0, half)} … ${flat.slice(flat.length - half)}`;
}

/** Upstream's three questions about a call, with the call and output questions reworded. */
export function callQuestions(call: ToolCall, output: string): JevQuestions {
  const questions = questionsFor(call);
  questions[`call_${call.id}`] = {
    type: 'noul',
    instructions: `Tool call ${call.id} (${call.tool}) carries information the current task still depends on: a file or command the assistant is working with, a decision, a constraint, or an edit that was made`,
  };
  questions[`result_${call.id}`] = {
    type: 'noul',
    instructions: `The output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) holds information the assistant would need again to continue the current task correctly, such as an error message, a value, file contents it is editing, or a constraint. Start and end of the output: ${preview(output, PREVIEW_CHARS)}`,
    criteria: { true: RESULT_TRUE, false: RESULT_FALSE },
  };
  return questions;
}
/** Upstream's allowance for the request envelope (`compaction/decision.ts`). */
const REQUEST_OVERHEAD_TOKENS = 20;

interface Group {
  segment: number;
  questions: JevQuestions;
  read(answers: Record<string, JevAnswer>): Verdict;
}

/** A probability, or undefined when the answer is missing, malformed or outside [0, 1]. */
function noul(answer: JevAnswer | undefined): number | undefined {
  return answer !== undefined &&
    'noul' in answer &&
    typeof answer.noul === 'number' &&
    Number.isFinite(answer.noul) &&
    answer.noul >= 0 &&
    answer.noul <= 1
    ? answer.noul
    : undefined;
}

/** Rebuilds vendored messages from the visible segments, remembering which segment each came from. */
function toMessages(segments: readonly Segment[], visible: readonly number[]) {
  const messages: Message[] = [];
  const textAt = new Map<number, number>();
  const callOf = new Map<string, number>();
  for (const index of visible) {
    const segment = segments[index]!;
    if (segment.kind === 'call') {
      const id = `s${index}`;
      const call = segment.call!;
      messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: call.tool, input: call.input }] });
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: call.result, isError: call.isError }] });
      callOf.set(id, index);
    } else {
      textAt.set(messages.length, index);
      messages.push(
        segment.kind === 'user' || segment.kind === 'context'
          ? { role: 'user', text: segment.text, toolUses: [], toolResults: [] }
          : { role: 'assistant', text: segment.text, toolUses: [] },
      );
    }
  }
  return { messages, textAt, callOf };
}

function batches(groups: Group[], stateTokens: number, maxRequestTokens: number): Group[][] {
  const room = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const out: Group[][] = [];
  let current: Group[] = [];
  let used = 0;
  for (const group of groups) {
    const tokens = estimateTokens(JSON.stringify(group.questions));
    if (tokens > room) {
      throw new Error(`Jev state leaves no room for questions (~${stateTokens} of ${maxRequestTokens} tokens)`);
    }
    if (current.length > 0 && used + tokens > room) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(group);
    used += tokens;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Upstream's fitted state, with our framing in place of upstream's and the token count following the swap. */
function fitted(messages: readonly Message[], calls: readonly ToolCall[], options: JudgeOptions): FittedState {
  const extra = Math.max(0, estimateTokens(STATE_FRAMING) - estimateTokens(STATE_CONTEXT));
  const state = fitState(messages, calls, {
    maxStateTokens: options.maxStateTokens - extra,
    preserveRecentMessages: 0,
    goal: options.goal,
  });
  return {
    ...state,
    state: { ...state.state, context: STATE_FRAMING },
    tokens: state.tokens - estimateTokens(STATE_CONTEXT) + estimateTokens(STATE_FRAMING),
  };
}

const readable = (stage: string): boolean => STAGES.includes(stage);

/** The window's segments plus the candidate's newest text, oldest first. */
function withTail(window: readonly number[], tail: readonly number[]): number[] {
  return [...new Set([...window, ...tail])].sort((a, b) => a - b);
}

/** True when one Jev state holds `window` and the tail with every entry readable. */
function fitsReadably(segments: readonly Segment[], window: readonly number[], tail: readonly number[], options: JudgeOptions): boolean {
  const { messages } = toMessages(segments, withTail(window, tail));
  try {
    return readable(fitted(messages, collectToolCalls(messages, 0), options).stage);
  } catch {
    return false;
  }
}

/**
 * Consecutive runs of `visible` that each fit one Jev state, together with the
 * candidate's newest text, with every entry readable: the whole list when it
 * does, else its halves, recursively. Past upstream's `texts abridged` stage the
 * fitting collapses, one-lines or leaves out the very entries being asked
 * about. A single segment is left whole; `judgeWindow` asks nothing about it if
 * it still cannot be shown readably.
 */
function stateWindows(segments: readonly Segment[], visible: readonly number[], tail: readonly number[], options: JudgeOptions): number[][] {
  if (visible.length <= 1 || fitsReadably(segments, visible, tail, options)) return [[...visible]];
  const middle = visible.length >> 1;
  return [
    ...stateWindows(segments, visible.slice(0, middle), tail, options),
    ...stateWindows(segments, visible.slice(middle), tail, options),
  ];
}

/**
 * Asks Jev about `targets`, with the `visible` segments (oldest first) as the
 * state, split into windows when one state cannot hold them all. Windows and
 * batches run concurrently, as upstream's batches do. Throws when the client
 * fails; the caller falls back.
 */
export async function judge(
  segments: readonly Segment[],
  visible: readonly number[],
  targets: readonly number[],
  options: JudgeOptions,
  asker: CoreAsker,
  round: JudgeRound,
): Promise<{ verdicts: Map<number, Verdict>; usage: JudgeUsage }> {
  const verdicts = new Map<number, Verdict>();
  const usage: JudgeUsage = { requests: 0, input: 0, output: 0 };
  if (targets.length === 0) return { verdicts, usage };
  const wanted = new Set(targets);
  // One goal for every window: derived once from the whole candidate, never per window.
  const shared = { ...options, goal: options.goal || goalFromMessages(toMessages(segments, visible).messages) };
  const tail = visible.filter(i => segments[i]!.kind !== 'call').slice(-CONTEXT_TAIL);
  const windows = stateWindows(segments, visible, tail, shared).filter(window => window.some(i => wanted.has(i)));
  // Batch numbers identify a request inside one invocation, so they run across every window.
  // Each window learns how many requests the windows before it will make and starts after them;
  // the windows themselves still run concurrently.
  const plans = windows.map(window => planWindow(segments, window, tail, window.filter(i => wanted.has(i)), shared));
  let batch = 0;
  const results = await Promise.all(
    plans.map(plan => {
      const first = batch;
      batch += plan?.planned.length ?? 0;
      return judgeWindow(plan, asker, round, first);
    }),
  );
  for (const result of results) {
    for (const [segment, verdict] of result.verdicts) verdicts.set(segment, verdict);
    usage.requests += result.usage.requests;
    usage.input += result.usage.input;
    usage.output += result.usage.output;
  }
  return { verdicts, usage };
}

/**
 * The requests one window will make, or an empty plan when its state cannot be shown
 * readably. Planning is pure, so the caller can number every window's batches before
 * any of them runs, and the window then sends exactly the plan it was numbered for.
 */
function planWindow(
  segments: readonly Segment[],
  window: readonly number[],
  tail: readonly number[],
  targets: readonly number[],
  options: JudgeOptions,
): { state: FittedState; planned: Group[][] } | undefined {
  const { messages, textAt, callOf } = toMessages(segments, withTail(window, tail));
  const calls = collectToolCalls(messages, 0);
  let state: FittedState;
  try {
    state = fitted(messages, calls, options);
  } catch {
    return undefined; // not even the lossiest stage fits: nothing is asked, everything keeps
  }
  if (!readable(state.stage)) return undefined;
  const wanted = new Set(targets);
  // fitState may leave old text out of the state; Jev is never asked about text it cannot see.
  const shown = new Set(state.state.history.map(entry => entry.i));
  const groups: Group[] = [];
  for (const call of calls) {
    const segment = callOf.get(call.tool_use_id);
    if (segment === undefined || !wanted.has(segment)) continue;
    const questions = callQuestions(call, segments[segment]!.call!.result);
    const suffix = `_${call.id}`;
    groups.push({
      segment,
      questions,
      read: answers => {
        const own: Record<string, JevAnswer> = {};
        for (const name of Object.keys(questions)) {
          const answer = answers[name];
          if (answer === undefined || !name.endsWith(suffix)) continue;
          // A malformed or out-of-range probability is dropped, so decideCall treats it as missing and keeps.
          if ('noul' in answer && noul(answer) === undefined) continue;
          own[`${name.slice(0, -suffix.length)}_${VERDICT_ID}`] = answer;
        }
        return { kind: 'call', answers: own };
      },
    });
  }
  for (const [messageIndex, segment] of textAt) {
    if (!wanted.has(segment) || !shown.has(messageIndex)) continue;
    const key = `keep_m${messageIndex}`;
    groups.push({
      segment,
      questions: {
        [key]: {
          type: 'noul',
          instructions: `History entry i=${messageIndex} (${segments[segment]!.kind} text) should stay in the history verbatim: its exact wording still matters for what the assistant does next`,
        },
      },
      read: answers => ({ kind: 'text', keep: noul(answers[key]) }),
    });
  }
  return { state, planned: batches(groups, state.tokens, options.maxRequestTokens) };
}

/**
 * One window: the window's segments and the candidate's newest text are the
 * state, and the window's targets are asked about. A window whose state cannot
 * be made readable asks nothing, so its targets keep. `batchStart` is the first
 * batch number of this window inside the whole invocation.
 */
async function judgeWindow(
  plan: { state: FittedState; planned: Group[][] } | undefined,
  asker: CoreAsker,
  round: JudgeRound,
  batchStart = 0,
): Promise<{ verdicts: Map<number, Verdict>; usage: JudgeUsage }> {
  const verdicts = new Map<number, Verdict>();
  const usage: JudgeUsage = { requests: 0, input: 0, output: 0 };
  if (plan === undefined) return { verdicts, usage };
  const { state, planned } = plan;
  const groups = planned.flat();
  const responses = await Promise.all(
    planned.map((batch, index) =>
      asker.ask(state.state, Object.assign({}, ...batch.map(group => group.questions)), { round, batch: batchStart + index }),
    ),
  );
  const answers: Record<string, JevAnswer> = {};
  for (const response of responses) {
    Object.assign(answers, response.answers);
    usage.requests += 1;
    usage.input += response.usage?.input_tokens ?? 0;
    usage.output += response.usage?.output_tokens ?? 0;
  }
  for (const group of groups) verdicts.set(group.segment, group.read(answers));
  return { verdicts, usage };
}

export interface StatusAt {
  status: SegmentStatus;
  /** Upstream's borderline staleness rescue kept a call that was under the threshold. */
  guarded: boolean;
}

/**
 * The status a verdict gives at `threshold`. For a call this is upstream's
 * `decideCall`, borderline staleness rescue included. A segment never asked
 * about, or with missing answers, keeps. `guarded` is true only when that
 * rescue is what kept it.
 */
export function statusAt(verdict: Verdict | undefined, threshold: number, borderline: number): StatusAt {
  if (verdict === undefined) return { status: 'keep', guarded: false };
  if (verdict.kind === 'text') {
    return { status: verdict.keep === undefined || verdict.keep >= threshold ? 'keep' : 'drop', guarded: false };
  }
  const decision = decideCall({ id: VERDICT_ID, tool: '' }, verdict.answers, {
    keepThreshold: threshold,
    borderline,
    boundary: false,
  });
  const status = decision.action === 'keep' ? 'keep' : decision.action === 'drop_result' ? 'truncate' : 'drop';
  return { status, guarded: decision.guarded };
}
