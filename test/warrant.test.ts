import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessWarrant, buildWarrantRequest, warrantEligibility, BOUNDARY_ID, BOUNDARY_CRITERIA, type WarrantCandidate, type WarrantParams, type WarrantSnapshot } from '../src/core/warrant.js';
import { validateLocalAnswers } from '../src/client/local-client.js';
import { loadDetectorConfig } from '../src/client/detector-config.js';
// The committed active calibration ships beside the monorepo config; a checkout without it
// (standalone tree, no detector config committed) has no calibration to assert about, so
// those checks skip.
const calibrationActive = loadDetectorConfig().mode === 'active';
import { callQuestions, RESULT_TRUE, RESULT_FALSE } from '../src/core/judge.js';
import { estimateTokens } from '../src/vendor/pi-jev/vendor/fast-jev-compaction/index.js';

// Synthetic policy values, not a production calibration or proposed operational defaults.
const params: WarrantParams = {
  mode: 'shadow', pressureFloor: 0.6, minCandidateTokens: 100, maxSampleTokens: 4000,
  minReclaimTokens: 500, minSafeBoundary: 0.8, minNetReductionTokens: 100,
  rearmGrowthTokens: 200, cooldownMs: 1000, failureBackoffMs: 2000,
  requestTimeoutMs: 3000, calibration: 'synthetic-test-only.json',
};
const candidate = (id: string, removableTokens = 1000, output = 'stored tool result'): WarrantCandidate => ({ id, removableTokens, output, tool: 'read', pinned: false });
const snapshot = (patch: Partial<WarrantSnapshot> = {}): WarrantSnapshot => ({
  leafEntryId: 'leaf', serviceModel: 'clm', tokens: 6000, contextWindow: 10000, modelKnown: true,
  compactionEnabled: true, compactionConfigValid: true, candidateAdapterCompatible: true,
  pendingInput: false, compactionRunning: false, attemptInFlight: false,
  lastAssessed: null, nowMs: 10000, lastCompactionMs: null, lastFailureMs: null,
  suppressedAtTokens: null, candidates: [candidate('call')], recentTail: 'The requested change is complete; tests passed.',
  boundaryEvidence: { lastOperatorRequest: { ordinal: 1, kind: 'message', role: 'user', blocks: [{ kind: 'text', text: 'Report completion.' }] }, responseAfterRequest: true, terminalAssistant: true, openCalls: [] },
  serviceQuestionLimit: 128, serviceInputTokenLimit: null, summarizedCallState: 'resolved', retainedCallState: 'resolved', ...patch,
});
const boundary = (safe = 0.8, live = 0.1, uncertain = 0.1) => {
  const probabilities = { safe, live, uncertain };
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: 'choice', choice, probabilities, confidence: 0.8 };
};
function answered(s = snapshot(), p = params, needed = 0.5, b: unknown = boundary()): WarrantSnapshot {
  const request = buildWarrantRequest(s, p);
  assert.ok(request);
  return { ...s, answers: { ...Object.fromEntries(request.samples.map(sample => [sample.questionId, { type: 'noul', noul: needed }])), [BOUNDARY_ID]: b } };
}

