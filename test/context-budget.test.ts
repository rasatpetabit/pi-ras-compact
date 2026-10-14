import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensForChars } from '../src/core/prune.js';
import { computeBudget, productionEstimator, projectionTokens, type BudgetInput } from '../src/pi/context-budget.js';
import { fakeEstimator } from './support/estimator.js';

const MODEL = { provider: 'meridian', id: 'claude-opus-5-5' };

const user = (id: string, tokens: number, text = 'hi') => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: 0,
  tokens,
  message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
});

// The fixture places the system prompt's cost on the entry (what the fake charges for a branch
// message) and on the message itself (what it charges for a compaction's carried systemMessage).
const system = (id: string, tokens: number) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: 0,
  tokens,
  message: { role: 'system', content: [{ type: 'text', text: 'you are Pi' }], timestamp: 0, tokens },
});

const assistant = (id: string, tokens: number, patch: Record<string, unknown> = {}) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: 0,
  tokens,
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    api: 'anthropic',
    provider: MODEL.provider,
    model: MODEL.id,
    usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 },
    stopReason: 'stop',
    timestamp: 0,
    ...patch,
  },
});

/** 120,000 counted before the compaction, of which 10k + 10k + 5k are message entries. */
const BRANCH = [user('m1', 10_000), assistant('a1', 10_000), user('keep-1', 5_000)];

const budgetFor = (over: Partial<BudgetInput> = {}) =>
  computeBudget({
    branchEntries: BRANCH,
    firstKeptEntryId: 'keep-1',
    tokensBefore: 120_000,
    contextWindow: 200_000,
    reserveTokens: 50_000,
    maxShare: 0.5,
    maxAfterShare: 0.5,
    model: MODEL,
    estimator: fakeEstimator(),
    ...over,
  });

const ok = (budget: ReturnType<typeof computeBudget>) => budget;

test('a calibrated snapshot: T, O, F, A and the budget, each measured as the spec defines it', () => {
  // T = 200,000 - 50,000 = 150,000. E(branch) = 25,000, so O = 120,000 - 25,000 = 95,000,
  // positive and from the current model, and r = 120,000 / 25,000 = 4.8. Kept from `keep-1`:
  // 5,000, so F = 4.8 x 5,000 = 24,000. A = min(0.5 x 120,000, 150,000) = 60,000.
  // Budget = min(0.5 x 150,000 / 4.8, (60,000 - 24,000) / 4.8) = 7,500 estimator tokens.
  const budget = ok(budgetFor());
  assert.equal(budget.T, 150_000);
  assert.equal(budget.O, 95_000);
  assert.equal(budget.provenance, 'calibrated');
  assert.equal(budget.F, 24_000);
  assert.equal(budget.A, 60_000);
  assert.equal(budget.budgetTokens, 7_500);
  // P = r x the projection of the branch plus the compaction entry with that summary.
  assert.equal(budget.projectedTokens('x'.repeat(400)), 4.8 * (tokensForChars(400) + 5_000));
});

test('projectionTokens counts the newest system message once and every other message', () => {
  const messages = [
    { role: 'system', content: 'older' },
    { role: 'user', content: 'kept' },
    { role: 'system', content: 'newest' },
    { role: 'assistant', content: [] },
  ];
  const seen: Array<Record<string, unknown>> = [];
  const estimateTokens = (message: Record<string, unknown>) => {
    seen.push(message);
    return message.role === 'system' ? 10 : 1;
  };
  assert.equal(projectionTokens(messages, estimateTokens), 12);
  assert.deepEqual(seen.map(message => message.content), ['newest', 'kept', []]);
});

test('the probe carries the branch system message, so F and P count the system prompt once', () => {
  const iso = '2026-09-24T18:00:00.000Z';
  const branchEntries = [
    system('s1', 10_000),
    user('m1', 10_000),
    assistant('a1', 10_000),
    { ...user('keep-1', 5_000), timestamp: iso },
  ];
  const estimator = fakeEstimator();
  // E(branch) = 35,000, so O = 120,000 - 35,000 = 85,000 and r = 120,000 / 35,000. Pi replays
  // the branch's system message onto the compaction entry, so that entry's projection is the
  // system message again: F = r x (10,000 + 5,000), and P counts the same 10,000 once.
  const budget = ok(budgetFor({ branchEntries, estimator }));
  const r = 120_000 / 35_000;
  assert.equal(budget.O, 85_000);
  assert.equal(budget.F, Math.round(r * 15_000));
  assert.equal(budget.projectedTokens('x'.repeat(400)), Math.round(r * (15_000 + tokensForChars(400))));

  const call = estimator.calls[estimator.calls.length - 1];
  const probeEntry = call[call.length - 1] as Record<string, unknown>;
  assert.equal(probeEntry.id, 'jev-budget-probe');
  const carried = probeEntry.systemMessage as Record<string, unknown>;
  assert.equal(carried.role, 'system');
  assert.deepEqual(carried.content, [{ type: 'text', text: 'you are Pi' }]);
  assert.equal(carried.timestamp, Date.parse(iso), 'stamped with the probe entry timestamp in epoch ms');
});

