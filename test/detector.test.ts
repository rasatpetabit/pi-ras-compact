import { EventEmitter } from 'node:events';
import { writeDetectorRow } from '../src/pi/detector.js';
import { setLedgerFs, flushTelemetry } from '../src/client/ledger.js';
import { homedir } from 'node:os';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { shadowObserver, detectorQuestionLimit, installedDetectorApi, type DetectorDeps, type DetectorContext } from '../src/pi/detector.js';
import { loadConfig } from '../src/client/config.js';
import { loadDetectorConfig } from '../src/client/detector-config.js';
import { type WarrantParams } from '../src/core/warrant.js';
import { register } from '../src/pi/extension.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piInstallCli } from './support/pi-install.js';

// The installed CLI entry, located from PI_PACKAGE_DIR or the `pi` on PATH.
const piCli = piInstallCli();

// Synthetic parameters, never production calibration/defaults.
const params: WarrantParams = { mode: 'shadow', pressureFloor: .5, minCandidateTokens: 10,
  maxSampleTokens: 5000, minReclaimTokens: 10, minSafeBoundary: .8, minNetReductionTokens: 10,
  rearmGrowthTokens: 100, cooldownMs: 100, failureBackoffMs: 200, requestTimeoutMs: 2000, calibration: 'test-only' };
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(check: () => boolean) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } throw new Error('test wait expired'); }
function gate() { let release!: (value?: any) => void; const promise = new Promise<any>(r => { release = r; }); return { promise, release }; }
function fixture() {
  const loaded = loadConfig(undefined, { backend: false }); assert.ok(loaded.ok);
  let config: any = { ...params }, compaction: any = structuredClone(loaded), now = 1000, calls = 0, adapters = 0, pending = false, idle = true;
  const result = { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'obsolete output '.repeat(100) }], isError: false, timestamp: 1 };
  const span = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'file.txt' } }], timestamp: 1 }, result,
    { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 1 }];
  const branch: any[] = [{ type: 'message', id: 'operator', message: { role: 'user', content: 'Finish the inspection.' } }, ...span.map((message, i) => ({ type: 'message', id: `e${i}`, message })), { type: 'message', id: 'tail', message: { role: 'assistant', content: 'completed', stopReason: 'stop', provider: 'p', model: 'm', usage: { totalTokens: 6000 } } }];
  let session = 's', leaf = 'tail', model = { provider: 'p', id: 'm', contextWindow: 10000 }, tokens: number | null = 6000;
  let settings: any = { compaction: { keepRecentTokens: 100, reserveTokens: 100, enabled: true } };
  const rows: any[] = [], signals: AbortSignal[] = [], asked: any[] = [];
  let ask: (state: any, questions: any) => Promise<any> = async (_s, questions) => ({ answers: Object.fromEntries(Object.entries(questions).map(([id, q]: any) => [id, q.type === 'choice' ? { type: 'choice', choice: 'safe', probabilities: { safe: .9, live: .05, uncertain: .05 }, confidence: .2 } : { type: 'noul', noul: 0 }])) });
  const ctx: DetectorContext = { cwd: '/test', get model() { return model; }, sessionManager: { getSessionId: () => session, getLeafId: () => leaf, getBranch: () => branch, getEntries: () => branch },
    getContextUsage: () => ({ tokens, contextWindow: model.contextWindow }), isIdle: () => idle, hasPendingMessages: () => pending };
  Object.defineProperty(ctx, 'compact', { get() { throw new Error('NO compaction ever'); } });
  Object.defineProperty(ctx, 'ui', { get() { throw new Error('NO chat notifications'); } });
  const deps: DetectorDeps = { loadDetector: () => structuredClone(config), loadCompaction: () => structuredClone(compaction), getSettings: () => structuredClone(settings),
    native: async () => { adapters++; return { prepare: () => ({ firstKeptEntryId: 'tail', messagesToSummarize: span, turnPrefixMessages: [] }), systemText: () => '', settings: () => settings.compaction }; },
    inputLimit: async () => null, questionLimit: detectorQuestionLimit, now: () => now, fallbackLogDir: '/fallback/telemetry', write: row => rows.push(row),
    makeAsker: (_config, _hash, signal) => { signals.push(signal); return { ask: async (state, questions) => { calls++; asked.push({ state, questions }); return ask(state, questions); }, backend_descriptor: { id: 'test', model: 'fixture' } } as any; } };
  const observer = shadowObserver(deps);
  return { observer, ctx, deps, rows, signals, asked, branch, get calls() { return calls; }, get adapters() { return adapters; },
    setConfig(v: any) { config = v; }, setLoaded(v: any) { compaction = v; }, setAsk(fn: typeof ask) { ask = fn; }, setNow(n: number) { now = n; },
    grow(n = 100) { tokens = tokens! + n; leaf += 'x'; branch.push({ type: 'message', id: leaf, message: { ...branch.find(e => e.id === 'tail').message, usage: { totalTokens: tokens } } }); },
    mutate(kind: string) { if (kind === 'session') session += 'x'; else if (kind === 'model') model.id += 'x'; else if (kind === 'config') config.pressureFloor = .1;
      else if (kind === 'compaction_config') compaction.hash += 'x'; else if (kind === 'settings') settings.compaction.keepRecentTokens++;
      else if (kind === 'tree') branch[1].message.content[0].name = 'edited'; else if (kind === 'usage') { tokens = null; branch.find(e => e.id === leaf).message.usage = undefined; } else if (kind === 'pending') pending = true; else if (kind === 'busy') idle = false; },
  };
}

// Keep the injected deadline clock and the timer scheduler under test control.
// setImmediate remains real, so adapter/ask microtasks can drain without expiring a flight.
function deadlineClock(t: TestContext, f: ReturnType<typeof fixture>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = f.deps.now();
  return { advance(ms: number) { now += ms; f.setNow(now); t.mock.timers.tick(ms); } };
}

test('absent and malformed/off modes never snapshot, ask, write or compact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-detector-test-'));
  try {
    assert.deepEqual(loadDetectorConfig(join(dir, 'jev.toml')), { mode: 'off' });
    writeFileSync(join(dir, 'jev.detector.toml'), 'mode = "shadow"\n');
    assert.deepEqual(loadDetectorConfig(join(dir, 'jev.toml')), { mode: 'off' });
    writeFileSync(join(dir, 'jev.detector.toml'), '[broken');
    assert.deepEqual(loadDetectorConfig(join(dir, 'jev.toml')), { mode: 'off' });
  } finally { rmSync(dir, { recursive: true }); }
  for (const config of [{ mode: 'off' }]) {
    const f = fixture(); f.setConfig(config); Object.defineProperty(f.ctx, 'sessionManager', { get() { throw new Error('disabled snapshot'); } });
    assert.equal(f.observer.settled(f.ctx), undefined); await tick(); assert.equal(f.adapters, 0); assert.equal(f.calls, 0); assert.equal(f.rows.length, 0);
  }
});

