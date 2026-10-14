import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JevError, JevHttpClient } from '../src/client/jev-client.js';
import { flushTelemetry } from '../src/client/ledger.js';
import type { JevConfig } from '../src/client/config.js';
import { judge } from '../src/core/judge.js';
import { spanToSegments } from '../src/core/segments.js';
import { compactSpan } from '../src/core/prune.js';
import { handleCompact, type Deps, type HookContext } from '../src/pi/extension.js';
import { FakeAsker, allOnes } from './support/fake-asker.js';
import { piCtx, piEvent, testDeps, TEST_MODEL } from './support/pi-event.js';
import { call } from './support/span.js';
import { stubServer } from './support/stub-server.js';
import { testConfig } from './support/config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETRY = 'Retry Jev';

type Line = Record<string, unknown>;

const compactionLines = async (config: JevConfig): Promise<Line[]> => {
  await flushTelemetry();
  const path = join(dirname(config.telemetry.path), 'compactions.jsonl');
  const raw = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  return raw ? raw.split('\n').map(line => JSON.parse(line) as Line) : [];
};

const callLines = async (config: JevConfig): Promise<Line[]> => {
  await flushTelemetry();
  const raw = existsSync(config.telemetry.path) ? readFileSync(config.telemetry.path, 'utf8').trim() : '';
  return raw ? raw.split('\n').map(line => JSON.parse(line) as Line) : [];
};

const compactionOf = (result: Awaited<ReturnType<typeof handleCompact>>) => {
  assert.ok(result && 'compaction' in result, `expected a compaction, got ${JSON.stringify(result)}`);
  return result.compaction;
};

/** An asker that records the call context each batch is sent with, and writes real calls.jsonl rows. */
function recordingClient(config: JevConfig, url: string) {
  const seen: Array<{ round?: string; batch?: number }> = [];
  const makeAsker: Deps['makeAsker'] = (_config, hash, signal, context) => {
    const client = new JevHttpClient(
      { config, configHash: hash, caller: 'test', endpoint: url, env: { TYPESAFE_API_KEY: 'apikey_test_0123456789abcdef' }, context },
      signal,
    );
    const ask = client.ask.bind(client);
    client.ask = async (state, questions, call) => {
      seen.push({ round: call?.round, batch: call?.batch });
      return ask(state, questions, call);
    };
    return client;
  };
  return { seen, makeAsker };
}

test("one compaction's rows share one attempt_id and the saved entry carries it", async () => {
  const stub = await stubServer(() => ({
    status: 200,
    body: JSON.stringify({ answers: {}, usage: { input_tokens: 3, output_tokens: 1 } }),
  }));
  const config = testConfig();
  const recording = recordingClient(config, stub.url);
  const deps = testDeps({ config, makeAsker: recording.makeAsker });
  try {
    const compaction = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
    const rows = await compactionLines(config);
    const calls = await callLines(config);
    assert.equal(rows.length, 1);
    assert.ok(calls.length > 0, 'the compaction asked Jev');
    assert.match(String(rows[0]!.hook_id), UUID);
    assert.match(String(rows[0]!.attempt_id), UUID);
    assert.equal(rows[0]!.hook_id === rows[0]!.attempt_id, false);
    for (const call of calls) {
      assert.equal(call.hook_id, rows[0]!.hook_id);
      assert.equal(call.attempt_id, rows[0]!.attempt_id);
      assert.equal(call.round, 'span');
      assert.equal(typeof call.batch, 'number');
      assert.equal(call.retry, 0);
    }
    assert.equal(compaction.details.jev.attempt_id, rows[0]!.attempt_id);
    assert.equal(compaction.details.jev.hook_id, rows[0]!.hook_id);
    assert.equal(rows[0]!.session_id, null);
  } finally {
    await stub.close();
  }
});

test('an operator Retry Jev gives two distinct attempt_ids under one hook_id, and the saved entry carries the second', async () => {
  let built = 0;
  const deps = testDeps({
    makeAsker: () => {
      built += 1;
      return built === 1 ? { ask: async () => { throw new JevError('network', 'x'); } } : new FakeAsker(allOnes);
    },
  });
  const ctx = piCtx([], 1_048_576, new Map(), { hasUI: true, select: async () => RETRY });
  const compaction = compactionOf(await handleCompact(piEvent(), ctx, deps));
  const rows = await compactionLines(deps.config);
  assert.equal(rows.length, 2);
  assert.match(String(rows[0]!.hook_id), UUID);
  assert.equal(rows[1]!.hook_id, rows[0]!.hook_id);
  assert.match(String(rows[0]!.attempt_id), UUID);
  assert.match(String(rows[1]!.attempt_id), UUID);
  assert.notEqual(rows[0]!.attempt_id, rows[1]!.attempt_id);
  assert.equal(rows[0]!.resolution, 'retry');
  assert.equal(compaction.details.jev.attempt_id, rows[1]!.attempt_id);
  assert.equal(compaction.details.jev.hook_id, rows[0]!.hook_id);
});

