import { TAIL_PROFILE, type BoundaryEvidence, type TailEntry, type CallState } from './tail.js';
import { readChoiceAnswer } from './choice-answer.js';
import { callQuestions, STATE_FRAMING } from './judge.js';
import { estimateTokens, type JevQuestions } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';

export type DetectorMode = 'off' | 'shadow' | 'active';

/** All operational values come from detector config; the policy has no tuned defaults. */
export interface WarrantParams {
  mode: DetectorMode;
  pressureFloor: number;
  minCandidateTokens: number;
  maxSampleTokens: number;
  minReclaimTokens: number;
  minSafeBoundary: number;
  minNetReductionTokens: number;
  rearmGrowthTokens: number;
  cooldownMs: number;
  failureBackoffMs: number;
  requestTimeoutMs: number;
  calibration: string;
}

export type DetectorConfig = WarrantParams | { mode: 'off' };

/** Only tool results in the native preparation's candidate span belong here. */
export interface WarrantCandidate {
  /** Unique stable entry/call identity, also used as the lexical tie-break. */
  id: string;
  tool: string;
  output: string;
  removableTokens: number;
  pinned: boolean;
}

export interface SnapshotIdentity {
  leafEntryId: string;
  tokens: number;
}

/** The adapter owns freshness and scopes history to the current session/model/config. */
export interface WarrantSnapshot {
  opportunity?: boolean;
  urgent?: boolean;
  terminalSuppression?: boolean;
  leafEntryId: string;
  tokens: number | null;
  contextWindow: number | null;
  modelKnown: boolean;
  /** Effective service model from the asker config, for whole-envelope accounting. */
  serviceModel: string;
  compactionEnabled: boolean;
  compactionConfigValid: boolean;
  /** Missing/incompatible native preparation must fail closed. */
  candidateAdapterCompatible: boolean;
  pendingInput: boolean;
  compactionRunning: boolean;
  attemptInFlight: boolean;
  lastAssessed: SnapshotIdentity | null;
  nowMs: number;
  lastCompactionMs: number | null;
  lastFailureMs: number | null;
  /** Token count at the last low-score assessment; not reset by a held suppression. */
  suppressedAtTokens: number | null;
  candidates: readonly WarrantCandidate[];
  /** Immutable source records, oldest first. String is the intact comparison arm only. */
  recentTail: string;
  tailEntries?: readonly TailEntry[];
  boundaryEvidence?: BoundaryEvidence;
  summarizedCallState: CallState;
  retainedCallState: CallState;
  serviceInputTokenLimit: number | null;
  /** Supplied by the service adapter, not a second operational default. */
  serviceQuestionLimit: number;
  /** Answers to buildWarrantRequest for this exact immutable snapshot, when available. */
  answers?: unknown;
}