test('immediate return, one bounded request, one counts-only telemetry row; no action API touched', async () => {
  const f = fixture(); assert.equal(f.observer.settled(f.ctx), undefined); assert.equal(f.calls, 0); assert.equal(f.rows.length, 0);
  await until(() => f.rows.length === 1); assert.equal(f.calls, 1);
  const row = f.rows[0]; assert.equal(row.mode, 'shadow'); assert.equal(row.outcome, 'warranted'); assert.ok(row.score > 10); assert.equal(row.safeBoundary, .9);
  assert.equal(row.actionTaken, false); assert.equal(row.tokens.before, 6000); assert.ok(row.tokens.request <= params.maxSampleTokens);
  assert.ok(Number.isFinite(row.requestBuildLatencyMs) && row.requestBuildLatencyMs >= 0);
  assert.match(row.attemptId, /^[\da-f-]{36}$/); assert.deepEqual(row.backendDescriptor, { id: 'test', model: 'fixture' }); assert.equal(row.latencyMs, 0);
  assert.ok(!JSON.stringify(row).includes('obsolete output')); assert.ok(!JSON.stringify(row).includes('file.txt'));
});

for (const kind of ['input', 'session_start', 'model_select', 'reload', 'shutdown', 'compaction', 'session', 'model', 'config', 'compaction_config', 'settings', 'tree', 'usage', 'pending', 'busy']) {
  test(`late result invalidated after ${kind}, including ignored cancellation`, async () => {
    const f = fixture(), blocked = gate(); f.setAsk(() => blocked.promise); f.observer.settled(f.ctx); await until(() => f.calls === 1);
    if (kind === 'compaction') f.observer.compaction(f.ctx);
    else if (['session_start', 'shutdown'].includes(kind)) f.observer.reset(f.ctx);
    else if (['input', 'model_select', 'reload'].includes(kind)) f.observer.invalidate(f.ctx);
    else f.mutate(kind);
    blocked.release({ answers: {} }); await until(() => f.rows.length === 1);
    assert.deepEqual(f.rows[0].reasons, ['stale_result']); assert.equal(f.rows[0].score, 0); assert.equal(f.rows[0].safeBoundary, null); assert.equal(f.rows[0].actionTaken, false);
  });
}

test('single flight survives invalidation and ignored abort before its deadline', async () => {
  const f = fixture(), blocked = gate(); f.setAsk(() => blocked.promise); f.observer.settled(f.ctx); await until(() => f.calls === 1);
  f.observer.invalidate(f.ctx); assert.equal(f.signals[0].aborted, true); f.grow();
  f.observer.settled(f.ctx); await tick(); assert.equal(f.calls, 1);
  blocked.release({ answers: {} }); await until(() => f.rows.length === 1); await tick();
  f.setAsk(async () => ({ answers: {} })); f.observer.settled(f.ctx); await until(() => f.rows.length === 2); assert.equal(f.calls, 2);
});

for (const late of ['response', 'failure'] as const) {
  test(`timeout emits exactly once, releases ownership and rejects late ${late}`, async t => {
    const f = fixture(), clock = deadlineClock(t, f), blocked = gate();
    f.setAsk(() => late === 'failure' ? blocked.promise.then(() => { throw new Error('late failure'); }) : blocked.promise);
    f.observer.settled(f.ctx); await tick(); assert.equal(f.calls, 1);
    clock.advance(params.requestTimeoutMs - 1); assert.equal(f.rows.length, 0);
    clock.advance(1); assert.deepEqual(f.rows[0].reasons, ['request_timeout']); assert.equal(f.rows.length, 1); assert.equal(f.signals[0].aborted, true);
    f.grow(); f.observer.settled(f.ctx); await tick(); assert.equal(f.rows.length, 2);
    assert.deepEqual(f.rows[1].reasons, ['failure_backoff']); assert.equal(f.calls, 1);
    clock.advance(params.failureBackoffMs); const replacement = gate(); f.setAsk(() => replacement.promise);
    f.observer.settled(f.ctx); await tick(); assert.equal(f.calls, 2);
    blocked.release({ answers: {} }); await tick(); await tick(); assert.equal(f.rows.length, 2);
    // The old finally must not release the replacement flight.
    f.observer.settled(f.ctx); await tick(); assert.equal(f.calls, 2); assert.equal(f.rows.length, 2);
    assert.equal(f.signals[1].aborted, false);
    replacement.release({ answers: {} }); await tick(); assert.equal(f.rows.length, 3);
    assert.deepEqual(f.rows[2].reasons, ['answers_malformed']);
    assert.equal(new Set(f.rows.map(row => row.attemptId)).size, 3);
    clock.advance(params.requestTimeoutMs); await tick(); assert.equal(f.rows.length, 3);
    assert.equal(f.signals[1].aborted, false); // Completed work cleared its deadline.
  });
}

test('whole deadline includes adapter loading', async t => {
  const f = fixture(), clock = deadlineClock(t, f), blocked = gate(); f.deps.native = () => blocked.promise;
  f.observer.settled(f.ctx); await tick(); assert.equal(f.rows.length, 0);
  clock.advance(params.requestTimeoutMs); assert.equal(f.rows.length, 1); assert.equal(f.calls, 0); assert.deepEqual(f.rows[0].reasons, ['request_timeout']);
  blocked.release({}); await tick(); await tick(); assert.equal(f.rows.length, 1);
});

test('unknown native adapter, low pressure, invalid compaction config, pending/busy never ask', async () => {
  for (const kind of ['adapter', 'usage', 'pending', 'busy', 'invalid', 'disabled', 'pressure']) {
    const f = fixture();
    if (kind === 'adapter') f.deps.native = async () => { throw new Error('missing'); };
    else if (kind === 'invalid') f.setLoaded({ ok: false, errors: ['synthetic'] });
    else if (kind === 'disabled') { const l = f.deps.loadCompaction(); assert.ok(l.ok); l.config.compaction.enabled = false; f.setLoaded(l); }
    else if (kind === 'pressure') f.setConfig({ ...params, pressureFloor: .9 });
    else f.mutate(kind);
    f.observer.settled(f.ctx); await until(() => f.rows.length === 1); assert.equal(f.calls, 0); assert.equal(f.rows[0].outcome, 'defer');
  }
});

