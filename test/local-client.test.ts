import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flushTelemetry } from '../src/client/ledger.js';
import { createCompactionAsker } from '../src/client/asker.js';
import { LocalDecisionClient, validateLocalAnswers } from '../src/client/local-client.js';
import { JevError, JevHttpClient, MAX_RESPONSE_BYTES } from '../src/client/jev-client.js';
import { handleCompact } from '../src/pi/extension.js';
import type { JevQuestions } from '../src/vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { testConfig } from './support/config.js';
import { stubServer } from './support/stub-server.js';
import { piEvent, piCtx, testDeps } from './support/pi-event.js';

const QUESTIONS: JevQuestions = {
  retain: { type: 'noul', instructions: 'PRIVATE-QUESTION: keep this?' },
  stale: { type: 'score', instructions: 'How stale?', criteria: ['needed', 'uncertain', 'obsolete'] },
};
const ANSWERS = {
  retain: { type: 'noul', noul: 0.9 },
  stale: { type: 'score', score: 0.3, confidence: 0.7, probabilities: { '0': 0.8, '1': 0.1, '2': 0.1 } },
};
const STATE = { goal: 'PRIVATE-STATE', history: [] };
const localConfig = (url: string) => testConfig(c => {
  c.api.backend = 'local';
  c.api.localEndpoint = url.replace('/v1/systemone', '/v1/systemone-local');
  c.api.localModel = 'clm';
  c.compaction.maxStateTokens = 1000;
  c.compaction.maxRequestTokens = 2000;
});
const typedError = (kind: string) => (error: unknown) => error instanceof JevError && error.kind === kind;

test('factory defaults to TypeSafe; local requests have no credentials and record content-free telemetry', async () => {
  assert.ok(createCompactionAsker(testConfig(), 'test') instanceof JevHttpClient);
  const stub = await stubServer(() => ({ status: 200, body: JSON.stringify({ model: 'clm', answers: ANSWERS }) }));
  try {
    const config = localConfig(stub.url);
    const asker = createCompactionAsker(config, 'test', undefined, { hookId: 'hook-1', attemptId: 'attempt-1' });
    assert.ok(asker instanceof LocalDecisionClient);
    const response = await asker.ask(STATE, QUESTIONS, { round: 'span', batch: 1 });
    assert.equal(response.model, 'clm');
    assert.equal((response.answers.retain as { noul: number }).noul, 0.9);
    assert.deepEqual(JSON.parse(stub.hits[0]!.body), { model: 'clm', state: STATE, questions: QUESTIONS });
    assert.equal(stub.hits[0]!.headers.authorization, undefined);
    assert.equal(stub.hits[0]!.headers.cookie, undefined);
    assert.ok(Number(stub.hits[0]!.headers['x-request-timeout-ms']) >= 100);
    assert.ok(Number(stub.hits[0]!.headers['x-request-timeout-ms']) <= Math.min(config.api.timeoutMs, config.api.retryBudgetMs, 180000));
    // Telemetry writes asynchronously, as it does for the existing cloud client.
    let log = '';
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      try { log = readFileSync(config.telemetry.path, 'utf8'); } catch { continue; }
      if (log.trim()) break;
    }
    const row = JSON.parse(log.trim());
    assert.equal(row.backend, 'local');
    assert.equal(row.model, 'clm');
    assert.equal(row.hook_id, 'hook-1');
    assert.equal(row.attempt_id, 'attempt-1');
    assert.equal(row.round, 'span');
    assert.equal(row.batch, 1);
    assert.ok(!log.includes('PRIVATE-'));
  } finally { await stub.close(); }
});