test('two concurrent batches write rows with distinct batch values', async () => {
  const span = Array.from({ length: 40 }, (_, i) => call(`c${i}`, 'read', { path: `f${i}` }, 'x')).flat();
  const segments = spanToSegments(span, {
    pins: new Set(),
    modifyTools: new Set(),
    decisionTools: new Set(),
    maxStoredChars: 8000,
    gen: 1,
    hash: text => createHash('sha256').update(text).digest('hex').slice(0, 12),
  });
  const all = segments.map((_, i) => i);
  const seen: Array<{ round?: string; batch?: number }> = [];
  let pending = 0;
  let peak = 0;
  const asker = {
    ask: async (_state: unknown, _questions: unknown, call?: { round: string; batch: number }) => {
      pending += 1;
      peak = Math.max(peak, pending);
      seen.push({ round: call?.round, batch: call?.batch });
      await new Promise(resolve => setTimeout(resolve, 5));
      pending -= 1;
      return { answers: {}, usage: { input_tokens: 1, output_tokens: 0 } };
    },
  };
  // The same budget the judge test uses to force several batches of one window.
  await judge(segments, all, all, { goal: '', maxStateTokens: 4000, maxRequestTokens: 5000 }, asker, 'span');
  assert.ok(peak > 1, 'batches must be in flight together');
  const batches = seen.map(call => call.batch);
  assert.ok(batches.length > 1);
  assert.equal(new Set(batches).size, batches.length, `batch values must be distinct, got ${batches.join(',')}`);
  assert.ok(seen.every(call => call.round === 'span'));
});

test('batch indexes are unique across every window of one judge invocation', async () => {
  // The same span and budget the judge test uses to split one candidate into several windows.
  const span = Array.from({ length: 60 }, (_, i) => call(`c${i}`, 'read', { path: `f${i}` }, 'x')).flat();
  const segments = spanToSegments(span, {
    pins: new Set(),
    modifyTools: new Set(),
    decisionTools: new Set(),
    maxStoredChars: 8000,
    gen: 1,
    hash: text => createHash('sha256').update(text).digest('hex').slice(0, 12),
  });
  const all = segments.map((_, i) => i);
  const seen: Array<{ round?: string; batch?: number }> = [];
  let pending = 0;
  let peak = 0;
  const asker = {
    ask: async (_state: unknown, _questions: unknown, call?: { round: string; batch: number }) => {
      pending += 1;
      peak = Math.max(peak, pending);
      seen.push({ round: call?.round, batch: call?.batch });
      await new Promise(resolve => setTimeout(resolve, 5));
      pending -= 1;
      return { answers: {}, usage: { input_tokens: 1, output_tokens: 0 } };
    },
  };
  await judge(segments, all, all, { goal: '', maxStateTokens: 600, maxRequestTokens: 30_000 }, asker, 'span');
  assert.ok(seen.length >= 4, `expected one request per window, got ${seen.length}`);
  assert.ok(peak > 1, 'windows must be in flight together');
  const batches = seen.map(call => call.batch);
  assert.equal(new Set(batches).size, batches.length, `batch values must be unique across windows, got ${batches.join(',')}`);
  assert.ok(seen.every(call => call.round === 'span'));
});

test('a retried request yields two calls rows with the same batch and retry 0 and 1', async () => {
  const OVERLOADED = { status: 529, body: JSON.stringify({ detail: { error_type: 'system_overloaded' } }) };
  const OK = { status: 200, body: JSON.stringify({ answers: { call_t1: { noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } }) };
  const stub = await stubServer(() => (stub.hits.length === 1 ? OVERLOADED : OK));
  const config = testConfig(c => Object.assign(c.api, { retryBackoffMs: 10, retryBackoffMaxMs: 40, retryJitter: 0 }));
  try {
    const client = new JevHttpClient(
      {
        config,
        configHash: 'abc',
        caller: 'test',
        endpoint: stub.url,
        env: { TYPESAFE_API_KEY: 'apikey_test_0123456789abcdef' },
        context: { hookId: 'hook-1', attemptId: 'attempt-1' },
      },
    );
    await client.ask(
      { context: 'x', goal: '', history: [] },
      { call_t1: { type: 'noul', instructions: 'keep?' } },
      { round: 'carry', batch: 2 },
    );
    const rows = await callLines(config);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.retry), [0, 1]);
    assert.deepEqual(rows.map(row => row.batch), [2, 2]);
    assert.deepEqual(rows.map(row => row.round), ['carry', 'carry']);
    assert.deepEqual(rows.map(row => row.hook_id), ['hook-1', 'hook-1']);
    assert.deepEqual(rows.map(row => row.attempt_id), ['attempt-1', 'attempt-1']);
    assert.deepEqual(rows.map(row => row.outcome), ['http', 'ok']);
  } finally {
    await stub.close();
  }
});

