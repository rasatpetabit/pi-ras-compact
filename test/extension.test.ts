import { piCtx, piEvent, piUser, testDeps, TEST_MODEL } from './support/pi-event.js';
import { productionEstimator } from '../src/pi/context-budget.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JevError } from '../src/client/jev-client.js';
import { flushTelemetry, setLedgerFs } from '../src/client/ledger.js';
import { tokensForChars, type CompactOutcome, type CompactStats } from '../src/core/prune.js';
import { validateCarry } from '../src/core/segments.js';
import { handleCompact, register, type Deps, type HookContext, type HookResult } from '../src/pi/extension.js';
import type { JevConfig } from '../src/client/config.js';
import { piCtx, piEvent, testDeps, TEST_MODEL } from './support/pi-event.js';
import { allOnes, FakeAsker } from './support/fake-asker.js';
import { fakeEstimator } from './support/estimator.js';
import { testConfig } from './support/config.js';
import { scratchDir } from './support/scratch.js';

const RETRY = 'Retry Jev';
const NATIVE = "Use Pi's summary";
const CANCEL = 'Cancel compaction';
const CHOICES = [RETRY, NATIVE, CANCEL];

type Line = Record<string, unknown>;
const logOf = async (config: JevConfig): Promise<Line[]> => {
  await flushTelemetry(); // telemetry appends are asynchronous and never awaited on the call path
  const path = join(dirname(config.telemetry.path), 'compactions.jsonl'); // beside calls.jsonl by design
  const raw = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  return raw ? raw.split('\n').map(l => JSON.parse(l)) : [];
};
const compactionOf = (result: HookResult) => {
  assert.ok(result && 'compaction' in result, `expected a compaction, got ${JSON.stringify(result)}`);
  return result.compaction;
};
/** A failure with no explicit consent must cancel, never let Pi summarize on its own. */
const cancelOf = (result: HookResult) => assert.deepEqual(result, { cancel: true });
const STATS: CompactStats = {
  generation: 1, step: 2, segments: 1, kept: 1, truncated: 0, capped: 0, stubbed: 0, unlinked: 0, dropped: 0, pinned: 0, demoted: 0, demotedCap: 0,
  pinnedByClass: { user: 0, error: 0, modify: 0, decision: 0, boundary: 0, instruction: 0 }, demotedDuplicate: 0, demotedUnknown: 0,
  asked: 0, unasked: 0, unanswered: 0,
  jevRequests: 0, jevInputTokens: 0, jevOutputTokens: 0,
};

/** An asker that counts its calls, so a fallback before Jev can be told from a paid request. */
const countingAsker = () => {
  const calls: string[][] = [];
  return {
    calls,
    deps: testDeps({
      makeAsker: () => ({ ask: async (_state, questions) => { calls.push(Object.keys(questions)); return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; } }),
    }),
  };
};

test('a compaction returns the native result: flat summary, file lists merged from the previous hook entry, a valid carry', async () => {
  const deps = testDeps();
  const event = piEvent({
    branchEntries: [{ type: 'compaction', fromHook: true, details: { readFiles: ['old/read.ts', 42], modifiedFiles: ['old/mod.ts'] } }],
  });
  const compaction = compactionOf(await handleCompact(event, piCtx(), deps));
  assert.equal(compaction.firstKeptEntryId, 'keep-1');
  assert.equal(compaction.tokensBefore, 120_000);
  assert.equal(compaction.summary.match(/<compacted-conversation>/g)?.length, 1);
  assert.ok(compaction.summary.endsWith('<modified-files>\nold/mod.ts\nsrc/auth/session.ts\n</modified-files>'));
  assert.deepEqual(compaction.details.readFiles, ['old/read.ts', 'src/auth/token.ts']);
  assert.deepEqual(compaction.details.modifiedFiles, ['old/mod.ts', 'src/auth/session.ts']);
  assert.equal(compaction.details.jev.version, 1);
  assert.ok(validateCarry(JSON.parse(JSON.stringify(compaction.details.jev.carry))));
  const [line] = (await logOf(deps.config));
  assert.equal(line!.engine, 'jev');
  assert.equal(line!.reason, null);
  assert.equal(line!.resolution, 'jev');
  assert.equal(line!.rejected_prior_file_entries, 1);
  assert.equal(line!.carry, 'none');
  assert.equal(typeof line!.tokens_after, 'number');
});

test('the next compaction reuses the structured carry; a wrapper-made one is read as opaque text', async () => {
  const deps = testDeps();
  const first = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  const entry = { type: 'compaction', fromHook: true, summary: first.summary, details: JSON.parse(JSON.stringify(first.details)) };
  const second = compactionOf(
    await handleCompact(piEvent({ branchEntries: [entry], preparation: { previousSummary: first.summary } }), piCtx(), deps),
  );
  assert.equal(second.details.jev.carry.generation, 2);
  assert.equal((await logOf(deps.config))[1]!.carry, 'structured');

  const wrapperSummary = [
    '<compacted-conversation>',
    'Earlier conversation retained by Jev selective compaction. User and assistant text is verbatim.',
    '',
    '[User]: WRAPPER-ERA REQUEST',
    '</compacted-conversation>',
  ].join('\n');
  const wrapperEntry = { type: 'compaction', fromHook: true, summary: wrapperSummary, details: { readFiles: [], modifiedFiles: ['w.ts'] } };
  const third = compactionOf(
    await handleCompact(piEvent({ branchEntries: [wrapperEntry], preparation: { previousSummary: wrapperSummary } }), piCtx(), deps),
  );
  assert.ok(third.summary.includes('[User]: WRAPPER-ERA REQUEST'));
  assert.ok(third.details.modifiedFiles.includes('w.ts'));
  assert.equal((await logOf(deps.config))[2]!.carry, 'opaque');
});

test('a carry pin the reader does not know is demoted and counted as demoted_unknown in telemetry', async () => {
  const deps = testDeps();
  const first = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  const details = JSON.parse(JSON.stringify(first.details));
  const pinned = (details.jev.carry.segments as Array<{ pin: string | null }>).find(segment => segment.pin !== null);
  assert.ok(pinned);
  pinned.pin = 'nonsense'; // as a newer writer's unknown class would look to this reader
  const entry = { type: 'compaction', fromHook: true, summary: first.summary, details };
  const second = compactionOf(
    await handleCompact(piEvent({ branchEntries: [entry], preparation: { previousSummary: first.summary } }), piCtx(), deps),
  );
  assert.equal(second.details.jev.carry.generation, 2);
  const lines = await logOf(deps.config);
  assert.equal(lines[0]!.demoted_unknown, 0);
  assert.equal(lines[1]!.demoted_unknown, 1);
  assert.equal(lines[1]!.carry, 'structured');
  // The default config has no decision class, so the span's pins are user, error and modify.
  assert.equal(lines[0]!.demoted_cap, 0);
  assert.deepEqual(lines[0]!.pinned_by_class, { user: 1, error: 1, modify: 1, decision: 0, boundary: 0, instruction: 0 });
});