test('all IDs, types, probabilities, expected scores and confidence must validate together', () => {
  const valid = () => ({ model: 'clm', answers: structuredClone(ANSWERS) });
  assert.equal(validateLocalAnswers(valid(), QUESTIONS, 'clm').model, 'clm');
  const mutations: Array<(raw: any) => void> = [
    raw => { delete raw.answers.retain; },
    raw => { raw.answers.extra = { type: 'noul', noul: 0 }; },
    raw => { raw.model = 'other'; },
    raw => { raw.answers.retain.type = 'score'; },
    raw => { raw.answers.retain.noul = NaN; },
    raw => { raw.answers.retain.noul = 1.01; },
    raw => { raw.answers.stale.score = 2; },
    raw => { raw.answers.stale.confidence = 0.8; },
    raw => { raw.answers.stale.probabilities['0'] = 0.7; },
    raw => { raw.answers.stale.probabilities.extra = 0; },
  ];
  for (const mutate of mutations) {
    const raw = valid(); mutate(raw);
    assert.throws(() => validateLocalAnswers(raw, QUESTIONS, 'clm'), typedError('parse'));
  }
  const choice: JevQuestions = { option: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } } };
  const raw = { model: 'clm', answers: { option: { type: 'choice', choice: 'a', confidence: 0.6, probabilities: { a: 0.8, b: 0.2 } } } };
  assert.equal(validateLocalAnswers(raw, choice, 'clm').model, 'clm');
  raw.answers.option.choice = 'b';
  assert.throws(() => validateLocalAnswers(raw, choice, 'clm'), typedError('parse'));
});

test('redirects cannot forward conversation content to another endpoint', async () => {
  const destination = await stubServer(() => ({ status: 200 }));
  const redirect = await stubServer(() => ({ status: 307, headers: { location: destination.url } }));
  try {
    await assert.rejects(createCompactionAsker(localConfig(redirect.url), 'test').ask(STATE, QUESTIONS), typedError('network'));
    assert.equal(destination.hits.length, 0);
    assert.equal(redirect.hits.length, 1);
  } finally { await redirect.close(); await destination.close(); }
});

test('size cap, invalid JSON and HTTP rejection fail once without exposing provider content', async () => {
  for (const [reply, kind] of [
    [{ status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) }, body: '{}' }, 'http'],
    [{ status: 200, body: 'PRIVATE-INVALID-JSON' }, 'parse'],
    [{ status: 422, body: 'PRIVATE-OVERSIZED-CONTEXT' }, 'http'],
  ] as const) {
    const stub = await stubServer(() => reply);
    try {
      await assert.rejects(createCompactionAsker(localConfig(stub.url), 'test').ask(STATE, QUESTIONS), error => {
        assert.ok(error instanceof JevError);
        assert.equal(error.kind, kind);
        assert.ok(!error.message.includes('PRIVATE'));
        return true;
      });
      assert.equal(stub.hits.length, 1);
    } finally { await stub.close(); }
  }
});

test('caller aborts and local deadlines cancel rather than retry', async () => {
  const stub = await stubServer(() => 'hang');
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(createCompactionAsker(localConfig(stub.url), 'test', controller.signal).ask(STATE, QUESTIONS), typedError('aborted'));
    assert.equal(stub.hits.length, 0);
    const config = localConfig(stub.url); config.api.timeoutMs = 30;
    await assert.rejects(createCompactionAsker(config, 'test').ask(STATE, QUESTIONS), typedError('timeout'));
    assert.equal(stub.hits.length, 0, 'less than the local protocol minimum must not dispatch');
    config.api.timeoutMs = 150;
    await assert.rejects(createCompactionAsker(config, 'test').ask(STATE, QUESTIONS), typedError('timeout'));
    assert.equal(stub.hits.length, 1);
  } finally { await stub.close(); }
});