test('same snapshot, compaction cooldown, failure backoff and low-score rearming', async () => {
  const f = fixture(); f.observer.settled(f.ctx); await until(() => f.rows.length === 1); await tick();
  f.observer.settled(f.ctx); await until(() => f.rows.length === 2); assert.ok(f.rows[1].reasons.includes('same_snapshot')); assert.equal(f.calls, 1);
  f.grow(); f.observer.compaction(f.ctx); f.observer.settled(f.ctx); await until(() => f.rows.length === 3); assert.ok(f.rows[2].reasons.includes('cooldown'));
  f.setNow(1100); f.setAsk(async () => { throw new Error('network'); }); f.observer.settled(f.ctx); await until(() => f.rows.length === 4); assert.deepEqual(f.rows[3].reasons, ['assessment_error']);
  f.grow(); f.observer.settled(f.ctx); await until(() => f.rows.length === 5); assert.ok(f.rows[4].reasons.includes('failure_backoff')); assert.equal(f.calls, 2);
  f.setNow(1300); f.setAsk(async (_s, qs) => ({ answers: Object.fromEntries(Object.entries(qs).map(([id, q]: any) => [id, q.type === 'choice' ? { choice: 'safe', probabilities: { safe: 1, live: 0, uncertain: 0 }, confidence: .4 } : { noul: 1 }])) }));
  f.observer.settled(f.ctx); await until(() => f.rows.length === 6); assert.equal(f.rows[5].outcome, 'suppress'); assert.equal(f.calls, 3);
  f.grow(99); f.observer.settled(f.ctx); await until(() => f.rows.length === 7); assert.deepEqual(f.rows[6].reasons, ['rearm_growth_pending']); assert.equal(f.calls, 3);
  f.grow(1); f.observer.settled(f.ctx); await until(() => f.rows.length === 8); assert.equal(f.calls, 4);
});

test('model/config scope change resets same-snapshot assessment history', async () => {
  const f = fixture(); f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
  f.mutate('model'); f.branch.at(-1).message.model = f.ctx.model!.id; f.observer.settled(f.ctx); await until(() => f.rows.length === 2); assert.equal(f.calls, 2);
  f.mutate('config'); f.observer.settled(f.ctx); await until(() => f.rows.length === 3); assert.equal(f.calls, 3);
});

test('registration adds synchronous observer and terminal request listener; no before-settle hook', () => {
  const handlers = new Map<string, any[]>(); const pi: any = { on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, registerEntryRenderer() {}, appendEntry() {} };
  register(pi, { now: Date.now } as any);
  for (const event of ['agent_settled', 'input', 'session_start', 'session_shutdown', 'model_select', 'session_tree', 'session_before_tree', 'session_before_switch', 'session_before_fork', 'session_before_compact', 'session_compact', 'session_compact_failed', 'compaction_request_end']) assert.ok(handlers.has(event), event);
  assert.ok(!handlers.has('agent_before_settle'));
  const source = readFileSync(new URL('../src/pi/detector.ts', import.meta.url), 'utf8');
  assert.ok(!/\.compact\(|sendUserMessage\(|\.notify\(/.test(source));
});


test('installed native preparation adapter uses current Pi and model-specific settings, with actual candidate span', { skip: !piCli }, async () => {
  const argv = process.argv[1];
  try {
    process.argv[1] = piCli!;
    const native = await installedDetectorApi();
    const settings = native.settings({ compaction: { enabled: true, keepRecentTokens: 1000, reserveTokens: 2000,
      modelOverrides: { 'p/m': { keepRecentTokens: 100 } } } }, { provider: 'p', id: 'm' });
    assert.equal(settings.keepRecentTokens, 100); assert.equal(settings.reserveTokens, 2000);
    const f = fixture(); f.deps.native = async () => ({ ...native, prepare(entries, settings) { const p = native.prepare(entries, settings); assert.ok(p, JSON.stringify(entries)); return p; } });
    const copyCall = structuredClone(f.branch[1]); copyCall.id = 'extra-call'; copyCall.message.content[0].id = 'call-extra';
    const copyResult = structuredClone(f.branch[2]); copyResult.id = 'extra-result'; copyResult.message.toolCallId = 'call-extra';
    f.branch.splice(2, 0, copyCall, copyResult);
    f.branch.unshift({ type: 'message', id: 'user0', message: { role: 'user', content: [{ type: 'text', text: 'old task' }], timestamp: 1 } });
    f.branch.forEach((e, i) => { e.parentId = i ? f.branch[i - 1].id : null; e.timestamp = new Date(1).toISOString(); });
    f.branch.splice(f.branch.length - 1, 0, { type: 'message', id: 'recent-user', message: { role: 'user', content: 'Report the inspection.', timestamp: 2 } });
    f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
    assert.equal(f.calls, 1, JSON.stringify(f.rows)); assert.equal(f.rows[0].outcome, 'warranted');
    assert.ok(f.asked[0].state.outputs[0].output.includes('obsolete output'));
  } finally { process.argv[1] = argv; }
});

test('missing/incompatible native installation defers rather than using a substitute', async () => {
  const argv = process.argv[1];
  try { process.argv[1] = import.meta.filename; await assert.rejects(installedDetectorApi(), /Pi installation unavailable/); }
  finally { process.argv[1] = argv; }
});


test('off-branch tree edits invalidate late answers', async () => {
  const f = fixture(), blocked = gate(), detached: any = { type: 'message', id: 'detached', message: 'old' };
  f.ctx.sessionManager.getEntries = () => [...f.branch, detached];
  f.setAsk(() => blocked.promise); f.observer.settled(f.ctx); await until(() => f.calls === 1);
  detached.message = 'edited'; blocked.release({ answers: {} }); await until(() => f.rows.length === 1);
  assert.deepEqual(f.rows[0].reasons, ['stale_result']);
});

test('off during assessment cancels on the next settled event and discards late answer', async () => {
  const f = fixture(), blocked = gate(); f.setAsk(() => blocked.promise); f.observer.settled(f.ctx); await until(() => f.calls === 1);
  f.setConfig({ mode: 'off' }); f.observer.settled(f.ctx); assert.equal(f.signals[0].aborted, true);
  blocked.release({ answers: {} }); await until(() => f.rows.length === 1); assert.deepEqual(f.rows[0].reasons, ['stale_result']); assert.equal(f.calls, 1);
});


test('mutation before background dispatch discards snapshot without asking', async () => {
  const f = fixture(); f.observer.settled(f.ctx); f.mutate('tree'); await until(() => f.rows.length === 1);
  assert.equal(f.calls, 0); assert.deepEqual(f.rows[0].reasons, ['stale_result']);
});

test('deadline checked on response even before a timer callback can run', async () => {
  const f = fixture(); f.setAsk(async () => { f.setNow(1000 + params.requestTimeoutMs); return { answers: {} }; });
  f.observer.settled(f.ctx); await until(() => f.rows.length === 1); assert.deepEqual(f.rows[0].reasons, ['request_timeout']);
});

test('native candidate adapter reuses configured pins; pinned tool outputs never reach the asker', async () => {
  const f = fixture();
  const loaded = f.deps.loadCompaction(); assert.ok(loaded.ok);
  const config = loaded.config; config.compaction.pins = ['modify', 'error', 'decision', 'instruction', 'boundary'];
  config.compaction.modifyTools = ['edit']; config.compaction.decisionTools = ['ask_user_question']; config.compaction.instructionTools = ['read']; config.compaction.instructionFiles = ['AGENTS.md'];
  f.setLoaded(loaded);
  const types = [ ['modify', 'edit', 'code.ts', false], ['error', 'read', 'bad.txt', true], ['decision', 'ask_user_question', '', false], ['instruction', 'read', 'AGENTS.md', false] ] as const;
  const extra = types.flatMap(([id, name, path, error]) => [
    { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path } }], timestamp: 1 },
    { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: `${id}-PINNED-OUTPUT`.repeat(100) }], isError: error, timestamp: 1 },
  ]);
  f.branch.splice(2, 0, ...extra.map((message, i) => ({ type: 'message', id: `pin${i}`, message })));
  const base = await f.deps.native(); const prepared: any = base.prepare([], {});
  f.deps.native = async () => ({ ...base, prepare: () => ({ ...prepared, messagesToSummarize: [...prepared.messagesToSummarize.slice(0, 2), ...extra, ...prepared.messagesToSummarize.slice(2)] }) });
  f.observer.settled(f.ctx); await until(() => f.rows.length === 1); assert.equal(f.calls, 1);
  const sent = JSON.stringify(f.asked[0]); for (const [id] of types) assert.ok(!sent.includes(`${id}-PINNED-OUTPUT`), id);
});