test('abort outranks every path: before start, inside the client, during a failed output check, with telemetry broken', async () => {
  const before = new AbortController();
  before.abort();
  cancelOf(await handleCompact(piEvent({ signal: before.signal }), piCtx(), testDeps()));

  const inClient = new AbortController();
  const clientDeps = testDeps({
    makeAsker: () => ({ ask: async () => { inClient.abort(); throw new JevError('aborted', 'aborted'); } }),
  });
  cancelOf(await handleCompact(piEvent({ signal: inClient.signal }), piCtx(), clientDeps));
  assert.equal((await logOf(clientDeps.config))[0]!.engine, 'cancelled');
  assert.equal((await logOf(clientDeps.config))[0]!.tokens_after, null);

  const inCheck = new AbortController();
  const bad: CompactOutcome = { ok: true, summary: 'x', carry: { version: 1, generation: 1, segments: [{ kind: 'bogus' } as never] }, stats: STATS };
  const checkDeps = testDeps({ compact: async () => { inCheck.abort(); return bad; } });
  cancelOf(await handleCompact(piEvent({ signal: inCheck.signal }), piCtx(), checkDeps));

  const broken = new AbortController();
  broken.abort();
  cancelOf(await handleCompact(piEvent({ signal: broken.signal }), piCtx(), testDeps({ fallbackLogDir: '/dev/null/no' })));

  // Broken telemetry and a throwing notifier cannot turn a failure into a native summary.
  const errors: string[] = [];
  const throwingCtx: HookContext = { model: { contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: TEST_MODEL.id }, ui: { notify: () => { throw new Error('ui gone'); } } };
  const authDeps = testDeps({
    config: testConfig(c => (c.telemetry.path = '/dev/null/no/calls.jsonl')),
    stderr: message => void errors.push(message),
    makeAsker: () => ({ ask: async () => { throw new JevError('auth', 'x'); } }),
  });
  cancelOf(await handleCompact(piEvent(), throwingCtx, authDeps));
  assert.ok(errors.some(message => /auth/.test(message)), 'the real cause reached stderr');
});

test('an output that would not survive the session file is refused as invalid_output, never handed to Pi', async () => {
  const withUndefined: CompactOutcome = {
    ok: true,
    summary: '<compacted-conversation>\n\nx\n\n</compacted-conversation>',
    carry: { version: 1, generation: 1, segments: [{ kind: 'user', text: 'hi', pin: null, gen: 1, note: undefined } as never] },
    stats: STATS,
  };
  for (const outcome of [
    withUndefined,
    { ...withUndefined, summary: '   ' },
    { ...withUndefined, carry: { version: 1, generation: 1, segments: [{ kind: 'bogus' } as never] } },
  ]) {
    const deps = testDeps({ compact: async () => outcome as CompactOutcome });
    cancelOf(await handleCompact(piEvent(), piCtx(), deps));
    assert.equal((await logOf(deps.config))[0]!.reason, 'invalid_output');
    assert.equal((await logOf(deps.config))[0]!.resolution, 'cancelled');
  }
  // Control: the same outcome without the undefined-valued key is accepted.
  const control: CompactOutcome = { ...withUndefined, carry: { version: 1, generation: 1, segments: [{ kind: 'user', text: 'hi', pin: null, gen: 1 }] } };
  compactionOf(await handleCompact(piEvent(), piCtx(), testDeps({ compact: async () => control })));
});

test('a stalled telemetry filesystem cannot block a compaction: handleCompact returns at once', async () => {
  const never = new Promise<never>(() => {});
  setLedgerFs({ stat: () => never, mkdir: () => never, appendFile: () => never });
  try {
    const deps = testDeps();
    const started = Date.now();
    compactionOf(await handleCompact(piEvent(), piCtx(), deps));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `the compaction must not wait on telemetry (${elapsed} ms)`);
  } finally {
    setLedgerFs(undefined); // abandon the stalled writes so a later flush terminates
  }
});

test('a missing or invalid config cancels headless and announces the config errors once', async () => {
  const errors: string[] = [];
  const deps = testDeps({ loadConfig: () => ({ ok: false, errors: ['compaction.max_share'] }), stderr: message => void errors.push(message) });
  cancelOf(await handleCompact(piEvent(), piCtx(), deps));
  cancelOf(await handleCompact(piEvent(), piCtx(), deps));
  assert.equal(errors.filter(message => /^× Jev \[backend not recorded\] failed \(config\)/.test(message)).length, 1, 'announced once per reason');
  assert.match(errors[0]!, /failed \(config\)/);
  await flushTelemetry();
  const lines = readFileSync(join(deps.fallbackLogDir, 'compactions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => [l.engine, l.reason, l.resolution]), [
    ['cancelled', 'config', 'cancelled'],
    ['cancelled', 'config', 'cancelled'],
  ]);
  assert.deepEqual(lines[0].config_errors, ['compaction.max_share']);
});

test('the kill switch is an intentional opt-out: disabled returns undefined for Pi to summarize, silently', async () => {
  const notes: string[] = [];
  const deps = testDeps({ config: testConfig(c => (c.compaction.enabled = false)) });
  assert.equal(await handleCompact(piEvent(), piCtx(notes), deps), undefined);
  assert.equal(notes.length, 0);
  const line = (await logOf(deps.config))[0]!;
  assert.deepEqual([line.engine, line.reason, line.resolution], ['fallback', 'disabled', 'disabled']);
});

test('every client failure cancels headless and is announced with its kind; Pi is never handed the compaction', async () => {
  for (const [kind, build] of [
    ['auth', () => new JevError('auth', 'x')],
    ['timeout', () => new JevError('timeout', 'x')],
    ['network', () => new JevError('network', 'x')],
    ['http', () => new JevError('http', 'x')],
    ['parse', () => new JevError('parse', 'x')],
    ['error', () => new Error('boom')],
  ] as const) {
    const errors: string[] = [];
    const deps = testDeps({ stderr: message => void errors.push(message), makeAsker: () => ({ ask: async () => { throw build(); } }) });
    cancelOf(await handleCompact(piEvent(), piCtx(), deps));
    assert.equal((await logOf(deps.config))[0]!.reason, kind);
    assert.match(errors[0]!, new RegExp(`\\(${kind}\\)`));
    assert.ok(errors.some(message => /Pi (summary )?not used/.test(message)), `${kind} says Pi was not used`);
  }
});