test('Pi hook runs the pruning engine through local HTTP and keeps user/error/edit pins', async () => {
  const stub = await stubServer(hit => {
    const body = JSON.parse(hit.body);
    const answers = Object.fromEntries(Object.entries(body.questions as JevQuestions).map(([id, q]) => {
      if (q.type === 'noul') return [id, { type: 'noul', noul: 0 }];
      assert.equal(q.type, 'score');
      const criteria = q.criteria as string[];
      return [id, { type: 'score', score: criteria.length - 1, confidence: 1, probabilities: Object.fromEntries(criteria.map((_, i) => [String(i), i === criteria.length - 1 ? 1 : 0])) }];
    }));
    return { status: 200, body: JSON.stringify({ model: 'clm', answers }) };
  });
  try {
    const config = localConfig(stub.url);
    const result = await handleCompact(piEvent(), piCtx([], undefined, undefined, { mode: 'rpc', hasUI: false }), testDeps({ config, makeAsker: createCompactionAsker }));
    assert.ok(result && 'compaction' in result, JSON.stringify(result));
    assert.ok(stub.hits.length > 0);
    const compaction = result.compaction;
    assert.equal(compaction.details.jev.model, 'clm');
    assert.match(compaction.summary, /Fix the failing auth test/);
    assert.match(compaction.summary, /FAIL session.test.ts: TypeError/);
    assert.match(compaction.summary, /Applied 1 edit/);
    assert.ok(!compaction.summary.includes('line\n'.repeat(400)));
    assert.equal(compaction.details.jev.stats.jevRequests, stub.hits.length);
  } finally { await stub.close(); }
});

test('oversized service context cancels the Pi hook without an automatic native fallback', async () => {
  const stub = await stubServer(() => ({ status: 422, body: JSON.stringify({ error: 'context exceeds 2048 tokens' }) }));
  try {
    const config = localConfig(stub.url);
    const result = await handleCompact(piEvent(), piCtx([], undefined, undefined, { mode: 'rpc', hasUI: false }), testDeps({ config, makeAsker: createCompactionAsker }));
    assert.deepEqual(result, { cancel: true });
    assert.equal(stub.hits.length, 1);
  } finally { await stub.close(); }
});

test('local choice validation bounds confidence without deriving it from probabilities', () => {
  const questions: JevQuestions = { option: { type: 'choice', instructions: 'Choose', criteria: { a: 'A', b: 'B' } } };
  for (const confidence of [0, 0.6, 0.8, 1]) {
    const raw = { model: 'clm', answers: { option: { type: 'choice', choice: 'a', confidence, probabilities: { a: 0.8, b: 0.2 } } } };
    assert.equal(validateLocalAnswers(raw, questions, 'clm').model, 'clm');
  }
  for (const confidence of [-1, 1.1, NaN, Infinity, undefined, '0.8']) {
    const raw = { model: 'clm', answers: { option: { type: 'choice', choice: 'a', confidence, probabilities: { a: 0.8, b: 0.2 } } } };
    assert.throws(() => validateLocalAnswers(raw, questions, 'clm'), typedError('parse'));
  }
});

const busyReply = { status: 503, body: JSON.stringify({ error: 'decision relay busy' }) };
const retryConfig = (url: string) => {
  const config = localConfig(url);
  Object.assign(config.api, { maxRetries: 2, retryBudgetMs: 2_000, timeoutMs: 2_000,
    retryBackoffMs: 5, retryBackoffMaxMs: 10, retryJitter: 0.2 });
  return config;
};

test('relay busy 503 retries then succeeds with one calls.jsonl row per attempt', async () => {
  let hits = 0;
  const stub = await stubServer(() => ++hits < 3 ? busyReply :
    { status: 200, body: JSON.stringify({ model: 'clm', answers: ANSWERS }) });
  try {
    const config = retryConfig(stub.url);
    const client = new LocalDecisionClient({ config, configHash: 'retry-test', caller: 'test' });
    assert.equal((await client.ask(STATE, QUESTIONS)).model, 'clm');
    assert.equal(stub.hits.length, 3); assert.equal(client.requestCount, 3); assert.equal(client.responseCount, 1);
    await flushTelemetry();
    const rows = readFileSync(config.telemetry.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => [row.outcome, row.retry]), [['http', 0], ['http', 1], ['ok', 2]]);
    assert.deepEqual(rows.map(row => [row.http_status, row.retryable]), [[503, true], [503, true], [200, false]]);
    assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
    assert.ok(stub.hits.every(hit => hit.body === stub.hits[0]!.body));
  } finally { await stub.close(); }
});