const gateCases: Array<[string, Partial<WarrantSnapshot>]> = [
  ['compaction_disabled', { compactionEnabled: false }],
  ['compaction_config_invalid', { compactionConfigValid: false }],
  ['model_unknown', { modelKnown: false }],
  ['context_window_unknown', { contextWindow: null }],
  ['context_window_unknown', { contextWindow: 0 }],
  ['context_window_unknown', { contextWindow: NaN }],
  ['context_window_unknown', { contextWindow: Infinity }],
  ['usage_unknown', { tokens: null }],
  ['usage_unknown', { tokens: NaN }],
  ['usage_unknown', { tokens: -1 }],
  ['usage_unknown', { tokens: Infinity }],
  ['snapshot_unknown', { leafEntryId: '' }],
  ['pending_input', { pendingInput: true }],
  ['compaction_running', { compactionRunning: true }],
  ['attempt_in_flight', { attemptInFlight: true }],
  ['same_snapshot', { lastAssessed: { leafEntryId: 'leaf', tokens: 6000 } }],
  ['cooldown', { lastCompactionMs: 9001 }],
  ['failure_backoff', { lastFailureMs: 8001 }],
  ['pressure_below_floor', { tokens: 5999 }],
  ['candidate_adapter_unavailable', { candidateAdapterCompatible: false }],
  ['too_little_candidate_content', { candidates: [candidate('small', 99)] }],
  ['too_little_candidate_content', { candidates: [{ ...candidate('pinned', 10000), pinned: true }] }],
  ['too_little_candidate_content', { candidates: [] }],
  ['candidate_content_unknown', { candidates: [candidate('broken', NaN)] }],
  ['candidate_content_unknown', { candidates: [candidate('duplicate'), candidate('duplicate')] }],
  ['candidate_content_unknown', { candidates: [candidate('a', Number.MAX_VALUE), candidate('b', Number.MAX_VALUE)] }],
  ['clock_unknown', { nowMs: NaN }],
  ['cooldown', { lastCompactionMs: 10001 }],
  ['failure_backoff', { lastFailureMs: NaN }],
];
for (const [reason, patch] of gateCases) {
  test(`eligibility defers: ${reason} (${JSON.stringify(patch)})`, () => {
    const s = { ...snapshot(patch), answers: {} };
    const result = assessWarrant(s, params);
    assert.equal(result.outcome, 'defer');
    assert.ok(result.reasons.includes(reason), JSON.stringify(result));
    assert.equal(result.score, 0);
    assert.equal(result.safeBoundary, null);
    assert.equal(result.actionTaken, 'none');
  });
}

test('off (including absent-config shape) does no semantic work; both enabled modes assess without acting', () => {
  const s = snapshot();
  Object.defineProperty(s, 'candidates', { get() { throw new Error('off must not read candidates'); } });
  assert.deepEqual(assessWarrant(s, { mode: 'off' }), { outcome: 'defer', reasons: ['mode_off'], score: 0, safeBoundary: null, mode: 'off', actionTaken: 'none' });
  for (const mode of ['shadow', 'active'] as const) {
    const p = { ...params, mode };
    const result = assessWarrant(answered(snapshot(), p), p);
    assert.equal(result.outcome, 'warranted');
    assert.equal(result.mode, mode);
    assert.equal(result.actionTaken, 'none');
  }
});

test('eligibility boundary equality passes; snapshot identity is the pair, not either half', () => {
  assert.deepEqual(warrantEligibility(snapshot({ lastCompactionMs: 9000, lastFailureMs: 8000, candidates: [candidate('exact', 100)] }), params), []);
  for (const lastAssessed of [{ leafEntryId: 'other', tokens: 6000 }, { leafEntryId: 'leaf', tokens: 5999 }]) {
    assert.deepEqual(warrantEligibility(snapshot({ lastAssessed }), params), []);
  }
  const s = snapshot({ pendingInput: true, compactionRunning: true, attemptInFlight: true });
  assert.deepEqual(warrantEligibility(s, params), ['pending_input', 'compaction_running', 'attempt_in_flight']);
});

