import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OpenAIDecisionsClient } from '../src/client/openai-decisions-client.js';
import { JevError } from '../src/client/jev-client.js';
import { flushTelemetry } from '../src/client/ledger.js';
import { testConfig } from './support/config.js';
import { stubServer, type Reply } from './support/stub-server.js';
import type { JevQuestions } from '../src/vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { captureCharter, readCharterState } from '../src/core/charter.js';
import { retireCorrected, type ChoiceAsker } from '../src/core/charter-judge.js';

const KEY = 'PRIVATE-MOCK-KEY';
const questions: JevQuestions = {
  retain: { type: 'noul', instructions: 'Keep?', criteria: { true: 'Still needed', false: 'Obsolete' } },
  option: { type: 'choice', instructions: 'Choose', criteria: { a: 'Alpha', b: null } },
  stale: { type: 'score', instructions: 'Staleness', criteria: ['needed', 'uncertain', 'obsolete'] },
};
const answers = () => [
  { type: 'score', name: 'stale', score: .4, confidence: .8, probabilities: [
    { value: 0, label: 'needed', probability: .7 }, { value: 1, label: 'uncertain', probability: .2 }, { value: 2, label: 'obsolete', probability: .1 },
  ] },
  { type: 'predicate', name: 'retain', probability: .9 },
  { type: 'choice', name: 'option', choice: 'a', confidence: .8, probabilities: [{ value: 'a', probability: .8 }, { value: 'b', probability: .2 }] },
];
const reply = (a: unknown = answers(), model = 'gpt-6-luna'): Reply => ({ status: 200, body: JSON.stringify({ model, answers: a, usage: { input_tokens: 123 } }) });
const setup = (url: string, env: Record<string, string | undefined> = { JEV_OPENAI_DECISIONS_API_KEY: KEY }) => {
  const config = testConfig(c => { c.api.openaiDecisionsEndpoint = url.replace('/v1/systemone', '/v1/decisions'); });
  const client = new OpenAIDecisionsClient({ config, configHash: 'test', caller: 'test', env, context: { hookId: 'h', attemptId: 'a' } });
  return { config, client };
};
const kind = (expected: string) => (e: unknown) => {
  assert.ok(e instanceof JevError); assert.equal(e.kind, expected); assert.ok(!String(e).includes(KEY)); return true;
};

test('maps object/string state and all questions/answers by name; propagates usage and logs no secrets', async () => {
  const stub = await stubServer(() => reply());
  const { config, client } = setup(stub.url);
  try {
    const state = { z: 'PRIVATE-STATE', a: [1, 2] };
    const result = await client.ask(state, questions, { round: 'span', batch: 2 });
    assert.equal(result.model, 'gpt-6-luna');
    assert.deepEqual(result.usage, { input_tokens: 123, output_tokens: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(result.answers)), {
      retain: { type: 'noul', noul: .9 },
      option: { type: 'choice', choice: 'a', confidence: .8, probabilities: { a: .8, b: .2 } },
      stale: { type: 'score', score: .4, confidence: .8, probabilities: { 0: .7, 1: .2, 2: .1 } },
    });
    assert.deepEqual(JSON.parse(stub.hits[0]!.body), {
      model: 'gpt-6-luna', input: JSON.stringify(state), questions: [
        { type: 'predicate', name: 'retain', instructions: 'Keep?\nTrue: Still needed\nFalse: Obsolete' },
        { type: 'choice', name: 'option', instructions: 'Choose', choices: [{ value: 'a', description: 'Alpha' }, { value: 'b', description: 'b' }] },
        { type: 'score', name: 'stale', instructions: 'Staleness', levels: ['needed', 'uncertain', 'obsolete'].map(label => ({ label, description: label })) },
      ],
    });
    assert.equal(stub.hits[0]!.headers.authorization, `Bearer ${KEY}`);
    await client.ask('unchanged string', { retain: { type: 'noul', instructions: 'Keep?' } });
    assert.equal(JSON.parse(stub.hits[1]!.body).input, 'unchanged string');
    assert.equal(JSON.parse(stub.hits[1]!.body).questions[0].instructions, 'Keep?');
    assert.equal(client.requestCount, 2); assert.equal(client.responseCount, 2);
    await flushTelemetry();
    const log = readFileSync(config.telemetry.path, 'utf8');
    assert.ok(!log.includes(KEY)); assert.ok(!log.includes('PRIVATE-STATE')); assert.ok(!log.toLowerCase().includes('authorization'));
    const row = JSON.parse(log.split('\n')[0]!);
    assert.equal(row.backend, 'openai-decisions'); assert.equal(row.input_tokens, 123);
    assert.equal(row.round, 'span'); assert.equal(row.batch, 2); assert.equal(row.hook_id, 'h');
  } finally { await stub.close(); }
});

test('refusal, missing name and duplicate names omit only the affected question', async () => {
  for (const bad of [
    [{ type: 'refusal', name: 'retain' }], [], [{ type: 'predicate', probability: 0 }],
    [{ type: 'predicate', name: 'retain', probability: 0 }, { type: 'predicate', name: 'retain', probability: 1 }],
    [{ type: 'predicate', name: 'retain', probability: 0 }, { type: 'refusal', name: 'retain' }],
  ]) {
    const stub = await stubServer(() => reply([...bad, ...answers().filter(a => a.name !== 'retain')]));
    try {
      const result = await setup(stub.url).client.ask({}, questions);
      assert.equal(Object.hasOwn(result.answers, 'retain'), false);
      assert.ok(result.answers.option); assert.ok(result.answers.stale);
    } finally { await stub.close(); }
  }
});