test('telemetry sink schedules one private JSONL append in the supplied directory', async () => {
  const appended: any[] = [];
  setLedgerFs({ stat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }, mkdir: async () => undefined,
    appendFile: async (...args) => { appended.push(args); } });
  try {
    writeDetectorRow({ mode: 'shadow', outcome: 'defer', actionTaken: false }, '/configured/telemetry'); assert.equal(appended.length, 0);
    await flushTelemetry(); assert.equal(appended.length, 1);
    assert.equal(appended[0][0], '/configured/telemetry/detector.jsonl');
    assert.deepEqual(JSON.parse(appended[0][1]), { mode: 'shadow', outcome: 'defer', actionTaken: false, source: 'live' });
    assert.equal(appended[0][2].mode, 0o600);
  } finally { setLedgerFs(undefined); }
});

// One registration serves multiple sessions: histories alone are not enough to isolate it.
function secondContext(f: ReturnType<typeof fixture>, id: string): DetectorContext {
  return { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getSessionId: () => id } };
}

test('two interleaved sessions own independent flights and invalidation generations', async () => {
  const f = fixture(), b = secondContext(f, 'b'), first = gate(), second = gate();
  f.setAsk(() => f.calls === 1 ? first.promise : second.promise);
  try {
    f.observer.settled(f.ctx); await until(() => f.calls === 1);
    f.observer.settled(b); await tick(); await tick(); assert.equal(f.calls, 2);
    f.observer.invalidate(f.ctx);
    assert.equal(f.signals[0].aborted, true); assert.equal(f.signals[1].aborted, false);
    // Start/shutdown reset in A must not stale B's answer.
    f.observer.reset(f.ctx);
    second.release({ answers: Object.fromEntries(Object.entries(f.asked[1].questions).map(([id, q]: any) =>
      [id, q.type === 'choice' ? { choice: 'safe', probabilities: { safe: .9, live: .05, uncertain: .05 }, confidence: .2 } : { noul: 0 }])) });
    await until(() => f.rows.length === 1); assert.equal(f.rows[0].outcome, 'warranted');
    first.release({ answers: {} }); await until(() => f.rows.length === 2);
    assert.deepEqual(f.rows[1].reasons, ['stale_result']);
    f.observer.settled(b); await until(() => f.rows.length === 3);
    assert.deepEqual(f.rows[2].reasons, ['same_snapshot']);
  } finally { first.release({ answers: {} }); second.release({ answers: {} }); await tick(); await tick(); }
});

test('session cooldown, failure backoff and suppression do not cross session identities', async () => {
  const f = fixture(), b = secondContext(f, 'b');
  f.observer.compaction(f.ctx);
  f.observer.settled(b); await until(() => f.rows.length === 1); assert.equal(f.calls, 1);
  f.observer.settled(f.ctx); await until(() => f.rows.length === 2); assert.deepEqual(f.rows[1].reasons, ['cooldown']);
  f.setNow(1100); f.setAsk(async () => { throw new Error('synthetic'); });
  f.observer.settled(f.ctx); await until(() => f.rows.length === 3);
  f.grow(); f.setAsk(async (_s, qs) => ({ answers: Object.fromEntries(Object.entries(qs).map(([id, q]: any) =>
    [id, q.type === 'choice' ? { choice: 'safe', probabilities: { safe: 1, live: 0, uncertain: 0 }, confidence: .4 } : { noul: 1 }])) }));
  f.observer.settled(b); await until(() => f.rows.length === 4); assert.equal(f.rows[3].outcome, 'suppress'); assert.equal(f.calls, 3);
  f.observer.settled(f.ctx); await until(() => f.rows.length === 5); assert.deepEqual(f.rows[4].reasons, ['failure_backoff']);
  f.setNow(1300); f.grow(1); f.observer.settled(f.ctx); await until(() => f.rows.length === 6); assert.equal(f.calls, 4);
  f.observer.settled(b); await until(() => f.rows.length === 7); assert.deepEqual(f.rows[6].reasons, ['rearm_growth_pending']);
});

test('deadline releases a never-settling asker so a later snapshot can be assessed', async t => {
  const f = fixture(), clock = deadlineClock(t, f);
  f.setAsk(() => new Promise(() => {})); f.observer.settled(f.ctx); await tick(); assert.equal(f.calls, 1); assert.equal(f.rows.length, 0);
  clock.advance(params.requestTimeoutMs); assert.equal(f.rows.length, 1); assert.deepEqual(f.rows[0].reasons, ['request_timeout']);
  assert.equal(f.signals[0].aborted, true);
  clock.advance(params.failureBackoffMs); f.grow(); f.setAsk(async () => ({ answers: {} }));
  f.observer.settled(f.ctx); await tick(); assert.equal(f.rows.length, 2); assert.equal(f.calls, 2);
  assert.deepEqual(f.rows[1].reasons, ['answers_malformed']);
  clock.advance(params.requestTimeoutMs); await tick(); assert.equal(f.rows.length, 2);
  assert.equal(f.signals[1].aborted, false); // a leaked deadline timer would abort the settled flight
});