test('one request: largest first, lexical ties, excludes pins, leaves inputs immutable, reuses output wording', () => {
  const s = snapshot({ candidates: [candidate('b', 700), { ...candidate('p', 9000), pinned: true }, candidate('a', 700), candidate('large', 1500)] });
  const before = structuredClone(s);
  const request = buildWarrantRequest(s, params)!;
  assert.deepEqual(request.samples.map(sample => sample.candidateId), ['large', 'a', 'b']);
  assert.equal(Object.keys(request.questions).length, 4);
  assert.deepEqual(request.questions[BOUNDARY_ID].criteria, BOUNDARY_CRITERIA);
  assert.deepEqual(request.questions.result_s0, callQuestions({ id: 's0', tool: 'read', resultChars: 'stored tool result'.length } as Parameters<typeof callQuestions>[0], 'stored tool result').result_s0);
  assert.deepEqual(request.questions.result_s0.criteria, { true: RESULT_TRUE, false: RESULT_FALSE });
  assert.equal(request.tokens, estimateTokens(JSON.stringify({ model: s.serviceModel, state: request.state, questions: request.questions })));
  assert.deepEqual(s, before);
  assert.deepEqual(buildWarrantRequest({ ...s, candidates: [...s.candidates].reverse() }, params), request);
});

test('service limit includes the reserved boundary; no spill into a second request', () => {
  const s = snapshot({ candidates: Array.from({ length: 150 }, (_, i) => candidate(`c${i}`)), serviceQuestionLimit: 128 });
  const p = { ...params, maxSampleTokens: 100000 };
  assert.equal(Object.keys(buildWarrantRequest(s, p)!.questions).length, 128);
  assert.equal(buildWarrantRequest(s, p)!.samples.length, 127);
  assert.equal(buildWarrantRequest({ ...s, serviceQuestionLimit: 3 }, p)!.samples.length, 2);
  for (const serviceQuestionLimit of [0, 1, -1, 1.5, Infinity, NaN]) assert.equal(buildWarrantRequest({ ...s, serviceQuestionLimit }, p), undefined);
});

test('samples are intact or absent: a live dependency past any prefix is never partially rendered', () => {
  const live = 'neutral padding line\n'.repeat(3000) + 'LIVE: awaiting approval, this output is still required.';
  const s = snapshot({ candidates: [candidate('long', 100000, live), candidate('small', 50, 'short obsolete output')] });
  const p = { ...params, maxSampleTokens: 1500, minReclaimTokens: 1 };
  const request = buildWarrantRequest(s, p)!;
  assert.ok(request.tokens <= p.maxSampleTokens);
  assert.ok(request.state.outputs.every(o => !o.truncated && !/chars omitted/.test(o.output)));
  assert.ok(!JSON.stringify(request.state).includes('neutral padding'), 'no prefix of the oversized output is shown');
  assert.deepEqual(request.samples.map(x => [x.candidateId, x.truncated, x.omittedTokens]), [['small', false, 0]]);
  // Only the oversized live output: nothing intact fits, so it defers even with forged safe answers.
  const only = snapshot({ candidates: [candidate('long', 100000, live)] });
  assert.equal(buildWarrantRequest(only, p), undefined);
  const forged = { ...only, answers: { boundary: boundary(1, 0, 0), result_s0: { type: 'noul', noul: 0 } } };
  assert.equal(assessWarrant(forged, p).outcome, 'defer');
  // A prebuilt plan carrying a truncated sample is refused before scoring.
  const bad = structuredClone(request); bad.state.outputs[0]!.truncated = true; (bad.samples[0] as any).truncated = true;
  const answers = { boundary: boundary(1, 0, 0), [bad.samples[0]!.questionId]: { type: 'noul', noul: 0 } };
  assert.deepEqual(assessWarrant({ ...s, answers }, p, bad).reasons, ['sample_content_truncated']);
});

test('a too-small budget or missing/oversize recent tail defers instead of truncating task state', () => {
  for (const s of [snapshot(), snapshot({ recentTail: '' }), snapshot({ recentTail: 'tail '.repeat(10000) })]) {
    const p = { ...params, maxSampleTokens: 100 };
    assert.equal(buildWarrantRequest(s, p), undefined);
    assert.deepEqual(assessWarrant(s, p).reasons, ['sample_bounds']);
  }
  assert.equal(assessWarrant(snapshot(), params).outcome, 'defer', 'eligible but not answered');
});