test('unknown labels, duplicate/incomplete distributions and inconsistent algebra are no answer', async () => {
  const mutations: Array<(a: any[]) => void> = [
    a => { a[2].choice = 'alien'; }, a => { a[2].probabilities[1].value = 'alien'; },
    a => { a[2].probabilities[1].value = 'a'; }, a => { a[2].probabilities.pop(); },
    a => { a[2].probabilities[0].probability = .7; }, a => { a[2].choice = 'b'; },
    a => { a[2].confidence = 1.1; }, a => { a[0].probabilities[1].value = 8; },
    a => { a[0].probabilities[1].label = 'alien'; }, a => { a[0].probabilities[1].value = 0; },
    a => { a[0].score = 1; }, a => { a[0].probabilities.pop(); },
    a => { a[1].probability = -1; }, a => { a[1].type = 'refusal'; },
  ];
  for (const mutate of mutations) {
    const a = answers(); mutate(a);
    const stub = await stubServer(() => reply(a));
    try { assert.equal(Object.keys((await setup(stub.url).client.ask({}, questions)).answers).length, 2); }
    finally { await stub.close(); }
  }
});

test('model pin, invalid JSON, HTTP failures and redirects throw once without exposing body or key', async () => {
  for (const [r, expected] of [
    [reply(answers(), 'other'), 'parse'],
    [{ status: 200, body: KEY }, 'parse'], [{ status: 200, body: JSON.stringify({ model: 'gpt-6-luna' }) }, 'parse'],
    [{ status: 401, body: KEY }, 'auth'], [{ status: 503, body: KEY }, 'http'],
    [{ status: 307, headers: { location: 'https://example.invalid/' }, body: KEY }, 'http'],
  ] as Array<[Reply, string]>) {
    const stub = await stubServer(() => r);
    try {
      const { config, client } = setup(stub.url);
      await assert.rejects(client.ask({}, questions), kind(expected));
      assert.equal(stub.hits.length, 1); assert.equal(client.responseCount, 0);
      await flushTelemetry(); assert.ok(!readFileSync(config.telemetry.path, 'utf8').includes(KEY));
    } finally { await stub.close(); }
  }
});

test('absent key sends nothing; key/env name is resolved at call time; timeout/abort never retry', async () => {
  const stub = await stubServer(() => 'hang');
  try {
    const env: Record<string, string | undefined> = {};
    const { client, config } = setup(stub.url, env);
    await assert.rejects(client.ask({}, questions), e => {
      assert.ok(e instanceof JevError); assert.match(e.message, /JEV_OPENAI_DECISIONS_API_KEY is not set/); return true;
    });
    assert.equal(stub.hits.length, 0); assert.equal(client.requestCount, 0);
    config.api.openaiDecisionsKeyEnv = 'MOCK_DECISIONS_KEY'; env.MOCK_DECISIONS_KEY = KEY;
    config.api.openaiDecisionsTimeoutMs = 50;
    await assert.rejects(client.ask({}, questions), kind('timeout')); assert.equal(stub.hits.length, 1);
    const controller = new AbortController(); controller.abort();
    const aborted = new OpenAIDecisionsClient({ config, caller: 'test', configHash: 'test', env }, controller.signal);
    await assert.rejects(aborted.ask({}, questions), kind('aborted')); assert.equal(stub.hits.length, 1);
    await flushTelemetry(); assert.ok(!readFileSync(config.telemetry.path, 'utf8').includes(KEY));
  } finally { await stub.close(); }
});

test('network failure has sanitized text and one dispatch', async () => {
  const stub = await stubServer(() => reply()); const { client } = setup(stub.url); await stub.close();
  await assert.rejects(client.ask({}, questions), kind('network')); assert.equal(client.requestCount, 1);
});

test('scripted Decisions responses: additive same-kind keeps, replacement retires, refusal keeps', async () => {
  for (const scenario of ['additive', 'replacement', 'refusal', 'confirm-refusal']) {
    const stub = await stubServer(hit => {
      const q = JSON.parse(hit.body).questions[0];
      if (scenario === 'refusal' || (scenario === 'confirm-refusal' && q.type === 'predicate')) return reply([{ type: 'refusal', name: q.name }]);
      if (q.type === 'predicate') return reply([{ type: 'predicate', name: q.name, probability: .05 }]);
      const choice = scenario === 'additive' ? 'none' : 'E1';
      return reply([{ type: 'choice', name: q.name, choice, confidence: .95, probabilities: q.choices.map((c: any) => ({ value: c.value, probability: c.value === choice ? .97 : .03 })) }]);
    });
    try {
      const all = captureCharter([
        { entryId: 'old', role: 'user', text: 'Always run tests before committing.', toolCalls: [] },
        { entryId: 'new', role: 'user', text: scenario === 'additive' ? 'Also run lint before committing.' : 'Instead of tests, run lint before committing.', toolCalls: [] },
      ], { decisionTools: new Set(), hash: t => t, pasteMinLines: 12, toolOutputMinChars: 600 });
      const out = await retireCorrected(all, new Set(['u:new']), readCharterState(undefined), 1, setup(stub.url).client as unknown as ChoiceAsker);
      assert.equal(Object.keys(out.state.retired).length, scenario === 'replacement' ? 1 : 0);
      assert.equal(stub.hits.length, scenario === 'replacement' || scenario === 'confirm-refusal' ? 2 : 1);
    } finally { await stub.close(); }
  }
});