test('the footer keeps the last outcome: success, an operator-chosen native summary, or a cancel', async () => {
  const status = new Map<string, string | undefined>();
  compactionOf(await handleCompact(piEvent(), piCtx([], 1_048_576, status), testDeps()));
  assert.match(status.get('jev-compaction') ?? '', /^✓ Jev \[TypeSafe hosted\]/);
  const failing = () => testDeps({ makeAsker: () => ({ ask: async () => { throw new JevError('network', 'x'); } }) });
  await handleCompact(piEvent(), piCtx([], 1_048_576, status, { hasUI: true, select: async () => NATIVE }), failing());
  assert.match(status.get('jev-compaction') ?? '', /Pi summary selected/);
  await handleCompact(piEvent(), piCtx([], 1_048_576, status), failing());
  assert.match(status.get('jev-compaction') ?? '', /cancelled/);
  await handleCompact(piEvent(), piCtx([], 1_048_576, status), testDeps({ config: testConfig(c => (c.compaction.enabled = false)) }));
  assert.ok(status.has('jev-compaction') && status.get('jev-compaction') === undefined, 'the kill switch clears it');
});

test('a successful compaction shows one compact route-first line; full context is in the card', async () => {
  const notes: string[] = [];
  compactionOf(await handleCompact(piEvent(), piCtx(notes), testDeps()));
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^✓ Jev \[TypeSafe hosted\]/);
});

test('telemetry records how many segments Jev was asked about, left unasked and left unanswered', async () => {
  const deps = testDeps();
  compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  const [line] = (await logOf(deps.config));
  for (const field of ['asked', 'unasked', 'unanswered']) {
    assert.equal(typeof line![field], 'number', `${field} is logged as a number`);
  }
  assert.equal(line!.asked! + line!.unasked! + line!.unanswered! + line!.pinned!, line!.segments);
});

test('every compaction telemetry row carries the rollout marker policy=no-fallback', async () => {
  // Rollout step 3 greps for this marker to tell a reloaded session's row from one an old
  // session wrote. Both the success and the cancel paths must carry it.
  const ok = testDeps();
  compactionOf(await handleCompact(piEvent(), piCtx(), ok));
  assert.equal((await logOf(ok.config))[0]!.policy, 'no-fallback');
  const bad = failingDeps();
  cancelOf(await handleCompact(piEvent(), piCtx(), bad));
  assert.equal((await logOf(bad.config))[0]!.policy, 'no-fallback');
});

test('an unrecognised event shape (Pi interface drift) cancels without throwing', async () => {
  const shapes: Array<[unknown, HookContext]> = [
    [null, piCtx()],
    [{}, piCtx()],
    [piEvent({ preparation: { firstKeptEntryId: 7 } }), piCtx()],
    [piEvent({ preparation: { fileOps: { read: 'x', written: [], edited: [] } } }), piCtx()],
    [piEvent({ preparation: { settings: {} } }), piCtx()],
    [piEvent({ branchEntries: 'x' }), piCtx()],
    [piEvent({ signal: undefined }), piCtx()],
    [piEvent(), { ui: {} }],
  ];
  for (const [event, ctx] of shapes) {
    const deps = testDeps();
    cancelOf(await handleCompact(event, ctx, deps));
    assert.equal((await logOf(deps.config))[0]!.reason, 'input_shape');
  }
});

test('a max_share too small for the pins still compacts through the real core, over budget', async () => {
  // T = 1,048,576 - 50,000 = 998,576; the budget is min(0.00005 x T, A - F) = min(49, 47,500) = 49 tokens,
  // and the pinned user text, error and edit need more. The budget guides; it never refuses.
  const deps = testDeps({ config: testConfig(c => (c.compaction.maxShare = 0.00005)) });
  const result = (await handleCompact(piEvent(), piCtx(), deps)) as { compaction?: { summary: string } } | undefined;
  assert.ok(result?.compaction, 'a Jev compaction is returned, not a cancel or native');
  const row = (await logOf(deps.config))[0]!;
  assert.equal(row.engine, 'jev');
  assert.equal(row.step, 6);
  assert.equal(row.over_budget, true);
});

test('a share of the trigger that floors to zero compacts on the room, with no_room recorded', async () => {
  const { calls, deps } = countingAsker();
  // T = 1,048,576 - 50,000 = 998,576; min(0.0000005 x T, A - F) = min(0, 47,500) = 0, so the floor
  // budget is the room, 47,500: the compaction runs instead of failing before the request.
  const config = testConfig(c => { c.compaction.maxShare = 0.0000005; c.compaction.maxAfterShare = 0.5; });
  const withSmallShare = testDeps({ config, makeAsker: deps.makeAsker });
  compactionOf(await handleCompact(piEvent(), piCtx(), withSmallShare));
  const [line] = await logOf(withSmallShare.config);
  assert.equal(line!.engine, 'jev');
  assert.equal(line!.reason, null);
  assert.equal(line!.over_trigger, false);
  assert.equal(line!.no_room, true);
  assert.equal(line!.budget_tokens, 47_500);
  assert.ok(calls.length > 0, 'the floor budget is used, so Jev is asked');
});

test('a non-finite prediction cancels as no_progress rather than being returned', async () => {
  // The summary costs NaN for any non-empty text, so P is NaN and cannot be shown to fit A.
  const deps = testDeps({ estimator: async () => fakeEstimator({ summaryTokens: s => (s.length === 0 ? 0 : Number.NaN) }) });
  cancelOf(await handleCompact(piEvent(), piCtx(), deps));
  const [line] = (await logOf(deps.config));
  assert.equal(line!.engine, 'cancelled');
  assert.equal(line!.reason, 'no_progress');
  // JSON has no NaN, so telemetry records a non-finite prediction as null rather than a number.
  assert.equal(line!.predicted_after, null, 'the non-finite prediction was recorded, not silently dropped');
});

test('a kept turn past the preferred target still compacts under the trigger', async () => {
  const { calls, deps } = countingAsker();
  // Kept from `a0`: 100,000 + 5,000 = 105,000 = E, so O = 15,000, r = 120,000 / 105,000 and
  // F = 120,000. A = min(0.5 x 120,000, 998,576) = 60,000, below F, and nothing sits above the
  // kept content, so the room is 0 and the floor budget is 0.5 x 998,576 / r: Jev is asked.
  const event = piEvent({ preparation: { firstKeptEntryId: 'a0' } });
  const compaction = compactionOf(await handleCompact(event, piCtx(), deps));
  const T = 1_048_576 - 50_000;
  assert.ok(compaction.estimatedTokensAfter <= T, `P ${compaction.estimatedTokensAfter} exceeds the trigger ${T}`);
  const [line] = (await logOf(deps.config));
  assert.equal(line!.engine, 'jev');
  assert.equal(line!.reason, null);
  assert.equal(line!.target_after, 60_000);
  assert.equal(line!.budget_tokens, Math.floor((0.5 * 998_576 * 105_000) / 120_000));
  assert.ok(calls.length > 0, 'the compaction fits under the trigger, so Jev is asked');
});