test('relay busy 503 beyond max retries or elapsed budget fails as HTTP without another dispatch', async () => {
  for (const exhausted of ['count', 'time']) {
    const stub = await stubServer(() => busyReply);
    try {
      const config = retryConfig(stub.url);
      if (exhausted === 'time') {
        config.api.retryBudgetMs = 150; config.api.localTimeoutMs = 2_000;
        config.api.retryBackoffMs = 200; config.api.retryBackoffMaxMs = 200; config.api.retryJitter = 0;
      }
      const client = new LocalDecisionClient({ config, configHash: 'retry-test', caller: 'test' });
      await assert.rejects(client.ask(STATE, QUESTIONS), error => {
        assert.ok(error instanceof JevError); assert.equal(error.kind, 'http'); assert.equal(error.status, 503); return true;
      });
      const count = exhausted === 'count' ? 3 : 1;
      assert.equal(stub.hits.length, count); assert.equal(client.responseCount, 0);
      await flushTelemetry();
      const rows = readFileSync(config.telemetry.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(rows.map(row => [row.outcome, row.retry]), Array.from({ length: count }, (_, i) => ['http', i]));
    } finally { await stub.close(); }
  }
});

test('non-busy 503 and relay yield 429 remain one-shot failures', async () => {
  for (const reply of [{ status: 503, body: JSON.stringify({ error: 'decision relay transport failed' }) },
    { status: 503, body: 'PRIVATE-INVALID' }, { status: 429, body: JSON.stringify({ error: 'decision relay yielding to live traffic' }) }]) {
    const stub = await stubServer(() => reply);
    try {
      const config = retryConfig(stub.url);
      await assert.rejects(createCompactionAsker(config, 'test').ask(STATE, QUESTIONS), typedError('http'));
      assert.equal(stub.hits.length, 1);
      await flushTelemetry();
      const row = JSON.parse(readFileSync(config.telemetry.path, 'utf8').trim());
      assert.equal(row.http_status, reply.status); assert.equal(row.retryable, false);
      assert.ok(!JSON.stringify(row).includes('PRIVATE'));
    } finally { await stub.close(); }
  }
});

test('caller abort during relay-busy backoff cancels without retrying or sending queued siblings', async () => {
  let seen!: () => void;
  const entered = new Promise<void>(resolve => { seen = resolve; });
  const stub = await stubServer(() => { seen(); return busyReply; });
  try {
    const config = retryConfig(stub.url);
    config.api.retryBackoffMs = 500; config.api.retryBackoffMaxMs = 500; config.api.retryJitter = 0;
    const controller = new AbortController();
    const client = new LocalDecisionClient({ config, configHash: 'retry-test', caller: 'test' }, controller.signal);
    const settled = Promise.allSettled([client.ask(STATE, QUESTIONS), client.ask(STATE, QUESTIONS)]);
    await entered;
    // Wait for the HTTP row to prove the first response has completed, not merely entered fetch.
    let rows: any[] = [];
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5)); await flushTelemetry();
      try { rows = readFileSync(config.telemetry.path, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { /* awaiting response */ }
    }
    assert.deepEqual(rows.map(row => [row.outcome, row.retry]), [['http', 0]]);
    controller.abort();
    for (const result of await settled) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.ok(typedError('aborted')(result.reason));
    }
    assert.equal(stub.hits.length, 1);
  } finally { await stub.close(); }
});


test('explicit local_timeout_ms remains authoritative over retry_budget_ms for first dispatch', async () => {
  const stub = await stubServer(() => ({ status: 200, body: JSON.stringify({ model: 'clm', answers: ANSWERS }) }));
  try {
    const config = retryConfig(stub.url); config.api.localTimeoutMs = 1_000; config.api.retryBudgetMs = 50;
    assert.equal((await createCompactionAsker(config, 'test').ask(STATE, QUESTIONS)).model, 'clm');
    assert.equal(stub.hits.length, 1);
    assert.ok(Number(stub.hits[0]!.headers['x-request-timeout-ms']) > 50);
  } finally { await stub.close(); }
});
