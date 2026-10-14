import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flushTelemetry } from '../src/client/ledger.js';
import { readFileSync } from 'node:fs';
import { JevHttpClient, JevError } from '../src/client/jev-client.js';
import { LocalDecisionClient } from '../src/client/local-client.js';
import { entryMarker, markerLines } from '../src/pi/marker.js';
import type { JevQuestions } from '../src/vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { stubServer } from './support/stub-server.js';
import { testConfig } from './support/config.js';

const questions: JevQuestions = {
  a: { type: 'noul', instructions: 'keep' },
  b: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] },
  c: { type: 'choice', instructions: 'choose', criteria: { no: 'drop', yes: 'keep' } },
};
const complete = {
  a: { type: 'noul', noul: 1 },
  b: { type: 'score', score: 0.75, confidence: 0.5, probabilities: { '0': 0.25, '1': 0.75 } },
  c: { type: 'choice', choice: 'yes', confidence: 0.5, probabilities: { no: 0.25, yes: 0.75 } },
};
const cases = [
  ['empty', {}],
  ['partial', { a: complete.a }],
  ['array', []],
  ['wrong type', { ...complete, a: { type: 'score', noul: 1 } }],
  ['invalid noul', { ...complete, a: { type: 'noul', noul: 1.1 } }],
  ['missing probability', { ...complete, b: { ...complete.b, probabilities: { '1': 1 } } }],
  ['invalid probability', { ...complete, b: { ...complete.b, probabilities: { '0': -0.25, '1': 1.25 } } }],
  ['wrong probability sum', { ...complete, b: { ...complete.b, probabilities: { '0': 0.5, '1': 0.75 } } }],
  ['wrong confidence', { ...complete, b: { ...complete.b, confidence: 0.9 } }],
  ['wrong expected score', { ...complete, b: { ...complete.b, score: 0.5 } }],
  ['wrong choice', { ...complete, c: { ...complete.c, choice: 'no' } }],
  ['complete', complete],
] as const;