test('a context window that leaves no room under the trigger still compacts under the floor budget', async () => {
  const { calls, deps } = countingAsker();
  // The same fixture with a smaller window: F = 120,000 as above (it does not depend on T),
  // but T = 160,000 - 50,000 = 110,000, so T - F = -10,000 and the floor budget is 0.5 x T / r.
  const event = piEvent({ preparation: { firstKeptEntryId: 'a0' } });
  compactionOf(await handleCompact(event, piCtx([], 160_000), deps));
  const [line] = await logOf(deps.config);
  assert.equal(line!.engine, 'jev');
  assert.equal(line!.reason, null);
  assert.equal(line!.over_trigger, true);
  assert.equal(line!.no_room, true);
  assert.equal(line!.budget_tokens, Math.floor((0.5 * 110_000 * 105_000) / 120_000));
  assert.ok(calls.length > 0, 'the floor budget is used, so Jev is asked');
});

test('the incident shape: a native compaction and another model\'s last response compact with foreign overhead, no prompt', async () => {
  const { calls, deps } = countingAsker();
  // Newest compaction native (no details.jev.overhead), newest usable assistant on another model.
  const native = { type: 'compaction', id: 'c0', parentId: null, fromHook: false, summary: 'pi', tokensBefore: 445_234, details: {} };
  const event = piEvent({ branchEntries: [native] });
  const ctx: HookContext = { model: { contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: 'another-model' } };
  const compaction = compactionOf(await handleCompact(event, ctx, deps));
  assert.equal(compaction.details.jev.overhead.provenance, 'foreign');
  assert.ok(compaction.details.jev.overhead.tokens > 0, 'the difference is a positive overhead');
  const [line] = await logOf(deps.config);
  assert.equal(line!.engine, 'jev');
  assert.equal(line!.overhead_provenance, 'foreign');
  assert.ok(calls.length > 0, 'Jev is asked in place of a prompt or Pi\u2019s summary');
});

test('an estimator Pi cannot supply cancels as estimator without asking Jev', async () => {
  const calls: string[][] = [];
  const deps = testDeps({
    estimator: async () => { throw new Error('no Pi here'); },
    makeAsker: () => ({ ask: async (_state, questions) => { calls.push(Object.keys(questions)); return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }; } }),
  });
  cancelOf(await handleCompact(piEvent(), piCtx(), deps));
  assert.equal((await logOf(deps.config))[0]!.reason, 'estimator');
  assert.deepEqual(calls, [], 'the budget is decided before any Jev request');
});

// With fakeEstimator at 120,000 tokens before: E = 105,000, O = 15,000, r = 120,000 / 105,000,
// F = r x 5,000, A = 60,000, budget = 0.5 x 105,000 - 5,000 = 47,500 estimator tokens.
test('an accepted result carries P as its estimate, its overhead, and the whole budget in telemetry', async () => {
  const deps = testDeps();
  const compaction = compactionOf(await handleCompact(piEvent(), piCtx(), deps));

  // P = r x E(kept 5,000 + the summary Pi projects).
  const predicted = Math.round((120_000 / 105_000) * (5_000 + tokensForChars(compaction.summary.length)));
  assert.equal(compaction.estimatedTokensAfter, predicted);
  assert.ok(predicted <= 60_000, `P ${predicted} exceeds the target A`);

  const overhead = compaction.details.jev.overhead;
  assert.deepEqual(overhead, { tokens: 15_000, provider: TEST_MODEL.provider, model: TEST_MODEL.id, provenance: 'calibrated' });
  // The overhead is plain JSON, so the persistence round trip keeps it as it is.
  assert.deepEqual(JSON.parse(JSON.stringify(overhead)), overhead);
  assert.ok(validateCarry(JSON.parse(JSON.stringify(compaction.details.jev.carry))));

  const [line] = (await logOf(deps.config));
  assert.equal(line!.tokens_after, predicted, 'tokens_after is P for a Jev result');
  assert.equal(line!.predicted_after, predicted);
  assert.equal(line!.trigger_reason, 'manual');
  assert.equal(line!.will_retry, false);
  assert.equal(line!.context_window, 1_048_576);
  assert.equal(line!.reserve_tokens, 50_000);
  assert.equal(line!.overhead, 15_000);
  assert.equal(line!.overhead_provenance, 'calibrated');
  assert.equal(line!.fixed_after, Math.round((120_000 / 105_000) * 5_000));
  assert.equal(line!.target_after, 60_000);
  assert.equal(line!.budget_tokens, 47_500);
});

test('a summary the estimator charges far past the trigger is accepted, with over_trigger recorded', async () => {
  // 5,000 x chars/4: any real summary makes P exceed the trigger T = 1,048,576 - 50,000 = 998,576.
  // The context-after budget is guidance, so the finite result is still returned (2026-09-25).
  const deps = testDeps({ estimator: async () => fakeEstimator({ summaryTokens: summary => 5_000 * tokensForChars(summary.length) }) });
  const compaction = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  assert.ok(compaction.estimatedTokensAfter > 998_576);
  const [line] = await logOf(deps.config);
  assert.equal(line!.engine, 'jev');
  assert.equal(line!.reason, null);
  assert.equal(line!.over_trigger, true);
  assert.equal(line!.overhead, 15_000);
  assert.equal(line!.overhead_provenance, 'calibrated');
  assert.equal(line!.budget_tokens, 47_500);
});

test('a summary longer than the budget is accepted and recorded as over_budget', async () => {
  // compactSpan prunes to fit the budget, so the over-budget path is exercised with a compact
  // outcome whose summary is longer than the budget the hook computed (47,500).
  const long: CompactOutcome = {
    ok: true,
    summary: 'x'.repeat(400_000),
    carry: { version: 1, generation: 1, segments: [{ kind: 'user', text: 'hi', pin: null, gen: 1 }] },
    stats: STATS,
  };
  const deps = testDeps({ compact: async () => long });
  compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  const [line] = await logOf(deps.config);
  assert.equal(line!.engine, 'jev');
  assert.equal(line!.over_budget, true);
  assert.equal(line!.over_trigger, false, 'the summary is over its budget but still under the trigger');
});

test('a branch with no response after the previous compaction carries its overhead', async () => {
  const deps = testDeps();
  const first = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  const entry = { type: 'compaction', fromHook: true, summary: first.summary, details: JSON.parse(JSON.stringify(first.details)) };
  // tokensBefore below the estimator's own count: no assistant response since the previous
  // compaction can calibrate O, so it is carried from that compaction's recorded overhead.
  const second = compactionOf(await handleCompact(piEvent({ branchEntries: [entry], preparation: { tokensBefore: 100_000 } }), piCtx(), deps));
  assert.deepEqual(second.details.jev.overhead, {
    tokens: first.details.jev.overhead.tokens,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    provenance: 'carried',
  });
  assert.equal((await logOf(deps.config))[1]!.overhead_provenance, 'carried');
});