test('unsampled content counts zero even when it could make the full pool exceed the reclaim floor', () => {
  const s = snapshot({ candidates: [candidate('a', 1000), candidate('b', 99999)], serviceQuestionLimit: 2 });
  const request = buildWarrantRequest(s, params)!;
  assert.deepEqual(request.samples.map(sample => sample.candidateId), ['b']);
  const result = assessWarrant(answered(s, params, 1), params);
  assert.equal(result.score, 0);
  assert.equal(result.outcome, 'suppress');
});

test('score sums sampled removable tokens weighted by one minus needed probability', () => {
  const s = snapshot({ candidates: [candidate('a', 1000), candidate('b', 800)] });
  const result = assessWarrant({ ...s, answers: { result_s0: { noul: 0.5 }, result_s1: { noul: 0.25 }, boundary: boundary() } }, params);
  assert.equal(result.score, 1100);
  assert.equal(result.outcome, 'warranted');
});

test('score and safe-boundary thresholds are inclusive; low score suppresses, unsafe boundary defers', () => {
  assert.equal(assessWarrant(answered(), params).outcome, 'warranted', 'score=500 and safe=0.8');
  assert.equal(assessWarrant(answered(snapshot(), params, 0.5001), params).outcome, 'suppress');
  assert.equal(assessWarrant(answered(snapshot(), params, 0.4999), params).outcome, 'warranted');
  assert.equal(assessWarrant(answered(snapshot(), params, 0.5, boundary(0.7999, 0.1001, 0.1)), params).outcome, 'defer');
  assert.equal(assessWarrant(answered(snapshot(), params, 0.5, boundary(0.9, 0.05, 0.05)), params).outcome, 'warranted');
  assert.equal(assessWarrant(answered(snapshot(), params, 0.5, boundary(0.1, 0.8, 0.1)), params).outcome, 'defer');
  assert.equal(assessWarrant(answered(snapshot(), params, 1, boundary(0.1, 0.8, 0.1)), params).outcome, 'suppress');
  for (const needed of [0, 1]) assert.equal(assessWarrant(answered(snapshot(), params, needed), params).score, 1000 * (1 - needed));
});

test('suppress re-arms only at growth equality; shrinking or new leaf alone cannot re-arm', () => {
  for (const tokens of [5999, 6000, 6199]) {
    const s = snapshot({ leafEntryId: 'new-leaf', tokens, suppressedAtTokens: 6000 });
    const p = { ...params, pressureFloor: 0.5 };
    const result = assessWarrant(s, p);
    assert.equal(result.outcome, 'suppress');
    assert.deepEqual(result.reasons, ['rearm_growth_pending']);
  }
  for (const tokens of [6200, 6201]) {
    assert.equal(assessWarrant(answered(snapshot({ tokens, suppressedAtTokens: 6000 })), params).outcome, 'warranted');
  }
  assert.equal(assessWarrant(snapshot({ suppressedAtTokens: NaN }), params).outcome, 'defer');
  assert.equal(assessWarrant(snapshot({ suppressedAtTokens: 6000, pendingInput: true }), params).outcome, 'defer', 'stage 1 precedes suppression');
});

const badNeeded: unknown[] = [undefined, null, false, '0', {}, { noul: '0' }, { noul: NaN }, { noul: Infinity }, { noul: -0.1 }, { noul: 1.1 }, { type: 'choice', noul: 0 }, { noul: 0, choice: 'safe' }, { noul: 0, score: 0 }];
for (const [i, value] of badNeeded.entries()) test(`malformed output answer ${i} defers (never low-score suppress)`, () => {
  const s = answered();
  (s.answers as Record<string, unknown>).result_s0 = value;
  assert.equal(assessWarrant(s, params).outcome, 'defer');
});