// Hosted readers ignore local discriminators and confidence/score algebra,
// but core/judge.ts rejects noul outside [0, 1].
const hostedAccepted = new Set(cases.map(([name]) => name).filter(name => !['empty', 'partial', 'array', 'invalid noul'].includes(name)));
for (const backend of ['typesafe', 'local'] as const) for (const [name, answers] of cases) {
  const expectedCount = (backend === 'local' ? name === 'complete' : hostedAccepted.has(name)) ? 1 : 0;
  test(`hosted-count: ${backend} ${name} answers count ${expectedCount}`, async () => {
    const body = { model: 'openjev', revision: 'rev', answers, usage: { input_tokens: 7, output_tokens: 3 } };
    const stub = await stubServer(() => ({ status: 200, body: JSON.stringify(body) }));
    try {
      const config = testConfig(c => Object.assign(c.api, { backend,
        localEndpoint: stub.url.replace('/v1/systemone', '/v1/systemone-local'), localModel: 'openjev', localRevision: 'rev' }));
      const client = backend === 'local'
        ? new LocalDecisionClient({ config, configHash: 'h', caller: 'test' })
        : new JevHttpClient({ config, configHash: 'h', caller: 'test', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
      if (backend === 'local' && name !== 'complete') {
        await assert.rejects(client.ask({}, questions), (error: unknown) => error instanceof JevError && error.kind === 'parse');
        assert.ok(!Object.hasOwn(client.backend_descriptor, 'verified_revision'));
      } else {
        const returned = await client.ask({}, questions);
        assert.deepEqual(JSON.parse(JSON.stringify(returned)), backend === 'local'
          ? { model: body.model, answers, usage: body.usage } : body, 'return behavior is unchanged');
      }
      assert.equal(client.requestCount, 1);
      assert.equal(client.responseCount, expectedCount);
      const card = markerLines(entryMarker({ details: { jev: {
        backend, backend_descriptor: client.backend_descriptor,
        backend_requests: { [backend]: client.requestCount }, backend_responses: { [backend]: client.responseCount },
      } } }), false, 100).join('\n');
      assert.ok(card.includes(expectedCount ? 'served' : 'service unconfirmed'));
      if (!expectedCount) assert.ok(!card.includes('served'));
    } finally { await stub.close(); }
  });
}

test('hosted-count: counting checks requested answers, not hosted model identity or extra answers', async () => {
  const body = { model: 'hosted-alias', answers: { ...complete, extra: { type: 'noul', noul: 0 } } };
  const stub = await stubServer(() => ({ status: 200, body: JSON.stringify(body) }));
  try {
    const client = new JevHttpClient({ config: testConfig(), configHash: 'h', caller: 'test', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
    assert.deepEqual(await client.ask({}, questions), body);
    assert.equal(client.responseCount, 1);
  } finally { await stub.close(); }
});

// The choice shape is read by core/{chain,agent-directives,charter-judge}.ts
// readChoice; noul/score by the vendored request.ts/decision.ts readers.
// No local service algebra is imposed on these hosted shapes.
const hosted = {
  a: { noul: 0.9 },
  b: { score: 0.6 },
  c: { choice: 'yes', probabilities: { yes: 0.7 } },
};
const hostedCases = [
  ['type-less hosted answers', hosted, 1],
  ['hosted score with independent confidence/probabilities', { ...hosted, b: { score: 0.6, confidence: 0.9, probabilities: { '0': 0.25, '1': 0.75 } } }, 1],
  ['hosted criteria-scale score', { ...hosted, b: { score: 3 } }, 1],
  ['hosted empty', {}, 0],
  ['hosted partial', { a: hosted.a }, 0],
  ['hosted null answer', { ...hosted, a: null }, 0],
  ['hosted primitive answer', { ...hosted, a: 0.9 }, 0],
  ['hosted missing noul', { ...hosted, a: {} }, 0],
  ['hosted nonnumeric noul', { ...hosted, a: { noul: '0.9' } }, 0],
  ['hosted missing score', { ...hosted, b: {} }, 0],
  ['hosted nonnumeric score', { ...hosted, b: { score: '0.6' } }, 0],
  ['hosted choice in value field', { ...hosted, c: { value: 'yes', probabilities: { yes: 0.7 } } }, 0],
  ['hosted choice with scalar probability', { ...hosted, c: { choice: 'yes', probability: 0.7 } }, 0],
  ['hosted nonnumeric chosen probability', { ...hosted, c: { choice: 'yes', probabilities: { yes: '0.7' } } }, 0],
  ['hosted missing choice', { ...hosted, c: { probabilities: { yes: 0.7 } } }, 0],
  ['hosted missing chosen probability', { ...hosted, c: { choice: 'yes', probabilities: { no: 0.3 } } }, 0],
] as const;
for (const [name, answers, expectedCount] of hostedCases) {
  test(`hosted-count: ${name} count ${expectedCount} without changing returned body`, async () => {
    const body = { answers };
    const stub = await stubServer(() => ({ status: 200, body: JSON.stringify(body) }));
    try {
      const config = testConfig();
      const client = new JevHttpClient({ config, configHash: 'h', caller: 'test', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
      assert.deepEqual(await client.ask({}, questions), body);
      assert.equal(client.responseCount, expectedCount);
      assert.equal(client.requestCount, 1);
      await flushTelemetry();
      assert.equal(JSON.parse(readFileSync(config.telemetry.path, 'utf8')).outcome, 'ok');
    } finally { await stub.close(); }
  });
}

// Use the canonical type-less hosted fixture from jev-client.test.ts, not a
// synthesized local typed answer, for zero-request and probability edges.
for (const [name, requested, answers, expectedCount] of [
  ['zero questions, empty answers', {}, {}, 0],
  ['zero questions, unsolicited answer', {}, { call_t1: { noul: 0.9 } }, 0],
  ...[-0.1, 0, 0.9, 1, 1.1].map(noul => [
    `noul ${noul}`, { call_t1: { type: 'noul', instructions: 'keep' } },
    { call_t1: { noul } }, noul >= 0 && noul <= 1 ? 1 : 0,
  ] as const),
] as const) {
  test(`hosted-count: canonical hosted fixture ${name} count ${expectedCount}`, async () => {
    const body = { answers, usage: { input_tokens: 321, output_tokens: 4 } };
    const stub = await stubServer(() => ({ status: 200, body: JSON.stringify(body) }));
    try {
      const config = testConfig();
      const client = new JevHttpClient({ config, configHash: 'h', caller: 'test', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
      assert.deepEqual(await client.ask({}, requested), body, 'counting never changes the returned payload');
      assert.equal(client.requestCount, 1);
      assert.equal(client.responseCount, expectedCount);
      await flushTelemetry();
      assert.equal(JSON.parse(readFileSync(config.telemetry.path, 'utf8')).outcome, 'ok');
    } finally { await stub.close(); }
  });
}

// JSON cannot contain accessors or infinities; inject at the parse seam to ensure
// counting alone cannot change the already-parsed payload or the call's outcome.
for (const [name, makeBody] of [
  ['throwing answer', () => ({ answers: { ...complete, a: { type: 'noul', get noul() { throw new Error('bad accessor'); } } } })],
  ['throwing answers container', () => ({ get answers() { throw new Error('bad container'); } })],
  ['nonfinite noul', () => ({ answers: { ...complete, a: { noul: Infinity } } })],
  ['nonfinite score', () => ({ answers: { ...complete, b: { score: NaN } } })],
  ['nonfinite chosen probability', () => ({ answers: { ...complete, c: { choice: 'yes', probabilities: { yes: Infinity } } } })],
] as const) {
  test(`hosted-count: ${name} is uncounted and never changes call behavior`, async t => {
    const wire = JSON.stringify({ answers: complete });
    const stub = await stubServer(() => ({ status: 200, body: wire }));
    const parsed = makeBody();
    const parse = JSON.parse;
    let parses = 0;
    t.mock.method(JSON, 'parse', (text: string) => {
      if (text === wire) {
        parses += 1;
        // The container getter must pass the parser's first two reads, then throw
        // only when the observational counting gate reads it.
        if (name === 'throwing answers container') {
          let reads = 0;
          Object.defineProperty(parsed, 'answers', { get() { if (++reads > 2) throw new Error('bad container'); return complete; } });
        }
        return parsed;
      }
      return parse(text);
    });
    try {
      const config = testConfig();
      const client = new JevHttpClient({ config, configHash: 'h', caller: 'test', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
      assert.equal(await client.ask({}, questions), parsed);
      assert.equal(parses, 1);
      assert.equal(client.responseCount, 0);
      assert.equal(client.requestCount, 1);
      await flushTelemetry();
      assert.equal(parse(readFileSync(config.telemetry.path, 'utf8')).outcome, 'ok');
    } finally { t.mock.restoreAll(); await stub.close(); }
  });
}

test('hosted-count: a malformed question cannot turn an accepted body into a failure', async () => {
  const body = { answers: complete };
  const stub = await stubServer(() => ({ status: 200, body: JSON.stringify(body) }));
  try {
    const client = new JevHttpClient({ config: testConfig(), configHash: 'h', caller: 'test', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
    assert.deepEqual(await client.ask({}, { ...questions, a: null } as unknown as JevQuestions), body);
    assert.equal(client.responseCount, 0);
    assert.equal(client.requestCount, 1);
  } finally { await stub.close(); }
});