// ---------------------------------------------------------------------------
// D2-D4: no automatic fallback to Pi's built-in summary, an explicit chooser
// ---------------------------------------------------------------------------

/** A deps whose Jev call always fails with `kind`, for the choice tests. */
const failingDeps = (patch: Partial<Deps> = {}) =>
  testDeps({ ...patch, makeAsker: () => ({ ask: async () => { throw new JevError('network', 'x'); } }) });

test("interactive: Retry Jev re-runs the Jev compaction and can succeed; the prompt offers exactly the three choices", async () => {
  let attempts = 0;
  const deps = testDeps({
    makeAsker: () => {
      attempts += 1;
      return attempts === 1 ? { ask: async () => { throw new JevError('network', 'x'); } } : new FakeAsker(allOnes);
    },
  });
  const offered: string[][] = [];
  const ctx = piCtx([], 1_048_576, new Map(), { hasUI: true, select: async (_title, options) => { offered.push(options); return RETRY; } });
  compactionOf(await handleCompact(piEvent(), ctx, deps));
  assert.equal(attempts, 2, 'the failed attempt was retried');
  assert.deepEqual(offered, [CHOICES]);
  assert.equal((await logOf(deps.config))[0]!.resolution, 'retry');
  assert.equal((await logOf(deps.config))[1]!.engine, 'jev');
});

test("interactive: Use Pi's summary returns undefined — the one explicit path to the native summary", async () => {
  const deps = failingDeps();
  const ctx = piCtx([], 1_048_576, new Map(), { hasUI: true, select: async () => NATIVE });
  assert.equal(await handleCompact(piEvent(), ctx, deps), undefined);
  assert.equal((await logOf(deps.config))[0]!.resolution, 'native');
});

test('interactive: Cancel compaction returns {cancel:true}', async () => {
  const deps = failingDeps();
  const ctx = piCtx([], 1_048_576, new Map(), { hasUI: true, select: async () => CANCEL });
  cancelOf(await handleCompact(piEvent(), ctx, deps));
  assert.equal((await logOf(deps.config))[0]!.resolution, 'cancelled');
});

test('interactive: Escape (undefined) cancels, never native', async () => {
  const deps = failingDeps();
  const ctx = piCtx([], 1_048_576, new Map(), { hasUI: true, select: async () => undefined });
  cancelOf(await handleCompact(piEvent(), ctx, deps));
  assert.equal((await logOf(deps.config))[0]!.resolution, 'cancelled');
});

test('interactive: a throwing prompt cancels, never native', async () => {
  const deps = failingDeps();
  const ctx = piCtx([], 1_048_576, new Map(), { hasUI: true, select: async () => { throw new Error('dialog died'); } });
  cancelOf(await handleCompact(piEvent(), ctx, deps));
  assert.equal((await logOf(deps.config))[0]!.resolution, 'cancelled');
});

test('cancels when the select API exists without hasUI, or hasUI exists without a chooser', async () => {
  const withChooser = piCtx([], 1_048_576, new Map(), { select: async () => NATIVE }); // hasUI undefined
  cancelOf(await handleCompact(piEvent(), withChooser, failingDeps()));
  const withHasUI: HookContext = {
    model: { contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: TEST_MODEL.id },
    hasUI: true,
    ui: { notify: () => {} },
  };
  cancelOf(await handleCompact(piEvent(), withHasUI, failingDeps()));
});

test('no UI: cancel and a loud error, never native', async () => {
  const errors: string[] = [];
  const deps = failingDeps({ stderr: message => void errors.push(message) });
  cancelOf(await handleCompact(piEvent(), piCtx(), deps));
  assert.ok(errors.some(message => /^× Jev \[TypeSafe hosted\] failed \(network\)/.test(message)), 'the failure is on stderr');
  assert.ok(errors.some(message => /Pi (summary )?not used/.test(message)), 'the cancel says Pi was not used');
});

test('an unexpected exception from compact cancels and is announced, never native', async () => {
  const errors: string[] = [];
  const deps = testDeps({ stderr: message => void errors.push(message), compact: async () => { throw new Error('boom'); } });
  cancelOf(await handleCompact(piEvent(), piCtx(), deps));
  assert.equal((await logOf(deps.config))[0]!.reason, 'error');
  assert.match(errors[0]!, /\(error\)/);
});

// ---------------------------------------------------------------------------
// J6: the real cause survives into the notice and the telemetry row
// ---------------------------------------------------------------------------

test('a failure keeps the real cause: the error message and the HTTP status, never a key or a body', async () => {
  const errors: string[] = [];
  const boom = testDeps({ stderr: message => void errors.push(message), compact: async () => { throw new Error('boom'); } });
  cancelOf(await handleCompact(piEvent(), piCtx(), boom));
  assert.match(errors[0]!, /failed \(error\)/, 'the notice uses code-authored safe wording');
  assert.ok(!errors[0]!.includes('boom'));
  assert.match(String((await logOf(boom.config))[0]!.cause), /boom/, 'telemetry records it too');

  const http = testDeps({ makeAsker: () => ({ ask: async () => { throw new JevError('http', 'Jev returned HTTP 503', 503); } }) });
  cancelOf(await handleCompact(piEvent(), piCtx(), http));
  assert.match(String((await logOf(http.config))[0]!.cause), /HTTP 503/, 'the HTTP status reaches telemetry');

  const estimator = testDeps({ estimator: async () => { throw new Error('estimator gone'); } });
  cancelOf(await handleCompact(piEvent(), piCtx(), estimator));
  assert.equal((await logOf(estimator.config))[0]!.reason, 'estimator');
  assert.match(String((await logOf(estimator.config))[0]!.cause), /estimator gone/, 'a budget failure keeps its cause too');
});

// ---------------------------------------------------------------------------
// J1: the hook boundary is throw-proof even outside the Pi runner
// ---------------------------------------------------------------------------

test('a ctx whose hasUI/ui getters throw still cancels, never throws and never runs native', async () => {
  const deps = failingDeps();
  const throwingCtx = {
    model: { contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: TEST_MODEL.id },
    get ui(): never {
      throw new Error('ctx is stale');
    },
    get hasUI(): never {
      throw new Error('ctx is stale');
    },
  } as unknown as HookContext;
  cancelOf(await handleCompact(piEvent(), throwingCtx, deps));
  assert.equal((await logOf(deps.config))[0]!.reason, 'network');
  assert.equal((await logOf(deps.config))[0]!.resolution, 'cancelled', 'the unreadable chooser cancelled rather than escaping');

  // A throwing select getter and an undefined ctx cancel through the same guarded reads.
  const selectThrows = {
    model: { contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: TEST_MODEL.id },
    hasUI: true,
    ui: { get select(): never { throw new Error('select getter blew up'); }, notify: () => {} },
  } as unknown as HookContext;
  cancelOf(await handleCompact(piEvent(), selectThrows, failingDeps()));
  cancelOf(await handleCompact(piEvent(), undefined as unknown as HookContext, failingDeps()));
});