test('observer supplies the captured configured telemetry directory, with home expansion and invalid-config fallback', async () => {
  for (const path of ['/configured/telemetry/calls.jsonl', '~/custom-jev/calls.jsonl', null]) {
    const f = fixture(), dirs: string[] = [];
    const loaded = f.deps.loadCompaction(); assert.ok(loaded.ok);
    if (path) { loaded.config.telemetry.path = path; f.setLoaded(loaded); }
    else f.setLoaded({ ok: false, errors: ['synthetic'] });
    f.deps.write = (row, dir) => { f.rows.push(row); dirs.push(dir); };
    f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
    assert.deepEqual(dirs, [path === null ? '/fallback/telemetry' : path.startsWith('~') ? join(homedir(), 'custom-jev') : '/configured/telemetry']);
  }
});


test('reset clears only the target session history, including cooldown and failure backoff', async () => {
  const f = fixture(), b = secondContext(f, 'b');
  f.observer.settled(b); await until(() => f.rows.length === 1);
  f.setAsk(async () => { throw new Error('synthetic'); });
  f.observer.settled(f.ctx); await until(() => f.rows.length === 2);
  f.observer.compaction(f.ctx); f.observer.reset(f.ctx);
  f.observer.settled(f.ctx); await until(() => f.rows.length === 3);
  assert.deepEqual(f.rows[2].reasons, ['assessment_error']); assert.equal(f.calls, 3);
  f.observer.settled(b); await until(() => f.rows.length === 4);
  assert.deepEqual(f.rows[3].reasons, ['same_snapshot']); assert.equal(f.calls, 3);
});

test('deadline releases a never-settling adapter as well as an asker', async t => {
  const f = fixture(), clock = deadlineClock(t, f), native = f.deps.native;
  f.deps.native = () => new Promise(() => {}); f.observer.settled(f.ctx); await tick(); assert.equal(f.rows.length, 0);
  clock.advance(params.requestTimeoutMs); assert.equal(f.rows.length, 1); assert.deepEqual(f.rows[0].reasons, ['request_timeout']); assert.equal(f.calls, 0);
  clock.advance(params.failureBackoffMs); f.grow(); f.deps.native = native;
  f.observer.settled(f.ctx); await tick(); assert.equal(f.rows.length, 2); assert.equal(f.calls, 1);
  assert.deepEqual(f.rows[1].reasons, ['reclaim_and_boundary_met']);
  clock.advance(params.requestTimeoutMs); await tick(); assert.equal(f.rows.length, 2);
  assert.equal(f.signals.length, 1); assert.equal(f.signals[0].aborted, false); // a leaked deadline timer would abort the settled flight
});


function recordFixture() {
  const f = fixture(); f.setConfig({ mode: 'record' });
  for (const name of ['native', 'makeAsker', 'getSettings', 'questionLimit'] as const) {
    f.deps[name] = (() => { throw new Error(`record must not call ${name}`); }) as any;
  }
  f.ctx.sessionManager.getEntries = () => { throw new Error('record must not snapshot tree'); };
  return f;
}

test('record emits exactly one immutable allowed-key row per settle, even repeated busy/pending snapshots', async () => {
  const f = recordFixture(), dirs: string[] = [];
  const loaded = f.deps.loadCompaction(); assert.ok(loaded.ok);
  loaded.config.telemetry.path = '/configured/record/calls.jsonl'; f.setLoaded(loaded);
  f.deps.write = (row, dir) => { f.rows.push(row); dirs.push(dir); };
  f.branch.at(-1).message.stopReason = 'stop';
  f.mutate('pending'); f.mutate('busy');
  for (let i = 0; i < 3; i++) assert.equal(f.observer.settled(f.ctx), undefined);
  assert.equal(f.rows.length, 0);
  // Persist the event-time identifiers/counts, not a later live context.
  f.grow(); f.mutate('model'); f.branch.at(-2).message.stopReason = 'error'; f.observer.reset(f.ctx);
  await tick();
  assert.equal(f.rows.length, 3);
  const expected = { ts: new Date(1000).toISOString(), kind: 'settled', mode: 'record', sessionId: 's',
    leafEntryId: 'tail', idle: false, pendingMessages: true, stopReason: 'stop',
    contextTokens: 6000, contextWindow: 10000, model: { provider: 'p', id: 'm' } };
  for (const row of f.rows) assert.deepEqual(row, expected);
  assert.deepEqual(dirs, Array(3).fill('/configured/record'));
  assert.equal(f.adapters, 0); assert.equal(f.calls, 0); assert.deepEqual(f.signals, []);
});

test('record keeps unknown metadata explicit and respects home-expanded or fallback telemetry directory', async () => {
  for (const valid of [true, false]) {
    const f = recordFixture(), dirs: string[] = [];
    const loaded = f.deps.loadCompaction(); assert.ok(loaded.ok);
    loaded.config.telemetry.path = '~/record-jev/calls.jsonl';
    f.setLoaded(valid ? loaded : { ok: false, errors: ['synthetic'] });
    f.ctx.getContextUsage = () => undefined;
    Object.defineProperty(f.ctx, 'model', { get: () => undefined });
    f.ctx.sessionManager.getLeafId = () => null;
    f.deps.write = (row, dir) => { f.rows.push(row); dirs.push(dir); };
    f.observer.settled(f.ctx); await tick();
    assert.equal(f.rows.length, 1);
    assert.deepEqual(f.rows[0], { ts: new Date(1000).toISOString(), kind: 'settled', mode: 'record', sessionId: 's',
      leafEntryId: null, idle: true, pendingMessages: false, stopReason: null,
      contextTokens: null, contextWindow: null, model: { provider: null, id: null } });
    assert.deepEqual(dirs, [valid ? join(homedir(), 'record-jev') : '/fallback/telemetry']);
  }
});

test('record settles in interleaved sessions remain isolated; write failure never escapes', async () => {
  const f = recordFixture(), b = secondContext(f, 'b');
  f.observer.settled(f.ctx); f.observer.reset(f.ctx); f.observer.settled(b); f.observer.settled(f.ctx);
  await tick(); assert.deepEqual(f.rows.map(row => row.sessionId), ['s', 'b', 's']);
  f.deps.write = () => { throw new Error('unavailable sink'); };
  assert.doesNotThrow(() => f.observer.settled(f.ctx)); await tick();
});

test('switching shadow to record invalidates the old assessment but still records every settle', async () => {
  const f = fixture(), blocked = gate(); f.setAsk(() => blocked.promise);
  f.observer.settled(f.ctx); await until(() => f.calls === 1);
  f.setConfig({ mode: 'record' }); f.observer.settled(f.ctx); f.observer.settled(f.ctx);
  assert.equal(f.signals[0].aborted, true);
  await tick(); assert.equal(f.rows.filter(row => row.kind === 'settled').length, 2);
  blocked.release({ answers: {} }); await until(() => f.rows.length === 3);
  assert.deepEqual(f.rows.find(row => row.mode === 'shadow').reasons, ['stale_result']);
  assert.equal(f.calls, 1);
});