export interface WarrantResult {
  outcome: 'warranted' | 'defer' | 'suppress';
  reasons: string[];
  score: number;
  safeBoundary: number | null;
  mode: DetectorMode;
  /** Assessment never compacts or performs any other action, even in active mode. */
  actionTaken: 'none';
  /** Exact plan returned only for answers_missing; private, never assessment telemetry. */
  request?: WarrantRequest;
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const probability = (n: unknown): n is number => count(n) && n <= 1;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const candidatesOf = (snapshot: WarrantSnapshot) => snapshot.candidates.filter(c => !c.pinned);

/** Stage 1: ordered reasons, with no request construction or semantic work. */
export function warrantEligibility(snapshot: WarrantSnapshot, params: DetectorConfig): string[] {
  if (params.mode === 'off') return ['mode_off'];
  // An off-only config is narrowed here; enabled modes always carry every parameter.
  const p = params as WarrantParams;
  const reasons: string[] = [];
  if (!snapshot.compactionEnabled) reasons.push('compaction_disabled');
  if (!snapshot.compactionConfigValid) reasons.push('compaction_config_invalid');
  if (!snapshot.modelKnown) reasons.push('model_unknown');
  if (!count(snapshot.contextWindow) || snapshot.contextWindow === 0) reasons.push('context_window_unknown');
  if (!count(snapshot.tokens)) reasons.push('usage_unknown');
  if (!snapshot.leafEntryId) reasons.push('snapshot_unknown');
  if (snapshot.pendingInput) reasons.push('pending_input');
  if (snapshot.compactionRunning) reasons.push('compaction_running');
  if (snapshot.attemptInFlight) reasons.push('attempt_in_flight');
  if (snapshot.lastAssessed?.leafEntryId === snapshot.leafEntryId && snapshot.lastAssessed.tokens === snapshot.tokens) reasons.push('same_snapshot');
  if (!count(snapshot.nowMs)) reasons.push('clock_unknown');
  for (const [last, interval, reason] of [
    [snapshot.lastCompactionMs, p.cooldownMs, 'cooldown'],
    [snapshot.lastFailureMs, p.failureBackoffMs, 'failure_backoff'],
  ] as const) {
    if (reason === 'cooldown' && snapshot.urgent) continue;
    if (last !== null && (!count(last) || snapshot.nowMs - last < interval)) reasons.push(reason);
  }
  if (snapshot.opportunity === false) reasons.push('below_opportunity');
  if (snapshot.opportunity === undefined && count(snapshot.tokens) && count(snapshot.contextWindow) && snapshot.contextWindow > 0 && snapshot.tokens / snapshot.contextWindow < p.pressureFloor) reasons.push('pressure_below_floor');
  if (!snapshot.candidateAdapterCompatible) reasons.push('candidate_adapter_unavailable');
  if (snapshot.summarizedCallState === 'unresolved') reasons.push('unresolved_summarized_call');
  else if (snapshot.summarizedCallState !== 'resolved') reasons.push('summarized_call_state_unknown');
  if (snapshot.retainedCallState === 'unresolved') reasons.push('unresolved_retained_call');
  else if (snapshot.retainedCallState !== 'resolved') reasons.push('retained_call_state_unknown');
  const candidates = candidatesOf(snapshot);
  const candidateTokens = candidates.reduce((sum, c) => sum + c.removableTokens, 0);
  if (candidates.some(c => !c.id || !count(c.removableTokens)) || !count(candidateTokens) || new Set(candidates.map(c => c.id)).size !== candidates.length) reasons.push('candidate_content_unknown');
  else if (candidateTokens < p.minCandidateTokens) reasons.push('too_little_candidate_content');
  return reasons;
}

export const BOUNDARY_ID = 'boundary';
export const BOUNDARY_CRITERIA = {
  safe: 'A safe stopping point: no live unresolved task state would be lost by compacting the earlier candidate span.',
  live: 'Live unresolved task state is present: an unfinished operation, investigation, dependency or decision still needs the earlier context.',
  uncertain: 'The available recent tail is insufficient or ambiguous; a safe stopping point cannot be established.',
} as const;

export interface WarrantRequest {
  state: { context: string; recent_tail: string; outputs: Array<{ id: string; tool: string; output: string; truncated: boolean }> };
  questions: JevQuestions;
  samples: Array<{ candidateId: string; questionId: string; removableTokens: number; truncated: boolean; omittedTokens: number }>;
  /** Complete encoded {model, state, questions} estimate, including every envelope key. */
  tokens: number;
  tailStage: number | null;
  serviceLimitKnown: boolean;
  inputBound: number;
}

export const BOUNDARY_INSTRUCTIONS = 'The complete retained boundary and last operator request are provided, along with structural response and pending-work evidence. responseAfterRequest means a terminal response exists, NOT that the request was satisfied. Is compacting the earlier candidate span safe, live, or uncertain? Choose uncertain whenever omitted or unavailable earlier candidate content could hold live unresolved task state or a dependency on earlier context. A paired result does not establish task completion. Live pending work, awaiting approval, unfinished investigations and unanswered operator requests are not safe. Inspect the full request and response, not just the final sentence. Sampled outputs are shown complete; unsampled candidates are not evidence of completion.';

/** No lossy boundary profile can certify safety. Unknown evidence fails closed. */
export function tailAdequacy(snapshot: WarrantSnapshot): string[] {
  const e = snapshot.boundaryEvidence;
  if (!e || !e.lastOperatorRequest || !e.terminalAssistant || !e.responseAfterRequest) return ['boundary_evidence_unknown'];
  if (e.openCalls.length) return ['boundary_open_calls'];
  const entries = [...(snapshot.tailEntries ?? []), e.lastOperatorRequest];
  if (entries.some(entry => !entry.blocks.length || entry.blocks.some(b => b.unavailable || b.ambiguous || b.unresolved))) return ['boundary_content_unavailable'];
  return [];
}

/** Complete profiles rebuilt from immutable source. Never drop records or lower floors. */
export function buildWarrantRequest(snapshot: WarrantSnapshot, params: WarrantParams): WarrantRequest | undefined {
  if (!Number.isSafeInteger(snapshot.serviceQuestionLimit) || snapshot.serviceQuestionLimit < 2 || !snapshot.serviceModel?.trim()) return undefined;
  const known = Number.isSafeInteger(snapshot.serviceInputTokenLimit) && snapshot.serviceInputTokenLimit! > 0;
  const bound = known ? Math.min(params.maxSampleTokens, snapshot.serviceInputTokenLimit!) : params.maxSampleTokens;
  if (tailAdequacy(snapshot).length) return undefined;
  if (snapshot.tailEntries ? !snapshot.tailEntries.length : !snapshot.recentTail.trim()) return undefined;
  const tail = JSON.stringify({ representation: TAIL_PROFILE, evidence: snapshot.boundaryEvidence,
    pendingInput: snapshot.pendingInput, pendingWork: snapshot.compactionRunning,
    ...(snapshot.tailEntries ? { entries: snapshot.tailEntries } : { intactTail: snapshot.recentTail }) });
  const plan = fitWarrantRequest(snapshot, tail, bound, known);
  return plan ? { ...plan, tailStage: null, serviceLimitKnown: known, inputBound: bound } : undefined;
}
function fitWarrantRequest(snapshot: WarrantSnapshot, tail: string, bound: number, known: boolean): Omit<WarrantRequest, 'tailStage' | 'serviceLimitKnown' | 'inputBound'> | undefined {
  const state: WarrantRequest['state'] = { context: `${STATE_FRAMING}\nBoundary representation ${TAIL_PROFILE}; service input bound ${known ? bound : 'unknown (configured bound ' + bound + ')'}; model ${snapshot.serviceModel}.`, recent_tail: tail, outputs: [] };
  const questions: JevQuestions = {
    [BOUNDARY_ID]: { type: 'choice', instructions: BOUNDARY_INSTRUCTIONS, criteria: { ...BOUNDARY_CRITERIA } },
  };
  const samples: WarrantRequest['samples'] = [];
  const tokens = () => estimateTokens(JSON.stringify({ model: snapshot.serviceModel, state, questions }));
  if (tokens() > bound) return undefined;
  const candidates = candidatesOf(snapshot).filter(c => c.removableTokens > 0 && c.output.length > 0).sort((a, b) => b.removableTokens - a.removableTokens || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const candidate of candidates) {
    if (Object.keys(questions).length >= snapshot.serviceQuestionLimit) break;
    // Samples are intact or absent. A truncated prefix could hide a live dependency in its
    // omitted remainder, and the boundary answer is not conservative about omissions.
    const id = `s${samples.length}`, questionId = `result_${id}`;
    state.outputs.push({ id, tool: candidate.tool, output: candidate.output, truncated: false });
    questions[questionId] = callQuestions({ id, tool_use_id: candidate.id, tool: candidate.tool, input: {},
      callIndex: 0, resultIndex: 0, resultChars: Array.from(candidate.output).length, isError: false, pinned: false }, candidate.output)[questionId]!;
    if (tokens() > bound) { state.outputs.pop(); delete questions[questionId]; continue; }
    samples.push({ candidateId: candidate.id, questionId, removableTokens: candidate.removableTokens, truncated: false, omittedTokens: 0 });
  }
  return samples.length > 0 ? { state, questions, samples, tokens: tokens() } : undefined;
}

/** Shared service validation first; detector ties remain ambiguous. */
function boundaryProbability(answer: unknown): { safe: number; choice: string } | undefined {
  if (!record(answer) || 'noul' in answer || 'score' in answer) return undefined;
  const read = readChoiceAnswer(answer, BOUNDARY_CRITERIA);
  if (!read) return undefined;
  const top = Math.max(...Object.values(read.probabilities));
  const winners = Object.keys(read.probabilities).filter(label => read.probabilities[label] === top);
  if (winners.length !== 1 || read.choice !== winners[0]) return undefined;
  return { safe: read.probabilities.safe!, choice: read.choice };
}

/** Pure assessment. A caller supplies answers after asking the deterministic plan once. */
export function assessWarrant(snapshot: WarrantSnapshot, params: DetectorConfig, prebuilt?: WarrantRequest): WarrantResult {
  const result = (outcome: WarrantResult['outcome'], reasons: string[], score = 0, safeBoundary: number | null = null): WarrantResult => ({ outcome, reasons, score, safeBoundary, mode: params.mode, actionTaken: 'none' });
  const reasons = warrantEligibility(snapshot, params);
  if (reasons.length > 0) return result('defer', reasons);
  const p = params as WarrantParams;
  const adequacy = tailAdequacy(snapshot);
  if (adequacy.length) return result('defer', adequacy);
  if ((!snapshot.urgent || snapshot.terminalSuppression) && snapshot.suppressedAtTokens !== null) {
    if (!count(snapshot.suppressedAtTokens)) return result('defer', ['suppression_unknown']);
    if (snapshot.tokens! - snapshot.suppressedAtTokens < p.rearmGrowthTokens) return result('suppress', ['rearm_growth_pending']);
  }
  // Reuse only for answers to this exact immutable snapshot/params; eligibility still runs.
  const request = prebuilt ?? buildWarrantRequest(snapshot, p);
  if (!request) return result('defer', ['sample_bounds']);
  if (request.samples.some(s => s.truncated !== false || s.omittedTokens !== 0) || request.state.outputs.some(o => o.truncated !== false)) return result('defer', ['sample_content_truncated']);
  if (request.samples.reduce((n, s) => n + s.removableTokens, 0) < p.minReclaimTokens) return result('defer', ['reclaim_threshold_unattainable']);
  if (!record(snapshot.answers)) return { ...result('defer', ['answers_missing']), request };
  const answers = snapshot.answers;
  if (Object.keys(answers).length !== Object.keys(request.questions).length || Object.keys(answers).some(id => !Object.hasOwn(request.questions, id))) return result('defer', ['answers_malformed']);
  const boundary = boundaryProbability(answers[BOUNDARY_ID]);
  if (!boundary) return result('defer', ['boundary_malformed_or_ambiguous']);
  let score = 0;
  for (const sample of request.samples) {
    const answer = answers[sample.questionId];
    if (!record(answer) || (answer.type !== undefined && answer.type !== 'noul') || 'choice' in answer || 'score' in answer || !probability(answer.noul)) return result('defer', ['answers_malformed']);
    score += sample.removableTokens * (1 - answer.noul);
  }
  if (boundary.choice === 'uncertain') return result('defer', ['boundary_uncertain'], score, boundary.safe);
  if (score < p.minReclaimTokens) return result('suppress', ['score_below_minimum'], score, boundary.safe);
  if (boundary.choice !== 'safe' || boundary.safe < p.minSafeBoundary) return result('defer', ['boundary_not_safe'], score, boundary.safe);
  return result('warranted', ['reclaim_and_boundary_met'], score, boundary.safe);
}
