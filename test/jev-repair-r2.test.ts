import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { LocalDecisionClient } from '../src/client/local-client.js';
import { JevHttpClient } from '../src/client/jev-client.js';
import { flushTelemetry } from '../src/client/ledger.js';
import { handleCompact } from '../src/pi/extension.js';
import { entryMarker, markerFor, markerLines, renderCompactionPresentation } from '../src/pi/marker.js';
import { outcomeLine, routeActivity } from '../src/pi/presentation.js';
import { testDeps, piCtx, piEvent, piUser } from './support/pi-event.js';
import { testConfig } from './support/config.js';
import { stubServer } from './support/stub-server.js';

const logs = async (path: string) => {
  await flushTelemetry();
  return readFileSync(join(dirname(path), 'compactions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
};
const plain = { fg: (_: string, value: string) => value };

test('r2: failures and opt-outs before constructing a client omit activity counters', async () => {
  for (const kind of ['disabled', 'input_shape', 'estimator']) for (const backend of ['local', 'typesafe']) {
    let clients = 0;
    const config = testConfig(c => { c.api.backend = backend as 'local' | 'typesafe'; if (backend === 'local') Object.assign(c.api, { localEndpoint: 'http://127.0.0.1:18390/v1/systemone-local', localModel: 'openjev' }); if (kind === 'disabled') c.compaction.enabled = false; });
    const deps = testDeps({ config, makeAsker: () => { clients++; throw Error('must not construct'); } });
    if (kind === 'estimator') deps.estimator = async () => { throw Error('estimator unavailable'); };
    const result = await handleCompact(kind === 'input_shape' ? {} : piEvent(), piCtx(), deps);
    assert.equal(clients, 0);
    assert.ok(kind === 'disabled' ? result === undefined : result && 'cancel' in result);
    const row = (await logs(config.telemetry.path)).at(-1);
    assert.equal(row.reason, kind);
    for (const record of [row, deps.last]) if (record) {
      assert.ok(!Object.hasOwn(record, 'backend_requests'), `${backend}/${kind}: no client evidence`);
      assert.ok(!Object.hasOwn(record, 'backend_responses'), `${backend}/${kind}: no response evidence`);
    }
  }
});

test('r2: all-503 charter requests with zero pruning still compact but never claim served', async () => {
  const stub = await stubServer(() => ({ status: 503 }));
  try {
    const config = testConfig(c => Object.assign(c.api, { backend: 'local', localEndpoint: stub.url.replace('/v1/systemone', '/v1/systemone-local'), localModel: 'openjev', fallback: 'none' }));
    config.compaction.charter = true;
    const clients: LocalDecisionClient[] = [];
    const deps = testDeps({ config, makeAsker: c => { const client = new LocalDecisionClient({ config: c, configHash: 'h', caller: 'test' }); clients.push(client); return client; } });
    const branch = ['Keep all requirements.', 'Fix the test.'].map((text, i) => ({ type: 'message', id: `u${i}`, parentId: null, timestamp: '1970-01-01T00:00:00.000Z', message: piUser(text) }));
    const result = await handleCompact(piEvent({ branchEntries: branch, preparation: { messagesToSummarize: [piUser('Keep this user requirement.')] } }), piCtx(), deps);
    assert.ok(result && 'compaction' in result, 'tolerated charter failures do not prevent zero-pruning compaction');
    assert.ok(stub.hits.length > 0, 'the real service was asked');
    const jev = result.compaction.details.jev;
    assert.equal(jev.stats.jevRequests, 0, 'no pruning calls');
    assert.equal(clients.reduce((sum, c) => sum + c.requestCount, 0), stub.hits.length);
    const data = entryMarker({ ...result.compaction, fromHook: true });
    assert.match(markerLines(data, false, 60)[0], /service unconfirmed/);
    assert.ok(!markerLines(data, false).join('\n').includes('served'));
    assert.deepEqual(jev.backend_requests, { local: stub.hits.length });
    assert.deepEqual(jev.backend_responses, { local: 0 });
    for (const record of [deps.last, (await logs(config.telemetry.path)).at(-1), markerFor({ ...result.compaction, fromHook: true }, deps.last, null)]) {
      assert.deepEqual(record?.backend_responses, { local: 0 });
    }
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  } finally { await stub.close(); }
});

test('r2: future route explicitly distinguishes served, no requests, unknown and unconfirmed evidence', () => {
  const route = { backend: 'edge', backend_descriptor: { id: 'edge', label: 'Edge West', model: 'edge-2', where: 'https://edge.example' } };
  for (const [counts, activity] of [
    [{ backend_requests: { edge: 2 }, backend_responses: { edge: 1 } }, 'served'],
    [{ backend_requests: { edge: 0 }, backend_responses: { edge: 0 } }, 'no requests'],
    [{}, 'activity unknown'],
    [{ backend_requests: { edge: 2 }, backend_responses: { edge: 0 } }, 'service unconfirmed'],
    [{ backend_requests: { edge: 2 } }, 'service unconfirmed'], // historical attempts are not responses
    [{ backend_requests: { local: 0 }, backend_responses: { local: 1 } }, 'activity unknown'],
  ] as const) {
    const record = { ...route, ...counts };
    assert.equal(routeActivity(record), activity);
    const data = entryMarker({ details: { jev: record } });
    for (const width of [60, 100]) {
      const component = renderCompactionPresentation(data, { expanded: false, supportsCollapsedReplacement: true, expandHint: 'ctrl+o to expand' }, plain);
      assert.ok('kind' in component);
      const rows = component.component.render(width);
      assert.equal(rows.length, 3); assert.ok(rows.every(row => visibleWidth(row) <= width));
      assert.ok(rows[0].includes(activity));
    }
    const message = outcomeLine('success', record);
    assert.ok(visibleWidth(message) <= 49); assert.ok(message.includes(activity));
    const long = { ...record, backend_descriptor: { ...route.backend_descriptor, label: '界'.repeat(100) } };
    assert.ok(outcomeLine('success', long).includes(activity), 'activity precedes optional model and long identity');
  }
});

test('r2: response counters count accepted responses only, and reused clients report per-attempt deltas', async () => {
  let hits = 0;
  const stub = await stubServer(() => ++hits === 1 ? { status: 529 } : { status: 200, body: JSON.stringify({ model: 'openjev', revision: 'rev', answers: { a: { type: 'noul', noul: 1 } } }) });
  try {
    const config = testConfig(c => { c.api.maxRetries = 1; c.api.retryBackoffMs = 1; });
    const hosted = new JevHttpClient({ config, configHash: 'h', caller: 'test', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
    assert.equal(hosted.responseCount, 0);
    await hosted.ask({}, { a: { type: 'noul', instructions: 'keep' } });
    assert.equal(hosted.requestCount, 2); assert.equal(hosted.responseCount, 1);
    const localConfig = testConfig(c => Object.assign(c.api, { backend: 'local', localEndpoint: stub.url.replace('/v1/systemone', '/v1/systemone-local'), localModel: 'openjev', localRevision: 'rev' }));
    const local = new LocalDecisionClient({ config: localConfig, configHash: 'h', caller: 'test' });
    await local.ask({}, { a: { type: 'noul', instructions: 'keep' } });
    assert.equal(local.responseCount, 1);
    const deps = testDeps({ config: localConfig, makeAsker: () => local });
    const result = await handleCompact(piEvent({ preparation: { messagesToSummarize: [piUser('Keep this.')] } }), piCtx(), deps);
    assert.ok(result && 'compaction' in result);
    assert.deepEqual(result.compaction.details.jev.backend_responses, { local: 0 });
    assert.match(markerLines(entryMarker({ ...result.compaction, fromHook: true }), false)[0], /no requests/);
    localConfig.api.localRevision = 'mismatch';
    const wrong = new LocalDecisionClient({ config: localConfig, configHash: 'h', caller: 'test' });
    await assert.rejects(wrong.ask({}, { a: { type: 'noul', instructions: 'keep' } }));
    assert.equal(wrong.requestCount, 1); assert.equal(wrong.responseCount, 0);
  } finally { await stub.close(); }
});

test('r2: malformed HTTP-200 bodies are attempts, never accepted responses', async () => {
  for (const body of ['not json', JSON.stringify({ model: 'openjev', revision: 'rev', answers: {} })]) {
    const stub = await stubServer(() => ({ status: 200, body }));
    try {
      const config = testConfig(c => Object.assign(c.api, { backend: 'local', localEndpoint: stub.url.replace('/v1/systemone', '/v1/systemone-local'), localModel: 'openjev' }));
      const local = new LocalDecisionClient({ config, configHash: 'h', caller: 'test' });
      await assert.rejects(local.ask({}, { a: { type: 'noul', instructions: 'keep' } }));
      assert.equal(local.requestCount, 1); assert.equal(local.responseCount, 0);
      assert.ok(!Object.hasOwn(local.backend_descriptor, 'verified_revision'));
      if (body === 'not json') {
        const hosted = new JevHttpClient({ config: testConfig(), configHash: 'h', caller: 'test', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
        await assert.rejects(hosted.ask({}, { a: { type: 'noul', instructions: 'keep' } }));
        assert.equal(hosted.requestCount, 1); assert.equal(hosted.responseCount, 0);
      }
    } finally { await stub.close(); }
  }
});

test('r2: injected clients without response counters never turn positive attempts into served', async () => {
  const deps = testDeps();
  const fake = deps.makeAsker;
  deps.makeAsker = (...args) => {
    const client = fake(...args);
    return { requestCount: 0, async ask(...params: Parameters<typeof client.ask>) {
      this.requestCount++;
      return client.ask(...params);
    } };
  };
  const result = await handleCompact(piEvent(), piCtx(), deps);
  assert.ok(result && 'compaction' in result);
  const jev = result.compaction.details.jev;
  assert.ok(jev.backend_requests!.typesafe > 0);
  assert.ok(!Object.hasOwn(jev, 'backend_responses'));
  assert.match(markerLines(entryMarker({ ...result.compaction, fromHook: true }), false)[0], /service unconfirmed/);
});