test('record uses only the exact leaf stop reason and falls back to the current model window', async () => {
  const f = recordFixture();
  f.branch.at(-1).message.stopReason = 'stop';
  f.grow(); f.branch.at(-1).type = 'custom'; delete f.branch.at(-1).message; // No borrowed assistant stop.
  f.ctx.getContextUsage = () => undefined;
  f.observer.settled(f.ctx); await tick();
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].leafEntryId, 'tailx'); assert.equal(f.rows[0].stopReason, null);
  assert.equal(f.rows[0].contextTokens, null); assert.equal(f.rows[0].contextWindow, 10000);
});

test('record uses the non-blocking private detector sink, one JSONL append per settle', async () => {
  const appended: any[] = [];
  setLedgerFs({ stat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }, mkdir: async () => undefined,
    appendFile: async (...args) => { appended.push(args); } });
  try {
    const f = recordFixture();
    const loaded = f.deps.loadCompaction(); assert.ok(loaded.ok);
    loaded.config.telemetry.path = '/configured/record/calls.jsonl'; f.setLoaded(loaded);
    f.deps.write = writeDetectorRow;
    f.observer.settled(f.ctx); f.observer.settled(f.ctx);
    assert.equal(appended.length, 0);
    await tick(); await flushTelemetry(); assert.equal(appended.length, 2);
    for (const [path, text, options] of appended) {
      assert.equal(path, '/configured/record/detector.jsonl'); assert.equal(options.mode, 0o600);
      assert.equal(text.trim().split('\n').length, 1);
      const row = JSON.parse(text);
      assert.deepEqual(Object.keys(row).sort(), ['ts', 'kind', 'mode', 'sessionId', 'leafEntryId', 'idle', 'pendingMessages', 'stopReason', 'contextTokens', 'contextWindow', 'model', 'source'].sort());
      assert.deepEqual(Object.keys(row.model).sort(), ['id', 'provider']);
      assert.equal(row.mode, 'record'); assert.equal(row.kind, 'settled');
    }
  } finally { setLedgerFs(undefined); }
});

// Installed pi-ai/dist/types.d.ts StopReason union, including non-terminal states.
for (const stopReason of ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred',
  'private transcript text', '', 'STOP', '__proto__', null, 42, { text: 'private' }]) {
  test(`record stopReason allowlist: ${JSON.stringify(stopReason)}`, async () => {
    const f = recordFixture(); f.branch.at(-1).message.stopReason = stopReason;
    f.observer.settled(f.ctx); await tick();
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].stopReason, ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(stopReason as string) ? stopReason : null);
  });
}

const throws = () => { throw new Error('private getter failure'); };
const throwingGetter = (target: object, key: string) => Object.defineProperty(target, key, { configurable: true, get: throws });
const throwingRecordFields: [string, (f: ReturnType<typeof recordFixture>) => void, string[]][] = [
  ['timestamp', f => { f.deps.now = throws; }, ['ts']],
  ['sessionManager', f => throwingGetter(f.ctx, 'sessionManager'), ['sessionId', 'leafEntryId', 'stopReason']],
  ['sessionId', f => throwingGetter(f.ctx.sessionManager, 'getSessionId'), ['sessionId']],
  ['leafEntryId', f => throwingGetter(f.ctx.sessionManager, 'getLeafId'), ['leafEntryId', 'stopReason']],
  ['branch', f => throwingGetter(f.ctx.sessionManager, 'getBranch'), ['stopReason']],
  ['leaf message', f => throwingGetter(f.branch.at(-1), 'message'), ['stopReason']],
  ['stopReason', f => throwingGetter(f.branch.at(-1).message, 'stopReason'), ['stopReason']],
  ['idle', f => throwingGetter(f.ctx, 'isIdle'), ['idle']],
  ['pendingMessages', f => throwingGetter(f.ctx, 'hasPendingMessages'), ['pendingMessages']],
  ['usage', f => throwingGetter(f.ctx, 'getContextUsage'), ['contextTokens']], // window falls back to the model
  ['contextTokens', f => { f.ctx.getContextUsage = () => ({ get tokens() { return throws(); }, contextWindow: 10000 }); }, ['contextTokens']],
  ['contextWindow', f => { f.ctx.getContextUsage = () => ({ tokens: 6000, get contextWindow() { return throws(); } }); }, []],
  ['model', f => { f.ctx.getContextUsage = () => undefined; throwingGetter(f.ctx, 'model'); }, ['contextTokens', 'contextWindow', 'model.provider', 'model.id']],
  ['model provider', f => throwingGetter(f.ctx.model!, 'provider'), ['model.provider']],
  ['model id', f => throwingGetter(f.ctx.model!, 'id'), ['model.id']],
  ['model window', f => { f.ctx.getContextUsage = () => undefined; throwingGetter(f.ctx.model!, 'contextWindow'); }, ['contextTokens', 'contextWindow']],
];
for (const [name, corrupt, nullFields] of throwingRecordFields) {
  test(`record isolates throwing ${name} getter and still writes one row`, async () => {
    const f = recordFixture(); f.branch.at(-1).message.stopReason = 'stop'; corrupt(f);
    assert.doesNotThrow(() => f.observer.settled(f.ctx)); await tick();
    assert.equal(f.rows.length, 1);
    const expected: any = { ts: new Date(1000).toISOString(), kind: 'settled', mode: 'record', sessionId: 's',
      leafEntryId: 'tail', idle: true, pendingMessages: false, stopReason: 'stop',
      contextTokens: 6000, contextWindow: 10000, model: { provider: 'p', id: 'm' } };
    for (const field of nullFields) {
      if (field.startsWith('model.')) expected.model[field.slice(6)] = null;
      else expected[field] = null;
    }
    assert.deepEqual(f.rows[0], expected);
    assert.equal(f.adapters, 0); assert.equal(f.calls, 0);
  });
}

for (const source of ['loader', 'telemetry', 'path']) {
  test(`record falls back when telemetry ${source} throws`, async () => {
    const f = recordFixture(), dirs: string[] = [];
    const loaded = f.deps.loadCompaction(); assert.ok(loaded.ok);
    if (source === 'loader') f.deps.loadCompaction = throws;
    else {
      throwingGetter(source === 'path' ? loaded.config.telemetry : loaded.config, source === 'path' ? 'path' : 'telemetry');
      f.deps.loadCompaction = () => loaded;
    }
    f.deps.write = (row, dir) => { f.rows.push(row); dirs.push(dir); };
    assert.doesNotThrow(() => f.observer.settled(f.ctx)); await tick();
    assert.equal(f.rows.length, 1); assert.deepEqual(dirs, ['/fallback/telemetry']);
  });
}