const badBoundary: unknown[] = [
  undefined, null, 'safe', {}, { noul: 1 }, { ...boundary(), type: 'noul' },
  { ...boundary(), choice: 'unknown' }, { ...boundary(), choice: 'live' },
  { ...boundary(), probabilities: { safe: 1 } },
  { ...boundary(), probabilities: { safe: 0.8, live: 0.1, uncertain: 0.1, extra: 0 } },
  { ...boundary(), probabilities: { safe: 0.8, live: 0.1, uncertain: NaN } },
  { ...boundary(), probabilities: { safe: 1.1, live: -0.1, uncertain: 0 } },
  { ...boundary(), probabilities: { safe: 0.8, live: 0.1, uncertain: 0.2 } },
  { ...boundary(), confidence: NaN }, { ...boundary(), noul: 1 }, { ...boundary(), score: 0 },
  boundary(0.5, 0.5, 0), boundary(0.1, 0.1, 0.8),
];
for (const [i, value] of badBoundary.entries()) test(`malformed/ambiguous boundary ${i} defers even at zero score`, () => {
  const s = answered(snapshot(), params, 1);
  (s.answers as Record<string, unknown>)[BOUNDARY_ID] = value;
  assert.equal(assessWarrant(s, params).outcome, 'defer');
});

test('incomplete, extra, or non-record answer sets defer; no mutation and identical results', () => {
  for (const answers of [undefined, null, [], 'answers', {}, { boundary: boundary() }, { ...answered().answers as object, extra: { noul: 0 } }]) {
    assert.equal(assessWarrant(snapshot({ answers }), params).outcome, 'defer');
  }
  const s = answered();
  const before = structuredClone(s);
  const p = structuredClone(params);
  assert.deepEqual(assessWarrant(s, params), assessWarrant(s, params));
  assert.deepEqual(s, before);
  assert.deepEqual(params, p);
});

// Choice wire shape from local-client.test.ts (0.8/0.2 with confidence 0.6),
// mapped to this rubric; confidence is a service field, not a derived contract.
test('service choice answers accept independent finite confidence in [0,1]', () => {
  for (const confidence of [0, 0.6, 0.8, 1]) {
    const answer = { type: 'choice', choice: 'safe', confidence, probabilities: { safe: 0.8, live: 0.2, uncertain: 0 } };
    assert.equal(assessWarrant(answered(snapshot(), params, 0, answer), params).outcome, 'warranted');
  }
});

test('boundary probability sum uses local-client tolerance; uncertain and ties still defer', () => {
  for (const [delta, expected] of [[0.000009, 'warranted'], [0.000011, 'defer']] as const) {
    const answer = { type: 'choice', choice: 'safe', confidence: 0.8, probabilities: { safe: 0.8, live: 0.2 + delta, uncertain: 0 } };
    assert.equal(assessWarrant(answered(snapshot(), params, 0, answer), params).outcome, expected);
  }
  for (const needed of [0, 1]) {
    assert.deepEqual(assessWarrant(answered(snapshot(), params, needed, boundary(0.1, 0.1, 0.8)), params).reasons, ['boundary_uncertain']);
    assert.deepEqual(assessWarrant(answered(snapshot(), params, needed, boundary(0.5, 0.5, 0)), params).reasons, ['boundary_malformed_or_ambiguous']);
  }
});

test('sample budget includes model and envelope, including exact-fit and escaped model names', () => {
  const s = snapshot({ candidates: [candidate('a', 1000, 'x')], serviceModel: 'model "\\'.repeat(100) });
  const full = buildWarrantRequest(s, { ...params, maxSampleTokens: 10000 })!;
  const whole = estimateTokens(JSON.stringify({ model: s.serviceModel, state: full.state, questions: full.questions }));
  const partial = estimateTokens(JSON.stringify({ state: full.state, questions: full.questions }));
  assert.ok(whole > partial);
  assert.equal(full.tokens, whole);
  assert.ok(buildWarrantRequest(s, { ...params, maxSampleTokens: whole }));
  assert.ok(!buildWarrantRequest(s, { ...params, maxSampleTokens: partial }) || buildWarrantRequest(s, { ...params, maxSampleTokens: partial })!.tokens <= partial);
  assert.ok(!buildWarrantRequest(s, { ...params, maxSampleTokens: whole - 1 }) || buildWarrantRequest(s, { ...params, maxSampleTokens: whole - 1 })!.tokens <= whole - 1);
  assert.equal(buildWarrantRequest({ ...s, serviceModel: '' }, params), undefined);
});


