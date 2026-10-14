import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JevError, JevHttpClient, retryAfterMs, type JevErrorKind } from '../src/client/jev-client.js';
import { flushTelemetry, setLedgerFs, setLedgerNoteSink } from '../src/client/ledger.js';
import type { JevConfig } from '../src/client/config.js';
import { testConfig } from './support/config.js';
import { stubServer, type Reply } from './support/stub-server.js';
import { scratchDir } from './support/scratch.js';

const KEY = 'apikey_test_0123456789abcdef';
const QUESTIONS = {
  call_t1: { type: 'noul' as const, instructions: 'SECRET-QUESTION-TEXT should stay' },
};
const STATE = { context: 'SECRET-STATE-TEXT', goal: '', history: [] };
const OK = { status: 200, body: JSON.stringify({ answers: { call_t1: { noul: 0.9 } }, usage: { input_tokens: 321, output_tokens: 4 } }) };

function client(config: JevConfig, url: string, env: Record<string, string | undefined> = { TYPESAFE_API_KEY: KEY }, signal?: AbortSignal) {
  return new JevHttpClient({ config, configHash: 'abc123def456', caller: 'test', endpoint: url, env }, signal);
}
async function lines(config: JevConfig): Promise<Array<Record<string, unknown>>> {
  await flushTelemetry(); // appends are asynchronous and never awaited on the call path
  return readFileSync(config.telemetry.path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}
async function failure(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof JevError, String(error));
    assert.ok(!error.message.includes(KEY), 'error text must not carry the key');
    return error;
  }
  assert.fail('expected a JevError');
}
async function kindFor(reply: Reply): Promise<JevErrorKind> {
  const stub = await stubServer(() => reply);
  try {
    return (await failure(client(testConfig(), stub.url).ask(STATE, QUESTIONS))).kind;
  } finally {
    await stub.close();
  }
}