// Core's synchronous arm operation starts nothing; only accepted requests get a terminal event.
function activeFixture(refusal?: 'disabled' | 'compacting' | 'invalid') {
  const f = fixture(), requests: any[] = [], events = new EventEmitter();
  events.on('compaction_request_end', (event, ctx) => f.observer.requestEnd(event, ctx));
  f.setConfig({ ...params, mode: 'active' });
  f.ctx.requestNativeCompaction = options => {
    requests.push(options);
    return refusal ? { accepted: false, reason: refusal } : { accepted: true };
  };
  const end = (outcome: string, reason?: string, ctx = f.ctx, requestId = requests.at(-1)?.requestId) =>
    events.emit('compaction_request_end', { type: 'compaction_request_end', origin: 'extension', requestId, outcome, ...(reason ? { reason } : {}) }, ctx);
  return { ...f, requests, end };
}

test('active arms exactly one fresh request, stays pending across reset, and records settled metadata', async () => {
  const f = activeFixture(); f.branch.at(-1).message.stopReason = 'stop';
  assert.equal(f.observer.settled(f.ctx), undefined); assert.equal(f.requests.length, 0);
  await until(() => f.rows.length === 1);
  assert.equal(f.requests.length, 1); assert.match(f.requests[0].requestId, /^[\da-f-]{36}$/);
  assert.equal(f.requests[0].origin, 'extension');
  assert.notEqual(f.requests[0].requestId, f.rows[0].attemptId);
  assert.equal(f.rows[0].action, 'requested'); assert.equal(f.rows[0].actionTaken, true);
  assert.equal(f.rows[0].requestId, f.requests[0].requestId);
  assert.deepEqual(Object.fromEntries(['sessionId', 'leafEntryId', 'idle', 'pendingMessages', 'stopReason', 'contextTokens', 'contextWindow', 'model'].map(k => [k, f.rows[0][k]])),
    { sessionId: 's', leafEntryId: 'tail', idle: true, pendingMessages: false, stopReason: 'stop', contextTokens: 6000, contextWindow: 10000, model: { provider: 'p', id: 'm' } });
  f.grow(); f.observer.reset(f.ctx); f.observer.settled(f.ctx); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.rows.length, 1);
  f.end('expired', 'session_changed'); f.observer.settled(f.ctx); await until(() => f.requests.length === 2);
  assert.notEqual(f.requests[0].requestId, f.requests[1].requestId);
});

test('active without the capability is shadow assessment with unavailable action; shadow never arms', async () => {
  for (const mode of ['active', 'shadow']) {
    const f = fixture(); f.setConfig({ ...params, mode });
    if (mode === 'shadow') f.ctx.requestNativeCompaction = () => { throw new Error('shadow must not arm'); };
    f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
    assert.equal(f.rows[0].outcome, 'warranted'); assert.equal(f.rows[0].action, mode === 'active' ? 'unavailable' : 'none');
    assert.equal(f.rows[0].actionTaken, false); assert.equal(f.rows[0].sessionId, 's'); assert.equal(f.rows[0].contextTokens, 6000);
  }
});

for (const reason of ['disabled', 'compacting', 'invalid'] as const) {
  test(`active refusal ${reason} is assessment telemetry, not an accepted request row`, async () => {
    const f = activeFixture(reason); f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
    assert.equal(f.requests.length, 1); assert.equal(f.rows[0].action, 'refused'); assert.equal(f.rows[0].actionReason, reason);
    assert.equal(f.rows[0].actionTaken, false);
    f.grow(); f.observer.settled(f.ctx); await until(() => f.rows.length === 2); assert.equal(f.requests.length, 2);
    assert.equal(f.rows.filter(r => r.kind === 'request').length, 0);
  });
}

for (const outcome of ['compacted', 'no_op', 'cancelled', 'failed', 'expired', 'superseded']) {
  test(`accepted request ends ${outcome} once, with event-time counts and owner identity`, async () => {
    const f = activeFixture(); f.observer.settled(f.ctx); await until(() => f.requests.length === 1);
    f.grow(); f.setNow(1050);
    const reason = outcome === 'expired' ? 'revision_changed_before_commit' : undefined;
    f.end(outcome, reason); f.end(outcome, reason); // Defensive duplicate/foreign events cannot create rows.
    f.end(outcome, reason, f.ctx, 'unknown');
    const row = f.rows.find(r => r.kind === 'request');
    assert.deepEqual(row, { ts: new Date(1050).toISOString(), kind: 'request', origin: 'extension', requestId: f.requests[0].requestId,
      outcome, reason: reason ?? null, sessionId: 's', leafEntryId: 'tailx', counts: { contextTokens: 6100, contextWindow: 10000, entries: 6 } });
    assert.equal(f.rows.filter(r => r.kind === 'request').length, 1);
    f.observer.settled(f.ctx); await until(() => f.rows.length === 3);
    if (outcome === 'compacted' || outcome === 'failed' || outcome === 'cancelled') {
      assert.deepEqual(f.rows[2].reasons, [outcome === 'compacted' ? 'cooldown' : 'failure_backoff']); assert.equal(f.requests.length, 1);
      f.setNow(1050 + (outcome === 'compacted' ? params.cooldownMs : params.failureBackoffMs));
      f.observer.settled(f.ctx); await until(() => f.requests.length === 2);
    } else assert.equal(f.requests.length, 2);
  });
}

for (const change of ['input', 'tree', 'pending', 'busy', 'config', 'model', 'session']) {
  test(`active never arms stale answer after ${change}`, async () => {
    const f = activeFixture(), blocked = gate(); f.setAsk(() => blocked.promise);
    f.observer.settled(f.ctx); await until(() => f.signals.length === 1);
    if (change === 'input') f.observer.invalidate(f.ctx); else f.mutate(change);
    blocked.release({ answers: {} }); await until(() => f.rows.length === 1);
    assert.deepEqual(f.rows[0].reasons, ['stale_result']); assert.equal(f.requests.length, 0);
  });
}

test('active suppression never arms and pending requests are session-local even when end ctx has switched', async () => {
  const f = activeFixture(), b = secondContext(f, 'b');
  f.observer.settled(f.ctx); f.observer.settled(b); await until(() => f.requests.length === 2);
  f.end('expired', 'session_changed', b, f.requests[0].requestId);
  const switched = f.rows.find(r => r.kind === 'request');
  assert.equal(switched.sessionId, 's'); assert.equal(switched.leafEntryId, null);
  assert.deepEqual(switched.counts, { contextTokens: null, contextWindow: null, entries: null });
  f.grow(); f.observer.settled(f.ctx); await until(() => f.requests.length === 3);
  f.observer.settled(b); await tick(); assert.equal(f.requests.length, 3);
  const suppressed = activeFixture(); suppressed.setAsk(async (_s, qs) => ({ answers: Object.fromEntries(Object.entries(qs).map(([id, q]: any) =>
    [id, q.type === 'choice' ? { choice: 'safe', probabilities: { safe: 1, live: 0, uncertain: 0 }, confidence: .4 } : { noul: 1 }])) }));
  suppressed.observer.settled(suppressed.ctx); await until(() => suppressed.rows.length === 1);
  assert.equal(suppressed.rows[0].outcome, 'suppress'); assert.equal(suppressed.requests.length, 0);
});