test('boundary distribution checks agree with the existing service client', () => {
  const s = snapshot();
  const question = { boundary: buildWarrantRequest(s, params)!.questions.boundary };
  const valid = { type: 'choice', choice: 'safe', confidence: 0.6, probabilities: { safe: 0.8, live: 0.2, uncertain: 0 } };
  for (const answer of [valid, { ...valid, confidence: 1 }, { ...valid, probabilities: { safe: 0.8, live: 0.200009, uncertain: 0 } }]) {
    assert.ok(validateLocalAnswers({ model: 'clm', answers: { boundary: answer } }, question, 'clm'));
    assert.equal(assessWarrant(answered(s, params, 0, answer), params).outcome, 'warranted');
  }
  for (const answer of [
    { ...valid, confidence: -1 }, { ...valid, confidence: 1.1 }, { ...valid, confidence: Infinity },
    { ...valid, confidence: undefined }, { ...valid, confidence: '0.6' },
    { ...valid, probabilities: { safe: 0.8, live: 0.200011, uncertain: 0 } },
    { ...valid, probabilities: { safe: 0.8, live: 0.2 } },
    { ...valid, choice: 'live' },
  ]) {
    assert.throws(() => validateLocalAnswers({ model: 'clm', answers: { boundary: answer } }, question, 'clm'));
    assert.deepEqual(assessWarrant(answered(s, params, 0, answer), params).reasons, ['boundary_malformed_or_ambiguous']);
  }
});


test('assessment returns its exact request plan and answer validation reuses it without rendering again', () => {
  let reads = 0;
  const s = snapshot(); Object.defineProperty(s, 'recentTail', { get() { reads++; return 'complete task'; } });
  const gate = assessWarrant(s, params); assert.deepEqual(gate.reasons, ['answers_missing']); assert.ok(gate.request);
  const before = reads;
  s.answers = { boundary: boundary(), ...Object.fromEntries(gate.request.samples.map(sample => [sample.questionId, { noul: 0 }])) };
  assert.equal(assessWarrant(s, params, gate.request).outcome, 'warranted');
  assert.equal(reads, before, 'post-answer assessment must not render or fit the request again');
  s.pendingInput = true; assert.ok(assessWarrant(s, params, gate.request).reasons.includes('pending_input'));
});

test('rejects unreachable reclaim configuration, rather than silently suppressing every answer', () => {
  const p = { ...params, maxSampleTokens: 30000, minCandidateTokens: 69077, minReclaimTokens: 50151 };
  const s = snapshot({ candidates: [candidate('actual', 70000, 'x'.repeat(280000)), candidate('fits', 1000, 'y'.repeat(4000))] });
  const result = assessWarrant(answered(s, p, 0, boundary(1, 0, 0)), p);
  assert.equal(result.outcome, 'defer');
  assert.ok(result.reasons.includes('reclaim_threshold_unattainable'));
});