test('a cancelled attempt still writes its compactions row with the ids', async () => {
  const signal = new AbortController();
  signal.abort();
  // Aborted before config loads, so the row lands in the fallback dir, not beside calls.jsonl.
  const deps = testDeps();
  const result = await handleCompact(piEvent({ signal: signal.signal }), piCtx(), deps);
  assert.deepEqual(result, { cancel: true });
  await flushTelemetry();
  const [row] = readFileSync(join(deps.fallbackLogDir, 'compactions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Line);
  assert.ok(row);
  assert.equal(row.engine, 'cancelled');
  assert.match(String(row.hook_id), UUID);
  assert.match(String(row.attempt_id), UUID);
  assert.equal(row.session_id, null);
});

test('session_id is recorded, and null when the context lacks it or its getter throws', async () => {
  const withSession = piCtx();
  (withSession as HookContext & { sessionManager: { getSessionId(): string } }).sessionManager = {
    getSessionId: () => 'session-42',
  };
  const recorded = testDeps();
  const compaction = compactionOf(await handleCompact(piEvent(), withSession, recorded));
  assert.equal((await compactionLines(recorded.config))[0]!.session_id, 'session-42');
  assert.equal(compaction.details.jev.hook_id !== undefined, true);

  const throwing = piCtx();
  (throwing as HookContext & { sessionManager: { getSessionId(): string } }).sessionManager = {
    getSessionId: () => {
      throw new Error('runner invalidated');
    },
  };
  const broken = testDeps();
  compactionOf(await handleCompact(piEvent(), throwing, broken));
  assert.equal((await compactionLines(broken.config))[0]!.session_id, null);

  const missing = testDeps();
  compactionOf(await handleCompact(piEvent(), piCtx(), missing));
  assert.equal((await compactionLines(missing.config))[0]!.session_id, null);
});

test('lastResort still writes hook_id and attempt_id when the hook itself throws', async () => {
  const deps = testDeps({
    loadConfig: () => {
      throw new Error('config loader exploded');
    },
  });
  // runAttempt catches its own throws, so force the outer handler: a throwing now()
  // inside the failure path is what lastResort exists for. A getter that throws on
  // every read of the signal does that from the first line of runHook.
  const event = new Proxy(piEvent(), {
    get(target, prop, receiver) {
      if (prop === 'signal') throw new Error('event invalidated');
      return Reflect.get(target, prop, receiver);
    },
  });
  const result = await handleCompact(event, piCtx(), deps);
  assert.deepEqual(result, { cancel: true });
  await flushTelemetry();
  const path = join(deps.fallbackLogDir, 'compactions.jsonl');
  const [row] = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Line);
  assert.equal(row!.reason, 'error');
  assert.match(String(row!.hook_id), UUID);
  assert.match(String(row!.attempt_id), UUID);
  assert.equal(row!.session_id, null);
});

test('hook_id exists before config load: a config failure still carries both ids', async () => {
  const deps = testDeps({ loadConfig: () => ({ ok: false, errors: ['compaction.max_share'] }) });
  assert.deepEqual(await handleCompact(piEvent(), { model: { contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: TEST_MODEL.id } }, deps), { cancel: true });
  await flushTelemetry();
  const [row] = readFileSync(join(deps.fallbackLogDir, 'compactions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Line);
  assert.match(String(row!.hook_id), UUID);
  assert.match(String(row!.attempt_id), UUID);
});

const decisionLines = async (config: JevConfig): Promise<Line[]> => {
  await flushTelemetry();
  const path = join(dirname(config.telemetry.path), 'decisions.jsonl');
  const raw = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  return raw ? raw.split('\n').map(line => JSON.parse(line) as Line) : [];
};

/**
 * Outcome counts on a decision record. `asked` is the core's code, not the stats
 * class: a pin is 0, an unasked fresh segment is -2, and a carried segment left
 * alone is 0, so the stats' `unasked` is the -2 rows only.
 */
function recordCounts(segments: unknown): { kept: number; truncated: number; dropped: number; pinned: number; asked: number; unasked: number; unanswered: number } {
  assert.ok(Array.isArray(segments));
  const counts = { kept: 0, truncated: 0, dropped: 0, pinned: 0, asked: 0, unasked: 0, unanswered: 0 };
  for (const row of segments) {
    assert.ok(Array.isArray(row) && row.length === 14);
    const outcome = row[13];
    if (outcome === 'keep') counts.kept += 1;
    else if (outcome === 'truncate') counts.truncated += 1;
    else if (outcome === 'drop') counts.dropped += 1;
    else assert.fail(`outcome outside keep/truncate/drop: ${JSON.stringify(outcome)}`);
    if (row[3] !== null) counts.pinned += 1;
    const asked = row[7];
    if (asked === 1) counts.asked += 1;
    else if (asked === -2) counts.unasked += 1;
    else if (asked === -1) counts.unanswered += 1;
    else if (asked !== 0) assert.fail(`asked outside 1/0/-1/-2: ${JSON.stringify(asked)}`);
  }
  return counts;
}

test('decisions never appear in details.jev, and a refused compaction still has its decisions line', async () => {
  const deps = testDeps();
  const compaction = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  assert.equal('decisions' in compaction.details.jev, false);
  assert.equal(JSON.stringify(compaction.details).includes('"decisions"'), false);
  const rows = await decisionLines(deps.config);
  assert.equal(rows.length, 1, 'the successful attempt wrote one decisions line');

  // The real core returns, then the adapter refuses the result. The line is already written.
  const refused = testDeps({
    compact: async (input, options, asker) => {
      const outcome = await compactSpan(input, options, asker);
      // compactSpan has returned, so the line is already written; the adapter then
      // refuses the result because its carry would not survive the session file.
      return { ...outcome, carry: { version: 1, generation: 1, segments: [{ kind: 'bogus' } as never] } };
    },
  });
  assert.deepEqual(await handleCompact(piEvent(), piCtx(), refused), { cancel: true });
  const refusedRows = await decisionLines(refused.config);
  const compactions = await compactionLines(refused.config);
  assert.equal(refusedRows.length, 1, 'a refused attempt still has its decisions line');
  assert.equal(compactions[0]!.reason, 'invalid_output');
  assert.equal(refusedRows[0]!.attempt_id, compactions[0]!.attempt_id);
  assert.equal(refusedRows[0]!.hook_id, compactions[0]!.hook_id);
});

test('a failed decisions write does not change the compaction', async () => {
  const deps = testDeps({ config: testConfig(c => (c.telemetry.path = '/dev/null/no/calls.jsonl')) });
  const without = compactionOf(await handleCompact(piEvent(), piCtx(), testDeps()));
  const withBroken = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
  assert.equal(withBroken.summary, without.summary);
  assert.deepEqual(withBroken.details.jev.carry, without.details.jev.carry);
  assert.equal(withBroken.details.jev.stats.step, without.details.jev.stats.step);
  assert.equal('decisions' in withBroken.details.jev, false);
  await flushTelemetry();
  assert.equal(existsSync(join(dirname(deps.config.telemetry.path), 'decisions.jsonl')), false);
});

test("an end-to-end compaction writes a decisions line whose ids and outcome counts match", async () => {
  const stub = await stubServer(() => ({
    status: 200,
    body: JSON.stringify({ answers: {}, usage: { input_tokens: 3, output_tokens: 1 } }),
  }));
  const config = testConfig();
  const recording = recordingClient(config, stub.url);
  const deps = testDeps({ config, makeAsker: recording.makeAsker });
  try {
    const compaction = compactionOf(await handleCompact(piEvent(), piCtx(), deps));
    const rows = await compactionLines(config);
    const calls = await callLines(config);
    const decisions = await decisionLines(config);
    assert.equal(rows.length, 1);
    assert.equal(decisions.length, 1);
    assert.ok(calls.length > 0);
    const decision = decisions[0]!;
    assert.equal(decision.attempt_id, rows[0]!.attempt_id);
    assert.equal(decision.hook_id, rows[0]!.hook_id);
    assert.equal(decision.session_id, rows[0]!.session_id);
    assert.equal(decision.config_hash, rows[0]!.config_hash);
    assert.equal(compaction.details.jev.attempt_id, decision.attempt_id);
    assert.equal(compaction.details.jev.hook_id, decision.hook_id);
    for (const call of calls) {
      assert.equal(call.attempt_id, decision.attempt_id);
      assert.equal(call.hook_id, decision.hook_id);
    }
    assert.equal('decisions' in compaction.details.jev, false);
    const segments = decision.segments;
    assert.ok(Array.isArray(segments));
    assert.equal(segments.length, rows[0]!.segments);
    const counts = recordCounts(segments);
    assert.equal(counts.kept, rows[0]!.kept);
    assert.equal(counts.truncated, rows[0]!.truncated);
    assert.equal(counts.dropped, rows[0]!.dropped);
    assert.equal(counts.pinned, rows[0]!.pinned);
    assert.equal(counts.asked, rows[0]!.asked);
    assert.equal(counts.unasked, rows[0]!.unasked);
    assert.equal(counts.unanswered, rows[0]!.unanswered);
    assert.equal(decision.generation, rows[0]!.generation);
    assert.equal(decision.final_step, rows[0]!.step);
    assert.equal(decision.keep_threshold, config.compaction.keepThreshold);
  } finally {
    await stub.close();
  }
});
