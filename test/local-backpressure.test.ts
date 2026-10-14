import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { LocalDecisionClient } from '../src/client/local-client.js';
import { JevError, MAX_RESPONSE_BYTES } from '../src/client/jev-client.js';
import { testConfig } from './support/config.js';

const questions = () => ({ keep: { type: 'noul' as const, instructions: 'Keep original instruction' } });
const answer = JSON.stringify({ model: 'clm', answers: { keep: { type: 'noul', noul: .7 } } });
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
async function service(handler: (body: any, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { void handler(JSON.parse(body), res); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = testConfig(c => {
    c.api.backend = 'local'; c.api.localModel = 'clm';
    c.api.localEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone-local`;
    c.api.timeoutMs = 1000; c.api.retryBudgetMs = 1000;
  });
  return { config, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
const kind = (result: PromiseSettledResult<unknown>, expected: string) => {
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') {
    assert.ok(result.reason instanceof JevError); assert.equal(result.reason.kind, expected);
  }
};

test('local burst is FIFO through delayed bodies and snapshots queued inputs', async () => {
  const entered = gate(), release = gate(); const seen: any[] = [];
  let active = 0, maximum = 0;
  const stub = await service(async (body, res) => {
    seen.push(body); maximum = Math.max(maximum, ++active);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (seen.length === 1) {
      res.write(answer.slice(0, 10)); entered.resolve(); await release.promise;
      res.end(answer.slice(10));
    } else res.end(answer);
    active -= 1;
  });
  try {
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
    const state = { id: 2 }; const q = questions();
    const pending = [client.ask({ id: 1 }, questions()), client.ask(state, q), client.ask({ id: 3 }, questions())];
    state.id = 99; q.keep.instructions = 'mutated after enqueue';
    await entered.promise; assert.equal(seen.length, 1); release.resolve();
    await Promise.all(pending);
    assert.equal(maximum, 1); assert.deepEqual(seen.map(x => x.state.id), [1, 2, 3]);
    assert.equal(seen[1].questions.keep.instructions, 'Keep original instruction');
  } finally { release.resolve(); await stub.close(); }
});

test('queued caller cancellation sends no siblings', async () => {
  const entered = gate(), release = gate(); let requests = 0;
  const stub = await service(async (_body, res) => {
    requests++; entered.resolve(); await release.promise; res.end(answer);
  });
  try {
    const controller = new AbortController();
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' }, controller.signal);
    const pending = Array.from({ length: 4 }, () => client.ask({}, questions()));
    const settled = Promise.allSettled(pending);
    await entered.promise; controller.abort();
    for (const result of await settled) kind(result, 'aborted');
    assert.equal(requests, 1);
  } finally { release.resolve(); await stub.close(); }
});

test('HTTP and parse failures drain a burst, reject late siblings and allow a fresh burst', async () => {
  for (const failure of ['http', 'parse']) {
    let requests = 0;
    const stub = await service((_body, res) => {
      requests++;
      if (requests === 1) {
        res.writeHead(failure === 'http' ? 503 : 200);
        res.end(failure === 'http' ? '{}' : 'invalid');
      } else res.end(answer);
    });
    try {
      const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
      const pending = Array.from({ length: 20 }, () => client.ask({}, questions()));
      let late!: Promise<unknown>;
      pending[0]!.catch(() => { late = client.ask({}, questions()); void late.catch(() => {}); });
      for (const result of await Promise.allSettled(pending)) kind(result, failure);
      kind((await Promise.allSettled([late]))[0]!, failure);
      assert.equal(requests, 1);
      // Only the dispatched failure appears in telemetry, not the unsent queue.
      let rows: any[] = [];
      for (let i = 0; i < 50 && rows.length === 0; i++) {
        await new Promise(r => setTimeout(r, 10));
        try { rows = readFileSync(stub.config.telemetry.path, 'utf8').trim().split('\n').map(x => JSON.parse(x)); } catch {}
      }
      assert.equal(rows.length, 1); assert.equal(rows[0].outcome, failure);
      assert.equal((await client.ask({}, questions())).model, 'clm'); assert.equal(requests, 2);
    } finally { await stub.close(); }
  }
});

test('configured timeout includes queue waiting and sends only the first hung request', async () => {
  let requests = 0;
  const stub = await service(() => { requests++; });
  try {
    stub.config.api.timeoutMs = 150; stub.config.api.retryBudgetMs = 150;
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
    const started = performance.now();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => client.ask({}, questions())));
    results.forEach(result => kind(result, 'timeout'));
    assert.equal(requests, 1); assert.ok(performance.now() - started < 500);
  } finally { await stub.close(); }
});

test('oversized declared slow body is cancelled before a later burst', async () => {
  let requests = 0; const closed = gate();
  const stub = await service((_body, res) => {
    if (++requests === 1) {
      res.on('close', closed.resolve);
      res.writeHead(200, { 'content-length': String(MAX_RESPONSE_BYTES + 1) }); res.write('{');
    } else res.end(answer);
  });
  try {
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
    await assert.rejects(client.ask({}, questions()), e => e instanceof JevError && e.kind === 'http');
    await closed.promise;
    assert.equal((await client.ask({}, questions())).model, 'clm'); assert.equal(requests, 2);
  } finally { await stub.close(); }
});


test('remaining deadline below protocol minimum rejects queued request before fetch', async () => {
  let requests = 0;
  const stub = await service(async (_body, res) => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 130));
    res.end(answer);
  });
  try {
    stub.config.api.timeoutMs = 200; stub.config.api.retryBudgetMs = 200;
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
    const settled = await Promise.allSettled([client.ask({}, questions()), client.ask({}, questions())]);
    assert.equal(settled[0]!.status, 'fulfilled'); kind(settled[1]!, 'timeout'); assert.equal(requests, 1);
  } finally { await stub.close(); }
});