test('a successful call returns the answers and logs one content-free line', async () => {
  const stub = await stubServer(() => OK);
  const config = testConfig();
  try {
    const asker = client(config, stub.url);
    const response = await asker.ask(STATE, QUESTIONS);
    assert.equal(asker.responseCount, 1, 'the canonical hosted fixture omits type');
    assert.equal((response.answers.call_t1 as { noul: number }).noul, 0.9);
    assert.equal(stub.hits[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(JSON.parse(stub.hits[0]!.body).model, config.api.model);
    const [line] = (await lines(config));
    assert.deepEqual(Object.keys(line!).sort(), [
      'attempt_id', 'backend', 'batch', 'caller', 'config_hash', 'hook_id', 'input_tokens', 'latency_ms', 'model', 'outcome',
      'output_tokens', 'question_count', 'request_bytes', 'retry', 'round', 'source', 'ts',
    ]);
    assert.equal(line!.hook_id, null);
    assert.equal(line!.attempt_id, null);
    assert.equal(line!.round, null);
    assert.equal(line!.batch, null);
    assert.equal(line!.retry, 0);
    assert.equal(line!.outcome, 'ok');
    assert.equal(line!.input_tokens, 321);
    assert.equal(line!.question_count, 1);
    assert.ok((line!.request_bytes as number) > 0);
    const raw = readFileSync(config.telemetry.path, 'utf8');
    for (const secret of [KEY, 'SECRET-QUESTION-TEXT', 'SECRET-STATE-TEXT']) assert.ok(!raw.includes(secret), secret);
  } finally {
    await stub.close();
  }
});

test('an odd output token count is logged as zero, so the telemetry row is still written', async () => {
  // The ledger rejects a row whose tokens are not counts; without the check the row is lost.
  const reply = { status: 200, body: JSON.stringify({ answers: { call_t1: { noul: 0.9 } }, usage: { input_tokens: 321, output_tokens: 'many' } }) };
  const stub = await stubServer(() => reply);
  const config = testConfig();
  try {
    await client(config, stub.url).ask(STATE, QUESTIONS);
    const [line] = (await lines(config));
    assert.equal(line!.output_tokens, 0);
    assert.equal(line!.input_tokens, 321);
  } finally {
    await stub.close();
  }
});

const OVERLOADED = { status: 529, body: JSON.stringify({ detail: { error_type: 'system_overloaded' } }) };
/** Fast retries, so the tests do not wait on the production backoff. */
const quick = (patch: Partial<JevConfig['api']> = {}) =>
  testConfig(c => Object.assign(c.api, { retryBackoffMs: 10, retryBackoffMaxMs: 40, retryJitter: 0, ...patch }));

test('an overloaded Jev (529) is retried and the call succeeds; every attempt is logged', async () => {
  const stub = await stubServer(() => (stub.hits.length === 1 ? OVERLOADED : OK));
  const config = quick();
  try {
    const response = await client(config, stub.url).ask(STATE, QUESTIONS);
    assert.equal((response.answers.call_t1 as { noul: number }).noul, 0.9);
    assert.equal(stub.hits.length, 2);
    assert.deepEqual((await lines(config)).map(l => l.outcome), ['http', 'ok']);
  } finally {
    await stub.close();
  }
});

test('an attempt that times out is retried', async () => {
  const stub = await stubServer(() => (stub.hits.length === 1 ? 'hang' : OK));
  const config = quick({ timeoutMs: 1000, retryBudgetMs: 10_000 });
  try {
    await client(config, stub.url).ask(STATE, QUESTIONS);
    assert.equal(stub.hits.length, 2);
    assert.deepEqual((await lines(config)).map(l => l.outcome), ['timeout', 'ok']);
  } finally {
    await stub.close();
  }
});

test('retries stop after max_retries and report the last failure', async () => {
  const stub = await stubServer(() => OVERLOADED);
  try {
    const error = await failure(client(quick({ maxRetries: 2 }), stub.url).ask(STATE, QUESTIONS));
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 529);
    assert.equal(stub.hits.length, 3, 'the first attempt and two retries');
  } finally {
    await stub.close();
  }
});

test('a failure a retry cannot fix is not retried: a 400, a rejected key, a refused redirect', async () => {
  for (const reply of [{ status: 400, body: '{}' }, { status: 401, body: '{}' }, { status: 302, headers: { location: 'http://127.0.0.1:9/' } }]) {
    const stub = await stubServer(() => reply);
    try {
      await failure(client(quick(), stub.url).ask(STATE, QUESTIONS));
      assert.equal(stub.hits.length, 1, `HTTP ${reply.status}`);
    } finally {
      await stub.close();
    }
  }
});

test("the server's requested delay is honoured, and a retry that would pass the budget is not made", async () => {
  const waiting = await stubServer(() => (waiting.hits.length === 1 ? { status: 503, headers: { 'retry-after-ms': '150' } } : OK));
  try {
    const started = Date.now();
    await client(quick(), waiting.url).ask(STATE, QUESTIONS);
    assert.ok(Date.now() - started >= 150, 'waited as asked');
    assert.equal(waiting.hits.length, 2);
  } finally {
    await waiting.close();
  }
  const tooLong = await stubServer(() => ({ status: 503, headers: { 'retry-after': '60' } }));
  try {
    await failure(client(quick({ retryBudgetMs: 2000 }), tooLong.url).ask(STATE, QUESTIONS));
    assert.equal(tooLong.hits.length, 1, 'a 60 s wait cannot fit a 2 s budget');
  } finally {
    await tooLong.close();
  }
});

test("an attempt's timeout is cut to what the call's budget has left", async () => {
  const stub = await stubServer(() => 'hang');
  try {
    const started = Date.now();
    const error = await failure(client(quick({ timeoutMs: 20_000, retryBudgetMs: 1000 }), stub.url).ask(STATE, QUESTIONS));
    assert.equal(error.kind, 'timeout');
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  } finally {
    await stub.close();
  }
});

test('a caller abort during the backoff ends the call without another attempt', async () => {
  const controller = new AbortController();
  const stub = await stubServer(() => {
    setTimeout(() => controller.abort(), 20);
    return OVERLOADED;
  });
  try {
    const error = await failure(client(quick({ retryBackoffMs: 500, retryBackoffMaxMs: 500 }), stub.url, { TYPESAFE_API_KEY: KEY }, controller.signal).ask(STATE, QUESTIONS));
    assert.equal(error.kind, 'aborted');
    assert.equal(stub.hits.length, 1);
  } finally {
    await stub.close();
  }
});

test('Retry-After is read as milliseconds, seconds or an HTTP date', () => {
  const now = Date.parse('2026-09-24T05:00:00Z');
  assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '250' }), now), 250);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' }), now), 2000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Thu, 24 Sep 2026 05:00:03 GMT' }), now), 3000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'soon' }), now), undefined);
  assert.equal(retryAfterMs(new Headers(), now), undefined);
});

test('HTTP failures map to typed errors', async () => {
  assert.equal(await kindFor({ status: 401, body: KEY }), 'auth');
  assert.equal(await kindFor({ status: 403 }), 'auth');
  assert.equal(await kindFor({ status: 500, body: KEY }), 'http');
  assert.equal(await kindFor({ status: 200, body: '{"no":"answers"}' }), 'parse');
  assert.equal(await kindFor({ status: 200, body: 'not json' }), 'parse');
  assert.equal(await kindFor({ status: 200, body: 'x'.repeat(5 * 1024 * 1024) }), 'http');
});

test('an endpoint override is accepted only for a loopback test stub', () => {
  const config = testConfig();
  const make = (endpoint?: string) => () => new JevHttpClient({ config, configHash: 'x', caller: 'test', endpoint });
  assert.throws(make('https://evil.example/v1/systemone'));
  assert.throws(make('http://127.0.0.1.evil.example/'));
  assert.throws(make('not a url'));
  assert.throws(make('http://localhost:9/v1/systemone'));
  assert.doesNotThrow(make('http://127.0.0.1:9/v1/systemone'));
  assert.doesNotThrow(make('http://[::1]:9/v1/systemone'));
  assert.doesNotThrow(make(undefined));
});