test('active terminal write failures cannot escape or retain pending ownership', async () => {
  const f = activeFixture(); f.observer.settled(f.ctx); await until(() => f.requests.length === 1);
  const write = f.deps.write; f.deps.write = () => { throw new Error('sink unavailable'); };
  assert.doesNotThrow(() => f.end('cancelled'));
  f.deps.write = write; f.grow(); f.setNow(1000 + params.failureBackoffMs);
  f.observer.settled(f.ctx); await until(() => f.requests.length === 2);
});

test('active capability errors are recorded and backed off, never thrown into Pi', async () => {
  const f = activeFixture(); f.ctx.requestNativeCompaction = () => { throw new Error('stale runner'); };
  f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
  assert.equal(f.rows[0].action, 'refused'); assert.equal(f.rows[0].actionReason, 'request_error');
  f.grow(); f.observer.settled(f.ctx); await until(() => f.rows.length === 2);
  assert.deepEqual(f.rows[1].reasons, ['failure_backoff']);
});


for (const outcome of ['compacted', 'failed', 'cancelled']) {
  test(`terminal ${outcome} after observer reset still updates the owner's next assessment timer`, async () => {
    const f = activeFixture(); f.observer.settled(f.ctx); await until(() => f.requests.length === 1);
    f.observer.reset(f.ctx); f.grow(); f.end(outcome);
    f.observer.settled(f.ctx); await until(() => f.rows.length === 3);
    assert.deepEqual(f.rows[2].reasons, [outcome === 'compacted' ? 'cooldown' : 'failure_backoff']);
    assert.equal(f.requests.length, 1);
  });
}


for (const eventName of ['session_before_compact', 'session_compact', 'session_compact_failed']) {
  test(`registered ${eventName} distinguishes native cooldown from detector invalidation`, async () => {
    for (const origin of ['native', 'extension']) {
      const f = fixture(), handlers = new Map<string, any[]>();
      const pi: any = { on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, registerEntryRenderer() {}, appendEntry() {} };
      register(pi, { now: f.deps.now } as any, f.deps);
      handlers.get(eventName)![0]({ origin }, f.ctx);
      handlers.get('agent_settled')![0]({}, f.ctx); await until(() => f.rows.length === 1);
      assert.deepEqual(f.rows[0].reasons, [origin === 'native' ? 'cooldown' : 'reclaim_and_boundary_met']);
    }
  });
}

test('registered request terminal dispatch writes the owner row and backs off hook cancellation', async () => {
  const f = activeFixture(), handlers = new Map<string, any[]>();
  const pi: any = { on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); }, registerEntryRenderer() {}, appendEntry() {} };
  register(pi, { now: f.deps.now } as any, f.deps);
  handlers.get('agent_settled')![0]({}, f.ctx); await until(() => f.requests.length === 1);
  handlers.get('compaction_request_end')![0]({ origin: 'extension', requestId: f.requests[0].requestId, outcome: 'cancelled' }, f.ctx);
  assert.equal(f.rows[1].kind, 'request'); assert.equal(f.rows[1].sessionId, 's'); assert.equal(f.rows[1].leafEntryId, 'tail');
  f.grow(); handlers.get('agent_settled')![0]({}, f.ctx); await until(() => f.rows.length === 3);
  assert.deepEqual(f.rows[2].reasons, ['failure_backoff']); assert.equal(f.requests.length, 1);
  f.setNow(1000 + params.failureBackoffMs); handlers.get('agent_settled')![0]({}, f.ctx); await until(() => f.requests.length === 2);
});

test('request telemetry rejects unexpected core reasons', async () => {
  const f = activeFixture(); f.ctx.requestNativeCompaction = () => ({ accepted: false, reason: 'private'.repeat(1000) } as any);
  f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
  assert.equal(f.rows[0].actionReason, null); assert.ok(!JSON.stringify(f.rows).includes('private'));
  const g = activeFixture(); g.observer.settled(g.ctx); await until(() => g.requests.length === 1);
  g.end('expired', 'private'.repeat(1000)); assert.equal(g.rows[1].reason, null);
});

for (const circumstance of ['defer', 'reset']) {
  test(`throwing capability getter on ${circumstance} cannot poison live failure history`, async () => {
    const f = activeFixture();
    Object.defineProperty(f.ctx, 'requestNativeCompaction', { configurable: true, get() {
      if (circumstance === 'reset') f.observer.reset(f.ctx);
      throw new Error('stale capability');
    } });
    if (circumstance === 'defer') f.observer.compaction(f.ctx);
    f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
    if (circumstance === 'defer') assert.equal(f.rows[0].action, 'none');
    Object.defineProperty(f.ctx, 'requestNativeCompaction', { configurable: true, value: () => ({ accepted: true }) });
    f.grow(); f.setNow(1000 + params.cooldownMs); f.observer.settled(f.ctx); await until(() => f.rows.length === 2);
    assert.ok(!f.rows[1].reasons.includes('failure_backoff')); assert.equal(f.rows[1].action, 'requested');
  });
}

test('assessment transport uses detector deadline, not the unrelated compactor retry budget', async () => {
  const f = fixture(); const loaded = f.deps.loadCompaction(); assert.ok(loaded.ok);
  loaded.config.api.backend = 'local'; loaded.config.api.localModel = 'openjev';
  loaded.config.api.retryBudgetMs = 1; f.setLoaded(loaded);
  const original = f.deps.makeAsker; let measured: any;
  f.deps.makeAsker = (config, ...args) => { measured = config; return original(config, ...args); };
  f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
  assert.equal(measured.api.retryBudgetMs, params.requestTimeoutMs);
  assert.equal(measured.api.localTimeoutMs, params.requestTimeoutMs);
  assert.equal(loaded.config.api.retryBudgetMs, 1);
});

test('hosted (typesafe) assessment transport also uses the detector deadline', async () => {
  const f = fixture(); const loaded = f.deps.loadCompaction(); assert.ok(loaded.ok);
  loaded.config.api.backend = 'typesafe'; loaded.config.api.timeoutMs = 1; loaded.config.api.retryBudgetMs = 1; f.setLoaded(loaded);
  const original = f.deps.makeAsker; let measured: any;
  f.deps.makeAsker = (config, ...args) => { measured = config; return original(config, ...args); };
  f.observer.settled(f.ctx); await until(() => f.rows.length === 1);
  // JevHttpClient reads api.timeoutMs per attempt and api.retryBudgetMs overall (jev-client.ts).
  assert.equal(measured.api.timeoutMs, params.requestTimeoutMs);
  assert.equal(measured.api.retryBudgetMs, params.requestTimeoutMs);
  assert.equal(measured.api.localTimeoutMs, params.requestTimeoutMs);
});