// ---------------------------------------------------------------------------
// J2: the chooser is cancellation-aware
// ---------------------------------------------------------------------------

test('the compaction abort signal is passed to select, and an abort while the prompt is pending cancels', async () => {
  const controller = new AbortController();
  const seen: Array<{ signal?: AbortSignal; timeout?: number } | undefined> = [];
  const deps = failingDeps();
  const ctx = piCtx([], 1_048_576, new Map(), {
    hasUI: true, // TUI: no mode, so no timeout
    select: async (_title, _options, dialog) => {
      seen.push(dialog);
      return new Promise<string | undefined>(resolve => {
        dialog?.signal?.addEventListener('abort', () => resolve(undefined), { once: true });
      });
    },
  });
  const pending = handleCompact(piEvent({ signal: controller.signal }), ctx, deps);
  await new Promise(resolve => setImmediate(resolve)); // let the prompt start
  controller.abort();
  cancelOf(await pending);
  assert.equal(seen.length, 1, 'select was offered');
  assert.equal(seen[0]!.signal, controller.signal, 'the dialog got the compaction signal');
  assert.equal(seen[0]!.timeout, undefined, 'TUI prompts without a timeout');
  assert.equal((await logOf(deps.config))[0]!.resolution, 'cancelled');
});

test('a retry or native choice that races the abort loses: abort always cancels', async () => {
  for (const choice of [RETRY, NATIVE]) {
    const controller = new AbortController();
    const deps = failingDeps();
    const ctx = piCtx([], 1_048_576, new Map(), {
      hasUI: true,
      select: async () => {
        controller.abort(); // the answer and the abort arrive together
        return choice;
      },
    });
    cancelOf(await handleCompact(piEvent({ signal: controller.signal }), ctx, deps));
    assert.equal((await logOf(deps.config))[0]!.resolution, 'cancelled', `${choice} racing the abort must cancel`);
  }
});

// ---------------------------------------------------------------------------
// D5: RPC prompts with the configured timeout; without one it cancels unprompted
// ---------------------------------------------------------------------------

test('rpc with compaction.prompt_timeout_ms prompts, and a real pending prompt resolves on its own timeout', async () => {
  const seen: Array<{ signal?: AbortSignal; timeout?: number } | undefined> = [];
  const deps = failingDeps({ config: testConfig(c => (c.compaction.promptTimeoutMs = 60)) });
  const ctx = piCtx([], 1_048_576, new Map(), {
    mode: 'rpc',
    hasUI: true,
    select: (_title, _options, dialog) => {
      seen.push(dialog);
      // A genuinely pending prompt: it stays unresolved until its own timeout fires,
      // then resolves undefined. This tests the hook's real waiting behavior; the
      // installed rpc-mode dialog's own timeout is driven end to end by
      // scripts/live_acceptance.py check 3d (real `pi --mode rpc`, no paid Jev call).
      return new Promise<string | undefined>(resolve => {
        if (!dialog?.timeout) resolve(undefined);
        else setTimeout(() => resolve(undefined), dialog.timeout);
      });
    },
  });
  const started = Date.now();
  cancelOf(await handleCompact(piEvent(), ctx, deps));
  assert.equal(seen.length, 1, 'the RPC dialog was opened');
  assert.equal(seen[0]!.timeout, 60, 'the configured RPC timeout is passed to the dialog');
  assert.ok(seen[0]!.signal instanceof AbortSignal, 'the compaction signal is passed too');
  assert.ok(Date.now() - started >= 50, 'the prompt was pending until its timeout, not answered at once');
  // Control: the same RPC ctx with a native answer still runs Pi's summary on consent.
  assert.equal(
    await handleCompact(piEvent(), piCtx([], 1_048_576, new Map(), { mode: 'rpc', hasUI: true, select: async () => NATIVE }), deps),
    undefined,
  );
});

test('rpc without compaction.prompt_timeout_ms cancels without prompting and never touches exitCode', async () => {
  const notes: string[] = [];
  let prompted = 0;
  const deps = failingDeps();
  assert.equal(deps.config.compaction.promptTimeoutMs, undefined, 'the committed config omits the key');
  const realExit = process.exitCode;
  process.exitCode = 0;
  try {
    cancelOf(await handleCompact(piEvent(), piCtx(notes, 1_048_576, new Map(), {
      mode: 'rpc', hasUI: true, select: async () => { prompted += 1; return NATIVE; },
    }), deps));
  } finally {
    assert.equal(process.exitCode, 0, 'an RPC cancel never sets the CLI exit code');
    process.exitCode = realExit;
  }
  assert.equal(prompted, 0, 'an unattended RPC client is never asked a question it cannot answer');
  assert.ok(notes.some(m => /cancelled/.test(m)), 'the cancel states the outcome; detail is in telemetry');
  assert.ok(notes.some(m => /Pi (summary )?not used/.test(m)), 'and that Pi did not summarize');
  assert.equal((await logOf(deps.config))[0]!.resolution, 'cancelled');
});

// ---------------------------------------------------------------------------
// F7: a cancel clears the borrowable footer reason
// ---------------------------------------------------------------------------

test('a cancelled compaction clears deps.last, so no later marker borrows its reason', async () => {
  const deps = failingDeps();
  assert.ok(deps.last === undefined, 'nothing recorded before the attempt');
  cancelOf(await handleCompact(piEvent(), piCtx(), deps));
  assert.equal(deps.last, undefined, 'the cancel path cleared it');

  // Control: an explicit native choice keeps the outcome for the session_compact marker.
  const native = failingDeps();
  assert.equal(await handleCompact(piEvent(), piCtx([], 1_048_576, new Map(), { hasUI: true, select: async () => NATIVE }), native), undefined);
  assert.equal(native.last?.reason, 'network', 'a consented native summary keeps its reason for the marker');
});

// ---------------------------------------------------------------------------
// J3: a headless CLI failure ends the run nonzero; an SDK host is untouched
// ---------------------------------------------------------------------------