test('a branch with no system message: the probe carries no systemMessage at all', () => {
  const estimator = fakeEstimator();
  const budget = ok(budgetFor({ estimator }));
  assert.equal(budget.F, 4.8 * 5_000);
  const call = estimator.calls[estimator.calls.length - 1];
  const probeEntry = call[call.length - 1] as Record<string, unknown>;
  assert.equal(probeEntry.id, 'jev-budget-probe');
  assert.ok(!('systemMessage' in probeEntry), 'an absent system message stays absent');
});

test('no assistant usage on the branch and no carried record: no overhead, provenance none', () => {
  const estimator = fakeEstimator();
  const budget = budgetFor({ branchEntries: [user('m1', 10_000), user('keep-1', 5_000)], estimator });
  assert.equal(budget.provenance, 'none');
  assert.equal(budget.O, 0);
  assert.equal(estimator.calls.length, 2, 'E(branchEntries) and F were measured, not assumed');
  assert.ok(budget.budgetTokens > 0, 'the compaction still runs');
});

test('a response from another model becomes foreign overhead, never a refusal', () => {
  for (const patch of [{ provider: 'custom-gateway' }, { model: 'coder-flash-v1' }]) {
    const budget = budgetFor({ branchEntries: [user('m1', 10_000), assistant('a1', 10_000, patch), user('keep-1', 5_000)] });
    assert.equal(budget.provenance, 'foreign', JSON.stringify(patch));
    // E = 25,000 and tokensBefore = 120,000, so the difference is the overhead regardless of model.
    assert.equal(budget.O, 95_000, JSON.stringify(patch));
  }
  // The same branch without the mismatch is calibrated, so the test above is not vacuous.
  assert.equal(ok(budgetFor()).provenance, 'calibrated');
});