test('committed active calibration is reachable with valid favourable answers and actual candidate text', { skip: !calibrationActive }, async () => {
  const { loadDetectorConfig } = await import('../src/client/detector-config.js');
  const p = loadDetectorConfig(); assert.equal(p.mode, 'active');
  assert.ok('minCandidateTokens' in p); const calibrated = p as WarrantParams;
  const output = 'Obsolete successful inspection; final verification superseded this output. '.repeat(Math.ceil(calibrated.minCandidateTokens * 4 / 70));
  const s = snapshot({ tokens: Math.ceil(calibrated.pressureFloor * 936000), contextWindow: 936000,
    candidates: [candidate('actual-output', Math.ceil(output.length / 4), output)] });
  const plan = buildWarrantRequest(s, calibrated)!; assert.ok(plan);
  assert.ok(plan.samples.reduce((n, x) => n + x.removableTokens, 0) >= calibrated.minReclaimTokens);
  const result = assessWarrant(answered(s, calibrated, 0, boundary(1, 0, 0)), calibrated);
  assert.equal(result.outcome, 'warranted');
});

test('committed rearm growth is a context-growth quantity, independent of the reduction minimum', { skip: !calibrationActive }, async () => {
  const { loadDetectorConfig } = await import('../src/client/detector-config.js');
  const p = loadDetectorConfig() as WarrantParams; assert.ok('rearmGrowthTokens' in p);
  // Fitted from recorder settled-context growth, not from predicted compaction benefit.
  assert.notEqual(p.rearmGrowthTokens, p.minNetReductionTokens);
  // Growth since suppression must exceed one full assessment request, or every settle past cooldown re-dispatches.
  assert.ok(p.rearmGrowthTokens > p.maxSampleTokens);
  const output = 'Obsolete successful inspection; final verification superseded this output. '.repeat(Math.ceil(p.minCandidateTokens * 4 / 70));
  const base = Math.ceil(p.pressureFloor * 936000);
  const at = (growth: number) => snapshot({ tokens: base + growth, contextWindow: 936000, suppressedAtTokens: base,
    candidates: [candidate('actual-output', Math.ceil(output.length / 4), output)] });
  assert.deepEqual(assessWarrant(at(p.rearmGrowthTokens - 1), p).reasons, ['rearm_growth_pending']);
  assert.deepEqual(assessWarrant(at(p.rearmGrowthTokens), p).reasons, ['answers_missing'], 'reassessed once growth reached');
});

test('committed min_safe_boundary clears every repeated adversarial live score by max(spread, 0.02), and keeps the implicit controls', { skip: !calibrationActive }, async () => {
  const { loadDetectorConfig } = await import('../src/client/detector-config.js');
  const { readFileSync } = await import('node:fs');
  const p = loadDetectorConfig() as WarrantParams;
  const ev = JSON.parse(readFileSync(new URL('../eval/warrant/calibration-active-repair.json', import.meta.url), 'utf8')).refit2.adversarialRepeats;
  assert.ok(ev.runs >= 5);
  for (const tier of Object.values(ev.tiers) as any[]) {
    assert.equal(tier.transportFailures, 0);
    if (tier.maxLiveSafe === null) continue;
    assert.ok(p.minSafeBoundary >= tier.maxLiveSafe + Math.max(tier.maxPerCaseSpread, 0.02), `margin over live ${tier.maxLiveSafe}`);
  }
  assert.ok(ev.tiers.implicit.minControlSafe >= p.minSafeBoundary, 'implicit controls still warrant');
});

test('committed rearm growth is reachable on the smallest supported context window', { skip: !calibrationActive }, async () => {
  const { loadDetectorConfig } = await import('../src/client/detector-config.js');
  const p = loadDetectorConfig() as WarrantParams;
  const smallest = 262144; // smallest contextWindow among configured models (~/.config/agent/models.json)
  assert.ok(p.rearmGrowthTokens < (1 - p.pressureFloor) * smallest);
});

test('controller opportunity replaces only window ratio and urgency retains failure backoff',()=>{
 const s=snapshot({tokens:1,contextWindow:1000000,opportunity:true,urgent:true,lastCompactionMs:0,nowMs:1,lastFailureMs:0} as any);
 const reasons=warrantEligibility(s,params);
 assert.ok(!reasons.includes('pressure_below_floor'));assert.ok(!reasons.includes('cooldown'));assert.ok(reasons.includes('failure_backoff'));
});