test('a print/json Jev-failure cancel sets process.exitCode=1 only under the Pi CLI', async () => {
  const scratch = scratchDir('jev-cli-');
  mkdirSync(join(scratch, 'dist'));
  writeFileSync(join(scratch, 'dist', 'cli.js'), '');
  // `pi` is executed through a symlink (the npm bin), and Node reports the symlink path as
  // argv[1]; the detection must resolve it to the real CLI entry.
  const cliLink = join(scratch, 'pi');
  symlinkSync(join(scratch, 'dist', 'cli.js'), cliLink);
  const sdkEntry = join(scratch, 'run-workflow.ts');
  writeFileSync(sdkEntry, '');
  const realArgv = process.argv[1];
  const realExitCode = process.exitCode;
  const failing = () => failingDeps();
  const headless = (mode: string): HookContext => ({ mode, hasUI: false, model: { contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: TEST_MODEL.id } });
  try {
    process.argv[1] = cliLink;
    for (const mode of ['print', 'json']) {
      process.exitCode = 0;
      cancelOf(await handleCompact(piEvent(), headless(mode), failing()));
      assert.equal(process.exitCode, 1, `${mode}: the CLI exit channel is set`);
    }
    // RPC prompts (D5), so a cancel there must not look like a headless failure.
    process.exitCode = 0;
    cancelOf(await handleCompact(piEvent(), piCtx([], 1_048_576, new Map(), { mode: 'rpc', hasUI: true, select: async () => undefined }), failing()));
    assert.equal(process.exitCode, 0, 'rpc never touches the process exit code');

    // An SDK/in-process host runs its own entry point, and its mode also defaults to print.
    process.argv[1] = sdkEntry;
    process.exitCode = 0;
    cancelOf(await handleCompact(piEvent(), headless('print'), failing()));
    assert.equal(process.exitCode, 0, 'an SDK host is never given a process-global side effect');
  } finally {
    process.argv[1] = realArgv;
    process.exitCode = realExitCode;
  }
});

// ---------------------------------------------------------------------------
// The real Pi runner: a throwing handler is swallowed and native summarization
// would run, which is why the hook returns {cancel:true} instead of throwing.
// ---------------------------------------------------------------------------

interface RunnerApi {
  ExtensionRunner: new (extensions: unknown[], runtime: unknown, cwd: string, sessionManager: unknown, modelRegistry: unknown) => {
    getModel: () => unknown;
    setUIContext(ui: unknown, mode?: string): void;
    onError(listener: (error: unknown) => void): () => void;
    invalidate(message?: string): void;
    emit(event: unknown): Promise<unknown>;
  };
  createExtensionRuntime: () => unknown;
}

async function loadPiRelease(): Promise<RunnerApi | undefined> {
  try {
    const piBin = execFileSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).trim();
    if (piBin.length === 0) return undefined;
    const releaseRoot = dirname(dirname(realpathSync(piBin)));
    const module = (await import(`${releaseRoot}/dist/index.js`)) as Partial<RunnerApi>;
    return module.ExtensionRunner && module.createExtensionRuntime ? (module as RunnerApi) : undefined;
  } catch {
    return undefined;
  }
}

function realRunner(api: RunnerApi, deps: Deps, override?: (event: unknown, ctx: unknown) => Promise<unknown>) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    appendEntry: () => {},
    registerEntryRenderer: () => {},
  };
  register(pi as never, deps);
  if (override) handlers.set('session_before_compact', [override]);
  const extension = {
    path: 'pi-jev',
    resolvedPath: 'pi-jev',
    sourceInfo: { path: 'pi-jev', source: 'extension', scope: 'temporary', origin: 'top-level' },
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  const runner = new api.ExtensionRunner([extension], api.createExtensionRuntime(), process.cwd(), {}, {});
  runner.getModel = () => ({ contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: TEST_MODEL.id });
  runner.setUIContext(undefined, 'print'); // headless: print/json/subagents
  const errors: unknown[] = [];
  runner.onError(error => void errors.push(error));
  return { runner, errors };
}

test('the real Pi runner gets {cancel:true} after invalidate(), when every ctx getter throws', async t => {
  const api = await loadPiRelease();
  if (!api) return t.skip('no installed Pi release');
  const deps = failingDeps();

  const { runner, errors } = realRunner(api, deps);
  assert.deepEqual(await runner.emit(piEvent()), { cancel: true }, 'a failing Jev compaction cancels; Pi never summarizes on its own');

  // Pi's ExtensionContext reads call assertActive(), which throws once the runner is
  // invalidated (session replacement, fork, reload). The hook must be throw-proof
  // anyway: a rejection is swallowed by the runner, whose result stays undefined —
  // exactly the state in which Pi's built-in summary runs without consent.
  const stale = realRunner(api, deps);
  stale.runner.invalidate('This extension ctx is stale after session replacement or reload.');
  assert.deepEqual(await stale.runner.emit(piEvent()), { cancel: true }, 'a stale ctx still cancels, never native');
  assert.deepEqual(stale.errors, [], 'the hook swallowed its own throw, so the runner reports no extension error');

  // Control: a handler that does throw is swallowed by the runner, whose result stays
  // undefined — exactly the state in which Pi's built-in summary would run.
  const thrown = realRunner(api, deps, async () => { throw new Error('handler boom'); });
  assert.equal(await thrown.runner.emit(piEvent()), undefined);
  assert.equal(thrown.errors.length, 1, 'the runner caught and reported the throw instead of failing the compaction');
});

// ---------------------------------------------------------------------------
// J3: the installed CLI's own print path turns a headless cancel into exit 1
// ---------------------------------------------------------------------------