test('aborted, errored and all-zero usage are skipped the way Pi skips them', () => {
  const skipped = (patch: Record<string, unknown>) =>
    budgetFor({
      branchEntries: [user('m1', 10_000), assistant('a1', 10_000, patch), user('keep-1', 5_000)],
    });
  for (const patch of [
    { stopReason: 'aborted' },
    { stopReason: 'error' },
    { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
  ]) {
    const budget = skipped(patch);
    assert.equal(budget.provenance, 'none', JSON.stringify(patch));
    assert.equal(budget.O, 0, JSON.stringify(patch));
  }
});

test('a carried overhead is the current model\'s, and another model\'s is carried-foreign', () => {
  const carried = (overhead: Record<string, unknown> | undefined) =>
    budgetFor({
      branchEntries: [
        { type: 'compaction', id: 'c0', parentId: null, summary: '', details: { jev: { overhead } } },
        user('m1', 10_000),
        user('keep-1', 5_000),
      ],
    });
  const budget = carried({ tokens: 40_000, provider: MODEL.provider, model: MODEL.id });
  assert.equal(budget.provenance, 'carried');
  assert.equal(budget.O, 40_000);
  // No assistant usage on this branch, so the carried value is the only overhead there is.
  assert.equal(budget.F, Math.round(((15_000 + 40_000) / 15_000) * 5_000));
  assert.equal(budget.A, Math.min(0.5 * (15_000 + 40_000), 150_000));

  for (const overhead of [
    { tokens: 40_000, provider: 'custom-gateway', model: MODEL.id },
    { tokens: 40_000, provider: MODEL.provider, model: 'coder-flash-v1' },
  ]) {
    const foreign = carried(overhead);
    assert.equal(foreign.provenance, 'carried-foreign', JSON.stringify(overhead));
    assert.equal(foreign.O, 40_000, JSON.stringify(overhead));
  }
  for (const overhead of [
    { tokens: 40_000, model: MODEL.id },
    { tokens: 'many', provider: MODEL.provider, model: MODEL.id },
    undefined,
  ]) {
    assert.equal(carried(overhead as Record<string, unknown>).provenance, 'none', JSON.stringify(overhead));
  }
});

test('the carried lookup scans back past a native compaction to the newest Jev overhead', () => {
  const branchEntries = [
    { type: 'compaction', id: 'c0', parentId: null, summary: '', details: { jev: { overhead: { tokens: 40_000, provider: MODEL.provider, model: MODEL.id } } } },
    { type: 'compaction', id: 'c1', parentId: 'c0', fromHook: false, summary: 'pi', tokensBefore: 445_234, details: {} },
    user('m1', 10_000),
    user('keep-1', 5_000),
  ];
  const budget = budgetFor({ branchEntries });
  assert.equal(budget.provenance, 'carried');
  assert.equal(budget.O, 40_000);
});

test('the incident shape: another model responded last, no carried value, and Jev still compacts as foreign', () => {
  // selected meridian/claude-opus-5-5, newest usable assistant xai/grok-4.7, newest compaction
  // native (no `details.jev.overhead`). The difference is still a usable, provider-counted O.
  const native = { type: 'compaction', id: 'c0', parentId: null, fromHook: false, summary: 'pi summary', tokensBefore: 445_234, details: {} };
  const branchEntries = [native, user('m1', 10_000), assistant('a1', 10_000, { provider: 'xai', model: 'grok-4.7' }), user('keep-1', 5_000)];
  const budget = budgetFor({ branchEntries, tokensBefore: 296_915, contextWindow: 1_000_000, reserveTokens: 50_000 });
  assert.equal(budget.provenance, 'foreign');
  // E is the branch's messages (25,000) plus the native compaction's summary (10 chars ~ 3 tokens).
  assert.equal(budget.O, 296_915 - (25_000 + tokensForChars('pi summary'.length)));
  assert.equal(budget.overTrigger, false);
  assert.equal(budget.noRoom, false);
  assert.ok(budget.budgetTokens > 0, 'a Jev compaction is returned, not a failure');
});

test('calibration outranks a carried value when both are available', () => {
  const budget = ok(
    budgetFor({
      branchEntries: [
        { type: 'compaction', id: 'c0', parentId: null, summary: '', details: { jev: { overhead: { tokens: 40_000, provider: MODEL.provider, model: MODEL.id } } } },
        user('m1', 10_000),
        assistant('a1', 10_000),
        user('keep-1', 5_000),
      ],
    }),
  );
  assert.equal(budget.provenance, 'calibrated');
  assert.equal(budget.O, 95_000);
});

test('compacts under the trigger when the fixed content is past the preferred target', () => {
  // E = 40,000, O = 80,000, r = 3, F = 3 x 20,000 = 60,000, A = 0.5 x 120,000 = 60,000, so
  // A - F = 0. T = 150,000, so the preferred target is unreachable but the trigger is not: the
  // room keeps half of what sits above the kept content, 0.5 x (40,000 - 20,000) = 10,000, under
  // the room below the trigger, (150,000 - 60,000) / 3 = 30,000.
  const budget = ok(budgetFor({ branchEntries: [user('m1', 10_000), assistant('a1', 10_000), user('keep-1', 20_000)] }));
  assert.equal(budget.T, 150_000);
  assert.equal(budget.F, 60_000);
  assert.equal(budget.A, 60_000);
  assert.equal(budget.budgetTokens, 10_000);
});

test('fixed content at the trigger still compacts, on the share of the trigger as the budget', () => {
  // The same shape with a smaller window: E = 40,000, O = 80,000, r = 3, F = 60,000 (F does not
  // depend on T), and T = 100,000 - 50,000 = 50,000, so T - F = -10,000: the room and the
  // preferred target are non-positive, so the floor budget is 0.5 x 50,000 / 3.
  const budget = budgetFor({
    branchEntries: [user('m1', 10_000), assistant('a1', 10_000), user('keep-1', 20_000)],
    contextWindow: 100_000,
  });
  assert.equal(budget.overTrigger, true);
  assert.equal(budget.noRoom, true);
  assert.equal(budget.T, 50_000);
  assert.equal(budget.F, 60_000);
  assert.equal(budget.budgetTokens, Math.floor((0.5 * 50_000) / 3));
});

test('a share of the trigger that floors to zero compacts on the room instead', () => {
  const budget = budgetFor({ maxShare: 0.0000005 });
  assert.equal(budget.overTrigger, false);
  assert.equal(budget.noRoom, true);
  assert.equal(budget.budgetTokens, 7_500);
});

test('max_share still binds the summary when A - F is large', () => {
  // E = 100,000 with 10,000 kept, r = 1.2: the room is 0.5 x 100,000 - 10,000 = 40,000 estimator
  // tokens, and max_share x T / r = 0.1 x 150,000 / 1.2 = 12,500 is the smaller of the two.
  const budget = ok(
    budgetFor({
      maxShare: 0.1,
      branchEntries: [
        user('m1', 10_000),
        assistant('a1', 40_000),
        user('m2', 40_000),
        user('keep-1', 10_000),
      ],
    }),
  );
  assert.equal(budget.O, 120_000 - 100_000);
  assert.equal((budget.A - budget.F) / 1.2, 40_000);
  assert.equal(budget.budgetTokens, 12_500);
});

test('A never exceeds the trigger, and the budget is floored to a whole token', () => {
  // 215,000 counted before the compaction with 205,000 of message entries: O = 10,000.
  // A = min(1 x 215,000, 150,000) = 150,000: maxAfterShare alone would exceed T. The budget is
  // max_share x T / r = 0.5 x 150,000 x 205,000 / 215,000, floored.
  const capped = ok(
    budgetFor({
      branchEntries: [user('m1', 190_000), assistant('a1', 10_000), user('keep-1', 5_000)],
      tokensBefore: 215_000,
      maxAfterShare: 1,
    }),
  );
  assert.equal(capped.O, 10_000);
  assert.equal(capped.A, 150_000, 'A is capped by T');
  assert.equal(capped.budgetTokens, Math.floor((0.5 * 150_000 * 205_000) / 215_000));

  const floored = ok(budgetFor({ contextWindow: 200_001, maxShare: 0.0005 }));
  assert.equal(floored.T, 150_001);
  assert.equal(floored.budgetTokens, Math.floor((0.0005 * 150_001) / 4.8));
});

test('P scales Pi\'s estimate by the provider\'s own ratio, not by adding the difference', () => {
  // E = 25,000 and the provider counted 120,000, so r = 4.8. On Claude sessions the gap between
  // the provider count and Pi's estimate grows with the conversation (measured 2026-09-26: the
  // additive P missed the next provider count by a median 43%, the proportional one by 5.6%).
  const budget = budgetFor();
  assert.equal(budget.F, 4.8 * 5_000);
  assert.equal(budget.projectedTokens('x'.repeat(400)), 4.8 * (tokensForChars(400) + 5_000));
  assert.equal(budget.budgetTokens, 7_500, 'the budget in estimator tokens is unchanged');
});

test('when the kept turns alone pass the preferred target, the budget still shrinks the context', () => {
  // E = 40,000 of which 20,000 is kept, O = 80,000, r = 3. s x E - E0 = 0, so the preferred target
  // is out of reach; the budget keeps half of what sits above the kept content, 10,000, rather
  // than everything under the trigger, which let a compaction end larger than it began.
  const budget = budgetFor({ branchEntries: [user('m1', 10_000), assistant('a1', 10_000), user('keep-1', 20_000)] });
  assert.equal(budget.budgetTokens, 10_000);
  assert.ok(budget.projectedTokens('x'.repeat(4 * 10_000)) < 120_000);
});

test('a reserve at or past the window never hands the pruner a negative budget', () => {
  const budget = budgetFor({ contextWindow: 40_000, reserveTokens: 50_000 });
  assert.equal(budget.T, -10_000);
  assert.ok(budget.budgetTokens >= 0, `budget ${budget.budgetTokens}`);
  assert.ok(Number.isFinite(budget.budgetTokens));
});


test('production estimator calibrates and predicts against the same collapsed system prompt, not its latest patch', () => {
  const base = { role: 'system', content: '', sections: { base: 'base' } };
  const patch = { role: 'system', content: '', sections: { patch: 'patch' } };
  const collapsed = { role: 'system', content: '', sections: { base: 'base', patch: 'patch' } };
  const nonBefore = { role: 'user', tokens: 254_188 };
  const nonAfter = { role: 'user', tokens: 227_138 };
  const estimator = productionEstimator(entries => ({ messages: entries.some((e: any) => e.type === 'compaction')
    ? [collapsed, nonAfter] : [base, patch, nonBefore] }),
    (m: any) => m.role !== 'system' ? m.tokens : m.sections.base ? 55_783 : 9_304,
    () => collapsed);
  assert.equal(estimator.estimate([]), 309_971);
  const budget = budgetFor({ tokensBefore: 547_313, estimator });
  assert.equal(budget.projectedTokens('incident'), 499_551);
  assert.ok(budget.projectedTokens('incident') < 547_313 - 10_947);
});

test('explicit target override lowers A but preserves fixed-content guidance', () => {
 const input:any = {branchEntries:[],firstKeptEntryId:'a',tokensBefore:1000,contextWindow:10000,reserveTokens:100,maxShare:.5,maxAfterShare:.5,model:{provider:'p',id:'m'},estimator:{estimate:(e:any[])=>e.length?600:1000,systemMessage:()=>undefined}};
 const a=computeBudget(input),b=computeBudget({...input,targetContextTokens:200});
 assert.equal(a.A,500);assert.equal(b.A,200);assert.ok(b.budgetTokens>0);assert.equal(b.T,a.T);
});
