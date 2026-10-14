import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abridge, capturedTail, renderTail, stableJSON } from '../src/core/tail.js';
import { assessWarrant, buildWarrantRequest, BOUNDARY_INSTRUCTIONS, type WarrantParams, type WarrantSnapshot } from '../src/core/warrant.js';
import { detectorInputLimit } from '../src/pi/detector.js';
import { loadConfig } from '../src/client/config.js';
const call = (id = 'call') => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { b: 2, a: '😀'.repeat(2000) } }] });
const result = (id = 'call') => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: '😀'.repeat(2000) }], isError: false });
const entry = (message: any, id: string) => ({ type: 'message', id, message: { ...(message.role === 'assistant' ? { stopReason: 'stop' } : {}), ...message } });
const preparation = (messages: any[], kept = 'tail', prefix: any[] = []) => ({ firstKeptEntryId: kept, messagesToSummarize: messages, turnPrefixMessages: prefix });
const params: WarrantParams = { mode: 'shadow', pressureFloor: 0, minCandidateTokens: 1, maxSampleTokens: 30000, minReclaimTokens: 1, minSafeBoundary: .8, minNetReductionTokens: 1, rearmGrowthTokens: 1, cooldownMs: 0, failureBackoffMs: 0, requestTimeoutMs: 3000, calibration: 'synthetic' };
function snapshot(tail: ReturnType<typeof capturedTail>): WarrantSnapshot {
  return { leafEntryId: 'tail', tokens: 10000, contextWindow: 10000, modelKnown: true, serviceModel: 'test', compactionEnabled: true, compactionConfigValid: true, candidateAdapterCompatible: true, pendingInput: false, compactionRunning: false, attemptInFlight: false, lastAssessed: null, nowMs: 10000, lastCompactionMs: null, lastFailureMs: null, suppressedAtTokens: null, candidates: [{ id: 'candidate', tool: 'read', output: 'old output', removableTokens: 100, pinned: false }], recentTail: '', tailEntries: tail.entries, boundaryEvidence: tail.boundaryEvidence, summarizedCallState: tail.summarizedCallState, retainedCallState: tail.retainedCallState, serviceInputTokenLimit: null, serviceQuestionLimit: 128 };
}
test('every raw entry and block remains ordered, including empty, result-only and non-message; leaf closes capture', () => {
  const c = call(), r = result();
  const branch = [entry(c, 'call'), entry(r, 'result'), entry({ role: 'user', content: [] }, 'empty'), { type: 'custom', id: 'custom', data: 'secret' }, entry({ role: 'assistant', content: [{ type: 'image', data: 'secret' }, { type: 'text', text: 'done' }] }, 'tail'), entry(call('post'), 'post')];
  const tail = capturedTail(branch, preparation([], 'call'), 'tail');
  assert.equal(tail.entries.length, 5);
  assert.deepEqual(tail.entries.map(e => e.ordinal), [1, 2, 3, 4, 5]);
  const rendered = JSON.parse(renderTail(tail.entries, 0));
  assert.equal(rendered.entries[1].blocks[0].kind, 'result');
  assert.equal(rendered.entries[1].blocks[0].status, 'ok');
  assert.equal(rendered.entries[1].blocks[0].ref, rendered.entries[0].blocks[0].ref);
  assert.equal(rendered.entries[2].blocks[0].kind, 'empty');
  assert.equal(rendered.entries[3].blocks[0].kind, 'custom');
  assert.deepEqual(rendered.entries[4].blocks.map((b: any) => b.kind), ['image', 'text']);
  assert.ok(JSON.stringify(rendered).includes('secret'), 'custom payload must remain visible; unsupported image still unavailable');
  assert.equal(tail.retainedCallState, 'resolved');
});
test('Unicode omissions count original code points, sorted arguments and aggregate multi-block cap', () => {
  assert.equal(abridge('😀abc😀', 1, 1), '😀[3 chars omitted]😀');
  assert.equal(stableJSON({ z: 1, a: { b: 2, a: 1 } }), '{"a":{"a":1,"b":2},"z":1}');
  const tail = capturedTail([entry({ role: 'user', content: [{ type: 'text', text: '😀'.repeat(1500) }, { type: 'text', text: 'x'.repeat(1500) }] }, 'tail')], preparation([]), 'tail');
  const stages = [0, 1, 2].map(i => JSON.parse(renderTail(tail.entries, i)).entries[0].blocks);
  for (const [i, blocks] of stages.entries()) {
    const caps = [2000, 1000, 550];
    const retained = blocks.reduce((n: number, b: any) => n + Array.from(b.text.replace(/\[\d+ chars omitted\]/g, '')).length, 0);
    assert.equal(retained, caps[i]);
    assert.equal(blocks.reduce((n: number, b: any) => n + b.originalChars, 0), 3000);
    assert.ok(!JSON.stringify(blocks).includes('\\ud83d'));
  }
});
for (const prefix of [false, true]) test(`unresolved summarized call without candidate output gates; split prefix=${prefix}`, () => {
  const c = call(), branch = [entry(c, 'call'), entry({ role: 'assistant', content: 'done' }, 'tail')];
  const t = capturedTail(branch, preparation(prefix ? [] : [c], 'tail', prefix ? [c] : []), 'tail');
  assert.equal(t.summarizedCallState, 'unresolved');
  const s = snapshot(t); s.answers = { boundary: { choice: 'safe', probabilities: { safe: 1, live: 0, uncertain: 0 }, confidence: 1 }, result_s0: { noul: 0 } };
  s.suppressedAtTokens = s.tokens;
  assert.ok(assessWarrant(s, params).reasons.includes('unresolved_summarized_call'));
  s.candidates = []; assert.ok(assessWarrant(s, params).reasons.includes('unresolved_summarized_call'));
});
test('retained unresolved calls flagged and gated, unknown status never assumed ok', () => {
  const t = capturedTail([entry(call(), 'tail')], preparation([], 'tail'), 'tail');
  assert.equal(t.entries[0]!.blocks[0]!.unresolved, true);
  assert.ok(assessWarrant(snapshot(t), params).reasons.includes('unresolved_retained_call'));
  const r: any = result(); delete r.isError;
  const paired = capturedTail([entry(call(), 'call'), entry(r, 'tail')], preparation([call()]), 'tail');
  assert.equal(paired.entries[0]!.blocks[0]!.status, 'unknown');
  assert.equal(paired.entries[0]!.blocks[0]!.crossBoundary, true);
  assert.equal(paired.summarizedCallState, 'resolved');
});
test('ambiguous identities, unsupported call shape and unavailable span mapping fail closed', () => {
  const c = call(), r = result();
  for (const branch of [
    [entry(c, 'a'), entry(c, 'b'), entry(r, 'tail')],
    [entry(c, 'a'), entry(r, 'b'), entry(r, 'tail')],
    [entry(r, 'a'), entry(c, 'tail')],
    [entry({ role: 'assistant', content: [{ type: 'tool_use', id: 'call' }] }, 'tail')],
    [entry({ role: 'assistant', content: 'done' }, 'tail')],
  ]) {
    const t = capturedTail(branch, preparation([c], branch[0]!.id), 'tail');
    assert.equal(t.summarizedCallState, 'unknown');
    assert.ok(assessWarrant(snapshot(t), params).reasons.includes('summarized_call_state_unknown'));
  }
});
test('off-branch and post-capture results cannot resolve a summarized call; captured cross-boundary result can', () => {
  const c = call(), r = result();
  const branch = [entry(c, 'a'), entry({ role: 'assistant', content: 'done' }, 'tail'), entry(r, 'post')];
  assert.equal(capturedTail(branch, preparation([c]), 'tail').summarizedCallState, 'unresolved');
  assert.equal(capturedTail(branch.slice(0, 2), preparation([c]), 'tail').summarizedCallState, 'unresolved');
  assert.equal(capturedTail([entry(c, 'a'), entry(r, 'tail')], preparation([c]), 'tail').summarizedCallState, 'resolved');
});
test('missing call-state fields cannot be bypassed with supplied answers', () => {
  const s: any = snapshot(capturedTail([entry({ role: 'user', content: 'done' }, 'tail')], preparation([]), 'tail'));
  delete s.summarizedCallState; delete s.retainedCallState; s.answers = {};
  assert.deepEqual(assessWarrant(s, params).reasons, ['summarized_call_state_unknown', 'retained_call_state_unknown']);
});
test('complete boundary fits intact or defers; both service/config bounds are enforced', () => {
  const t = capturedTail([entry({ role: 'user', content: 'Inspect.' }, 'u'), entry({ role: 'assistant', content: 'x'.repeat(5000) }, 'tail')], preparation([], 'u'), 'tail');
  const s = snapshot(t), before = structuredClone(s);
  const first = buildWarrantRequest(s, params)!;
  assert.equal(first.tailStage, null);
  assert.equal(first.serviceLimitKnown, false);
  assert.equal(buildWarrantRequest(s, { ...params, maxSampleTokens: first.tokens - 100 }), undefined);
  assert.equal(buildWarrantRequest({ ...s, serviceInputTokenLimit: first.tokens - 100 }, params), undefined);
  assert.deepEqual(s, before);
  for (const bad of [null, 0, -1, NaN, Infinity, 2.5]) assert.equal(buildWarrantRequest({ ...s, serviceInputTokenLimit: bad }, params)!.inputBound, params.maxSampleTokens);
  assert.ok(first.state.recent_tail.includes('x'.repeat(5000)));
  assert.match(BOUNDARY_INSTRUCTIONS, /omitted/); assert.match(BOUNDARY_INSTRUCTIONS, /Choose uncertain/);
});
test('input-limit discovery same configured route, identity validation, unknown fallback and cancellation', async t => {
  const loaded = loadConfig(); assert.ok(loaded.ok);
  const config = structuredClone(loaded.config); config.api.backend = 'local'; config.api.localEndpoint = 'http://127.0.0.1:18394/v1/systemone-local';
  config.api.localModel = 'openjev'; config.api.localRevision = 'revision';
  let seen = '', body: any = { backend: 'openjev', revision: 'revision', max_tokens: 40960 };
  t.mock.method(globalThis, 'fetch', async (url: any) => { seen = String(url); return { ok: true, json: async () => body }; });
  assert.equal(await detectorInputLimit(config, new AbortController().signal), 40960);
  assert.equal(seen, 'http://127.0.0.1:18394/health');
  for (const patch of [{ backend: 'wrong' }, { revision: 'wrong' }, { max_tokens: 0 }, { max_tokens: 1.5 }, { max_tokens: '40960' }]) {
    body = { backend: 'openjev', revision: 'revision', max_tokens: 40960, ...patch };
    assert.equal(await detectorInputLimit(config, new AbortController().signal), null);
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unavailable'); });
  assert.equal(await detectorInputLimit(config, new AbortController().signal), null);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(detectorInputLimit(config, controller.signal));
});

test('unresolved pinned summarized call cannot be hidden by candidate filtering', () => {
  const c = call();
  const t = capturedTail([entry(c, 'call'), entry({ role: 'assistant', content: 'done' }, 'tail')], preparation([c]), 'tail');
  const s = snapshot(t); s.candidates = s.candidates.map(c => ({ ...c, pinned: true }));
  assert.ok(assessWarrant(s, params).reasons.includes('unresolved_summarized_call'));
});
test('health metadata timeout is unknown, but caller cancellation is not a fallback', async t => {
  const loaded = loadConfig(); assert.ok(loaded.ok);
  // The health poll only exists on the local backend; set it explicitly so the check does
  // not depend on which backend layer ships beside the committed config in this checkout.
  const config = structuredClone(loaded.config);
  config.api.backend = 'local';
  config.api.localEndpoint = 'http://127.0.0.1:18390/v1/systemone-local';
  config.api.localTimeoutMs = 5;
  t.mock.method(globalThis, 'fetch', (_url: any, options: any) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  // Keep event loop alive: AbortSignal.timeout alone is unref'ed by Node.
  const keepAlive = setInterval(() => {}, 100);
  try {
    assert.equal(await detectorInputLimit(config, new AbortController().signal), null);
    const controller = new AbortController();
    const pending = detectorInputLimit(config, controller.signal); controller.abort();
    await assert.rejects(pending);
  } finally { clearInterval(keepAlive); }
});
test('whole-branch pairing uses exact call block identity, not id alone', () => {
  const c = call();
  const changed = structuredClone(c); changed.content[0]!.arguments.a = 'different';
  const t = capturedTail([entry(c, 'call'), entry(result(), 'tail')], preparation([changed]), 'tail');
  assert.equal(t.summarizedCallState, 'unknown');
});


test('omitted pre-boundary raw call fails closed even when the native projection is empty', () => {
  const c = call(), branch = [entry(c, 'call'), entry({ role: 'assistant', content: 'done' }, 'tail')];
  const t = capturedTail(branch, preparation([]), 'tail');
  assert.equal(t.summarizedCallState, 'unknown');
  assert.ok(assessWarrant(snapshot(t), params).reasons.includes('summarized_call_state_unknown'));
});

test('projection coverage excludes archived calls before the latest compaction but covers split prefixes', () => {
  const branch = [entry(call('archived'), 'old'), { type: 'compaction', id: 'compact' }, entry(call(), 'call'), entry(result(), 'result'), entry({ role: 'assistant', content: 'done' }, 'tail')];
  assert.equal(capturedTail(branch, preparation([call()]), 'tail').summarizedCallState, 'resolved');
  assert.equal(capturedTail(branch, preparation([]), 'tail').summarizedCallState, 'unknown');
  assert.equal(capturedTail(branch, preparation([], 'tail', [call()]), 'tail').summarizedCallState, 'resolved');
  assert.equal(capturedTail(branch, preparation([call(), call()]), 'tail').summarizedCallState, 'unknown');
});

test('omission-hidden evidence cannot warrant even with a maximally safe supplied answer', () => {
  const t = capturedTail([entry({ role: 'user', content: 'Inspect the complete result before deciding.' }, 'u'),
    entry({ role: 'assistant', content: 'padding '.repeat(20000) + 'Still awaiting approval.' }, 'tail')], preparation([], 'u'), 'tail');
  const s = snapshot(t);
  s.answers = { boundary: { type: 'choice', choice: 'safe', probabilities: { safe: 1, live: 0, uncertain: 0 }, confidence: 1 }, result_s0: { type: 'noul', noul: 0 } };
  assert.equal(assessWarrant(s, params).outcome, 'defer');
  assert.equal(buildWarrantRequest(s, params), undefined);
});

test('decisive evidence includes the last operator request outside the retained span', () => {
  const make = (text: string) => capturedTail([entry({ role: 'user', content: text }, 'u'),
    entry({ role: 'assistant', content: 'Inspection finished.' }, 'tail')], preparation([], 'tail'), 'tail');
  const live = buildWarrantRequest(snapshot(make('Wait for approval; do not finish yet.')), params)!;
  const safe = buildWarrantRequest(snapshot(make('Report the finished inspection.')), params)!;
  assert.notDeepEqual(live.state, safe.state);
});