test('the installed CLI print path exits 1 when a headless Jev failure cancels', async t => {
  const child = join(dirname(fileURLToPath(import.meta.url)), 'support', 'cli-exit-child.ts');
  const packageRoot = dirname(dirname(child));
  const run = spawnSync(process.execPath, ['--import', 'tsx', child], { cwd: packageRoot, encoding: 'utf8', timeout: 60_000 });
  const lines = (run.stdout ?? '').trim().split('\n').filter(Boolean);
  let parsed: { skip?: string; hookResult?: unknown; runPrintModeResult?: number; processExitCode?: number };
  try {
    parsed = JSON.parse(lines.at(-1) ?? '');
  } catch {
    throw new Error(`the child produced no JSON result:\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  }
  if (parsed.skip) return t.skip(parsed.skip);
  assert.deepEqual(parsed.hookResult, { cancel: true }, 'the hook cancels');
  assert.equal(parsed.runPrintModeResult, 0, "Pi's own print mode sees a successful stop and returns 0");
  assert.equal(parsed.processExitCode, 1, "the extension's nonzero exit code survives main.js");
  assert.equal(run.status, 1, `the child process exits 1 (stderr: ${run.stderr})`);
});


test('request provenance survives native Jev details and telemetry', async () => {
  const deps = testDeps();
  const compaction = compactionOf(await handleCompact(piEvent({ reason: 'threshold', origin: 'extension', requestId: 'req-1' }), piCtx(), deps));
  assert.equal(compaction.details.jev.origin, 'extension'); assert.equal(compaction.details.jev.requestId, 'req-1');
  const [row] = await logOf(deps.config); assert.equal(row.origin, 'extension'); assert.equal(row.requestId, 'req-1');
});

for (const mode of ['tui', 'rpc', 'print', 'json']) {
  test(`detector failure in ${mode} cancels without chooser, notice, fallback or exit change`, async () => {
    const deps = testDeps({ compact: async () => { throw new JevError('network', 'synthetic detector cause'); } });
    const notes: string[] = [], statuses: any[] = []; let choices = 0;
    const ctx = piCtx(notes, undefined, undefined, { mode, hasUI: true, select: async () => { choices++; return NATIVE; } });
    ctx.ui!.setStatus = (...args) => { statuses.push(args); };
    const argv = process.argv[1], exit = process.exitCode;
    try {
      process.argv[1] = '/nonexistent/pi-install/dist/cli.js'; process.exitCode = 7;
      cancelOf(await handleCompact(piEvent({ reason: 'threshold', origin: 'extension', requestId: 'req-fail' }), ctx, deps));
      assert.equal(choices, 0); assert.deepEqual(notes, []); assert.deepEqual(statuses, []); assert.equal(process.exitCode, 7);
      const [row] = await logOf(deps.config); assert.equal(row.engine, 'cancelled'); assert.equal(row.reason, 'network');
      assert.equal(row.cause, 'synthetic detector cause'); assert.equal(row.requestId, 'req-fail');
    } finally { process.argv[1] = argv; process.exitCode = exit; }
  });
}

test('detector last-resort failure never marks the CLI exit code', async () => {
  const deps = testDeps({ now: () => { throw new Error('broken clock'); } });
  const argv = process.argv[1], exit = process.exitCode;
  try {
    process.argv[1] = '/nonexistent/pi-install/dist/cli.js'; process.exitCode = 7;
    cancelOf(await handleCompact(piEvent({ origin: 'extension', requestId: 'req-last' }), piCtx([], undefined, undefined, { mode: 'print' }), deps));
    assert.equal(process.exitCode, 7);
  } finally { process.argv[1] = argv; process.exitCode = exit; }
});


test('detector local failure skips the configured hosted retry', async () => {
  let passes = 0;
  const deps = testDeps({ compact: async () => { passes++; throw new JevError('network', 'local detector cause'); } });
  Object.assign(deps.config.api, { backend: 'local', localModel: 'clm', localEndpoint: 'http://127.0.0.1:18360/v1/systemone-local', fallback: 'typesafe' });
  cancelOf(await handleCompact(piEvent({ reason: 'threshold', origin: 'extension', requestId: 'req-local' }), piCtx(), deps));
  assert.equal(passes, 1); const rows = await logOf(deps.config); assert.equal(rows.length, 1);
  assert.equal(rows[0].resolution, 'cancelled'); assert.equal(rows[0].cause, 'local detector cause');
});

test('a branch with no response after the previous compaction carries its overhead', async () => {
  const deps = testDeps();
  const first = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  const entry = { type: 'compaction', fromHook: true, summary: first.summary, details: JSON.parse(JSON.stringify(first.details)) };
  // tokensBefore below the estimator's own count: no assistant response since the previous
  // compaction can calibrate O, so it is carried from that compaction's recorded overhead.
  const second = compactionOf(await handleCompact(piEvent({ branchEntries: [entry], preparation: { tokensBefore: 100_000 } }), piCtx(), deps));
  assert.deepEqual(second.details.jev.overhead, {
    tokens: first.details.jev.overhead.tokens,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    provenance: 'carried',
  });
  assert.equal((await logOf(deps.config))[1]!.overhead_provenance, 'carried');
});

// ---------------------------------------------------------------------------
// D2-D4: no automatic fallback to Pi's built-in summary, an explicit chooser
// ---------------------------------------------------------------------------

/** A deps whose Jev call always fails with `kind`, for the choice tests. */
test('detector local failure skips the configured hosted retry', async () => {
  let passes = 0;
  const deps = testDeps({ compact: async () => { passes++; throw new JevError('network', 'local detector cause'); } });
  Object.assign(deps.config.api, { backend: 'local', localModel: 'clm', localEndpoint: 'http://127.0.0.1:18360/v1/systemone-local', fallback: 'typesafe' });
  cancelOf(await handleCompact(piEvent({ reason: 'threshold', origin: 'extension', requestId: 'req-local' }), piCtx(), deps));
  assert.equal(passes, 1); const rows = await logOf(deps.config); assert.equal(rows.length, 1);
  assert.equal(rows[0].resolution, 'cancelled'); assert.equal(rows[0].cause, 'local detector cause');
});


test('detector minimum reduction cancels the fresh engine result without a success-shaped telemetry row', async () => {
  const deps = testDeps(); const notes: string[] = []; let chooser = 0;
  const ctx = piCtx(notes, undefined, undefined, { hasUI: true, select: async () => { chooser++; return NATIVE; } });
  cancelOf(await handleCompact(piEvent({ origin: 'extension', requestId: 'minimum' }), ctx, deps, 120000));
  assert.equal(chooser, 0); assert.deepEqual(notes, []);
  const [row] = await logOf(deps.config); assert.equal(row.engine, 'cancelled'); assert.equal(row.reason, 'no_progress');
  compactionOf(await handleCompact(piEvent(), piCtx(), testDeps(), 120000));
});

test('detector reduction gate and replay netReduction are the same quantity on the same result', async () => {
  const compaction = compactionOf(await handleCompact(piEvent({ origin: 'extension', requestId: 'unit' }), piCtx(), testDeps()));
  // Gate: tokensBefore - estimatedTokensAfter. Replay records tokensBefore - details.jev.budget.predictedAfter.
  assert.equal(compaction.estimatedTokensAfter, compaction.details.jev.budget.predictedAfter);
  const reduction = compaction.tokensBefore - compaction.estimatedTokensAfter;
  compactionOf(await handleCompact(piEvent({ origin: 'extension', requestId: 'unit-eq' }), piCtx(), testDeps(), reduction));
  cancelOf(await handleCompact(piEvent({ origin: 'extension', requestId: 'unit-over' }), piCtx(), testDeps(), reduction + 1));
});


test('recovery stats survive saved native details and snake-case telemetry fields', async () => {
  const deps = testDeps();
  const compaction = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  const [line] = await logOf(deps.config);
  for (const key of ['capped', 'stubbed', 'unlinked'] as const) {
    assert.equal(typeof compaction.details.jev.stats[key], 'number');
    assert.equal(typeof line![key], 'number');
    assert.equal(line![key], compaction.details.jev.stats[key]);
  }
});