test('a missing key is an auth error and nothing is sent', async () => {
  const stub = await stubServer(() => OK);
  const config = testConfig();
  try {
    assert.equal((await failure(client(config, stub.url, {}).ask(STATE, QUESTIONS))).kind, 'auth');
    assert.equal(stub.hits.length, 0);
    assert.equal((await lines(config))[0]!.request_bytes, 0);
  } finally {
    await stub.close();
  }
});

test('a redirect is refused as a network error and the key never reaches the target', async () => {
  const target = await stubServer(() => OK);
  const redirect = await stubServer(() => ({ status: 302, headers: { location: target.url } }));
  try {
    assert.equal((await failure(client(testConfig(), redirect.url).ask(STATE, QUESTIONS))).kind, 'network');
    assert.equal(redirect.hits.length, 1);
    assert.equal(target.hits.length, 0);
  } finally {
    await redirect.close();
    await target.close();
  }
});

test('the configured timeout and the caller abort are told apart', async () => {
  const stub = await stubServer(() => 'hang');
  try {
    const slow = testConfig(c => (c.api.timeoutMs = 1000));
    assert.equal((await failure(client(slow, stub.url).ask(STATE, QUESTIONS))).kind, 'timeout');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const aborted = client(testConfig(), stub.url, undefined, controller.signal).ask(STATE, QUESTIONS);
    assert.equal((await failure(aborted)).kind, 'aborted');
  } finally {
    await stub.close();
  }
});

test('heavy prior spend in the ledger no longer refuses a call', async () => {
  // The daily cap is removed: today's ledger rows cannot gate a request.
  const stub = await stubServer(() => OK);
  const config = testConfig();
  const row = {
    ts: new Date().toISOString(), caller: 'test', model: config.api.model, latency_ms: 1,
    outcome: 'ok', input_tokens: 1_000_000, output_tokens: 0, request_bytes: 100,
    question_count: 1, config_hash: 'x',
  };
  writeFileSync(config.telemetry.path, `${new Array(2000).fill(JSON.stringify(row)).join('\n')}\n`);
  try {
    const response = await client(config, stub.url).ask(STATE, QUESTIONS);
    assert.equal((response.answers.call_t1 as { noul: number }).noul, 0.9);
    assert.equal(stub.hits.length, 1, 'the spent ledger did not refuse the request');
  } finally {
    await stub.close();
  }
});

test('a damaged or unwritable telemetry ledger cannot fail or block a call, nor look like a Jev error', async () => {
  const stub = await stubServer(() => OK);
  // A damaged line, which the removed budget used to fail closed on.
  const damaged = testConfig();
  writeFileSync(damaged.telemetry.path, 'garbage\n');
  // An unwritable destination: the ledger cannot create the directory or append.
  const unwritable = testConfig(c => (c.telemetry.path = '/dev/null/no/calls.jsonl'));
  try {
    const first = await client(damaged, stub.url).ask(STATE, QUESTIONS);
    assert.equal((first.answers.call_t1 as { noul: number }).noul, 0.9);
    const second = await client(unwritable, stub.url).ask(STATE, QUESTIONS);
    assert.equal((second.answers.call_t1 as { noul: number }).noul, 0.9);
    assert.equal(stub.hits.length, 2, 'the ledger never gated the requests');
  } finally {
    await stub.close();
  }
});

test('a FIFO telemetry sink with no reader cannot block a call: it is refused and the call returns at once', async () => {
  const fifo = join(scratchDir('jev-fifo-'), 'calls.jsonl');
  execFileSync('mkfifo', [fifo]);
  // No key: authentication fails before any network I/O. The telemetry append on the
  // failure path used to open the FIFO and block forever; it must return at once now.
  const config = testConfig(c => (c.telemetry.path = fifo));
  setLedgerNoteSink(() => {}); // the FIFO sink is refused with a note; keep the TAP stream clean
  try {
    const started = Date.now();
    const error = await failure(client(config, 'http://127.0.0.1:1/', {}).ask(STATE, QUESTIONS));
    const elapsed = Date.now() - started;
    assert.equal(error.kind, 'auth');
    assert.ok(elapsed < 1000, `the call must not wait on telemetry (${elapsed} ms)`);
  } finally {
    setLedgerNoteSink(undefined);
  }
});

test('a stalled telemetry filesystem cannot block a Jev call: the call returns at once', async () => {
  const config = testConfig();
  const never = new Promise<never>(() => {});
  setLedgerFs({ stat: () => never, mkdir: () => never, appendFile: () => never });
  try {
    const started = Date.now();
    const error = await failure(client(config, 'http://127.0.0.1:1/', {}).ask(STATE, QUESTIONS));
    const elapsed = Date.now() - started;
    assert.equal(error.kind, 'auth');
    assert.ok(elapsed < 1000, `the call must not wait on telemetry (${elapsed} ms)`);
  } finally {
    setLedgerFs(undefined); // abandon the stalled writes so a later flush terminates
  }
});
