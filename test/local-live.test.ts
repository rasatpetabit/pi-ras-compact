import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { backendPath, defaultConfigPath, loadConfig, overlayPath, validateConfig, type JevConfig } from '../src/client/config.js';
import { createCompactionAsker } from '../src/client/asker.js';
import { JEV_ENDPOINT, JevError } from '../src/client/jev-client.js';
import { LocalDecisionClient, SERVICE_DEADLINE_CAP_MS } from '../src/client/local-client.js';
import { flushTelemetry } from '../src/client/ledger.js';
import { handleCompact, isLocalServiceFailure, isPiCliProcess } from '../src/pi/extension.js';
import { FakeAsker, allOnes } from './support/fake-asker.js';
import { piCall, piCtx, piEvent, piUser, testDeps } from './support/pi-event.js';
import { testConfig } from './support/config.js';
import { scratchDir } from './support/scratch.js';

const committed = readFileSync(defaultConfigPath(), 'utf8');
const LOCAL = 'backend = "local"\nlocal_endpoint = "http://127.0.0.1:18390/v1/systemone-local"\nlocal_model = "openjev"\n';

test('the backend file layers over base and overlay, is hashed, and only this code reads it', () => {
  const dir = scratchDir('jev-backend-file-');
  const path = join(dir, 'jev.toml');
  writeFileSync(path, committed);
  writeFileSync(overlayPath(path), '[compaction]\npins = ["user", "error", "modify", "boundary", "decision", "instruction"]\n');
  const before = loadConfig(path);
  assert.ok(before.ok);
  assert.equal(before.config.api.backend, 'typesafe');
  writeFileSync(backendPath(path), `[api]\n${LOCAL}local_max_inflight = 8\nlocal_timeout_ms = 600000\nfallback = "typesafe"\n`);
  const after = loadConfig(path);
  assert.ok(after.ok, JSON.stringify(after));
  assert.equal(after.config.api.backend, 'local');
  assert.equal(after.config.api.localModel, 'openjev');
  assert.equal(after.config.api.localMaxInflight, 8);
  assert.equal(after.config.api.localTimeoutMs, 600000);
  assert.equal(after.config.api.fallback, 'typesafe');
  assert.equal(after.config.api.model, before.config.api.model, 'base [api] keys survive the layer');
  assert.deepEqual(after.config.compaction.pins, before.config.compaction.pins, 'the overlay still applies');
  assert.notEqual(after.hash, before.hash, 'a backend change is a config change');
  assert.equal(backendPath('/x/jev.toml'), '/x/jev.backend.toml');
  // The committed base and overlay never carry the backend keys an older pi-jev would reject.
  const liveOverlay = join(dirname(defaultConfigPath()), 'jev.overlay.toml');
  for (const text of [committed, existsSync(liveOverlay) ? readFileSync(liveOverlay, 'utf8') : '']) {
    for (const key of ['backend', 'local_endpoint', 'local_model', 'local_max_inflight', 'local_timeout_ms', 'fallback']) {
      assert.doesNotMatch(text, new RegExp(`^\\s*${key}\\s*=`, 'm'), key);
    }
  }
});

test('new api keys are range-checked and default safely', () => {
  const at = (fields: string) => validateConfig(parse(committed.replace('[api]', '[api]\n' + fields)));
  const plain = at('');
  assert.ok(plain.config);
  assert.equal(plain.config.api.localMaxInflight, undefined);
  assert.equal(plain.config.api.fallback, 'none');
  for (const bad of ['local_max_inflight = 0', 'local_max_inflight = 17', 'local_timeout_ms = 999', 'local_timeout_ms = 900001', 'fallback = "pi"']) {
    assert.equal(at(LOCAL + bad).config, undefined, bad);
  }
  assert.ok(at(LOCAL + 'local_max_inflight = 16\nlocal_timeout_ms = 900000\nfallback = "none"').config);
});

const questions = () => ({ keep: { type: 'noul' as const, instructions: 'Keep original instruction' } });
const answer = JSON.stringify({ model: 'openjev', answers: { keep: { type: 'noul', noul: 0.7 } } });
async function service(handler: (res: ServerResponse) => void, mutate: (c: JevConfig) => void) {
  const server = createServer((req, res) => { req.resume(); req.on('end', () => handler(res)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = testConfig(c => {
    c.api.backend = 'local'; c.api.localModel = 'openjev';
    c.api.localEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone-local`;
    c.api.timeoutMs = 2000; c.api.retryBudgetMs = 2000;
    mutate(c);
  });
  return { config, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}

test('local_max_inflight bounds concurrent requests and keeps FIFO order', async () => {
  const held: ServerResponse[] = [];
  let peak = 0;
  const stub = await service(res => { held.push(res); peak = Math.max(peak, held.length); }, c => { c.api.localMaxInflight = 3; });
  try {
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
    const pending = Array.from({ length: 7 }, () => client.ask({}, questions()));
    for (let i = 0; i < 100 && held.length < 3; i++) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(held.length, 3, 'exactly three in flight');
    while (held.length > 0) {
      const res = held.shift()!; res.end(answer);
      for (let i = 0; i < 50 && held.length === 0 && peak < 7; i++) await new Promise(r => setTimeout(r, 5));
    }
    for (let i = 0; i < 200; i++) {
      if (held.length > 0) held.shift()!.end(answer);
      const settled = await Promise.race([Promise.allSettled(pending).then(() => true), new Promise(r => setTimeout(() => r(false), 5))]);
      if (settled) break;
    }
    for (const result of await Promise.allSettled(pending)) assert.equal(result.status, 'fulfilled');
    assert.equal(peak, 3, 'never more than the limit');
  } finally { await stub.close(); }
});

test('with several in flight, a failure still stops every queued request from being sent', async () => {
  let requests = 0;
  const stub = await service(res => { requests++; res.writeHead(503); res.end('{}'); }, c => { c.api.localMaxInflight = 2; });
  try {
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => client.ask({}, questions())));
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.equal((result.reason as JevError).kind, 'http');
    }
    assert.ok(requests <= 2, `at most the two already in flight were sent, got ${requests}`);
  } finally { await stub.close(); }
});

test('local_timeout_ms replaces the TypeSafe-sized per-request limit', async () => {
  const stub = await service(() => {}, c => { c.api.timeoutMs = 60_000; c.api.retryBudgetMs = 60_000; c.api.localTimeoutMs = 1000; });
  try {
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
    const started = performance.now();
    const [result] = await Promise.allSettled([client.ask({}, questions())]);
    assert.equal(result!.status, 'rejected');
    if (result!.status === 'rejected') assert.equal((result!.reason as JevError).kind, 'timeout');
    assert.ok(performance.now() - started < 5000);
  } finally { await stub.close(); }
});

const localConfig = (fallback: 'typesafe' | 'none') => testConfig(c => {
  c.compaction.maxAfterShare = 0.5;
  c.api.backend = 'local'; c.api.localModel = 'openjev';
  c.api.localEndpoint = 'http://127.0.0.1:18390/v1/systemone-local'; c.api.fallback = fallback;
});
const rows = async (config: JevConfig) => {
  await flushTelemetry();
  const path = join(dirname(config.telemetry.path), 'compactions.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
};
/** Local asks fail with `kind`; hosted asks answer. Records which backend each asker was built for. */
const splitDeps = (config: JevConfig, kind: string, hostedKind?: string) => {
  const built: string[] = [];
  const deps = testDeps({
    config,
    makeAsker: c => {
      built.push(c.api.backend ?? 'typesafe');
      if (c.api.backend === 'local') return { ask: async () => { throw new JevError(kind as never, 'local x', kind === 'http' ? 503 : undefined); } };
      if (hostedKind) return { ask: async () => { throw new JevError(hostedKind as never, 'hosted x'); } };
      return new FakeAsker(allOnes);
    },
  });
  return { deps, built };
};

test('a local service failure retries the same compaction once on TypeSafe and records it', async () => {
  for (const kind of ['network', 'timeout', 'http']) {
    const config = localConfig('typesafe');
    const { deps, built } = splitDeps(config, kind);
    const notes: string[] = [];
    const result = await handleCompact(piEvent(), piCtx(notes), deps);
    assert.ok(result && 'compaction' in result, `${kind}: expected a compaction, got ${JSON.stringify(result)}`);
    assert.deepEqual(built, ['local', 'typesafe'], kind);
    const jev = (result.compaction.details as any).jev;
    assert.equal(jev.fallback_from, 'local');
    assert.equal(jev.model, config.api.model, 'details name the model that answered');
    const lines = await rows(config);
    assert.deepEqual(lines.map(l => l.resolution), ['hosted_retry', 'jev'], kind);
    assert.equal(lines[0].backend, 'local'); assert.equal(lines[0].reason, kind);
    assert.equal(lines[1].backend, 'typesafe'); assert.equal(lines[1].fallback_from, 'local');
    assert.ok(notes.some(n => /↻ Jev \[Local\] failed .*→ TypeSafe hosted/.test(n)), kind);
  }
});

test('no hosted retry for a bad answer, without the fallback key, or a second time', async () => {
  const parse = splitDeps(localConfig('typesafe'), 'parse');
  assert.deepEqual(await handleCompact(piEvent(), piCtx(), parse.deps), { cancel: true });
  assert.deepEqual(parse.built, ['local'], 'a bad answer is not a service failure');

  const off = splitDeps(localConfig('none'), 'network');
  assert.deepEqual(await handleCompact(piEvent(), piCtx(), off.deps), { cancel: true });
  assert.deepEqual(off.built, ['local'], 'fallback = none keeps the explicit failure path');

  const both = splitDeps(localConfig('typesafe'), 'network', 'network');
  assert.deepEqual(await handleCompact(piEvent(), piCtx(), both.deps), { cancel: true });
  assert.deepEqual(both.built, ['local', 'typesafe'], 'one hosted retry, then the normal failure path');
  assert.deepEqual((await rows(both.deps.config)).map(l => l.resolution), ['hosted_retry', 'cancelled']);
});

test('isLocalServiceFailure only matches a local backend with the fallback configured', () => {
  const base = { reason: 'network', backend: 'local' as const, fallback: 'typesafe' as const };
  assert.equal(isLocalServiceFailure(base), true);
  assert.equal(isLocalServiceFailure({ ...base, backend: 'typesafe' }), false);
  assert.equal(isLocalServiceFailure({ ...base, fallback: 'none' }), false);
  assert.equal(isLocalServiceFailure({ ...base, reason: 'parse' }), false);
  assert.equal(isLocalServiceFailure({ ...base, reason: null }), false);
});

test('a long local timeout still sends a work deadline the service accepts', async () => {
  let header = '';
  const server = createServer((req, res) => { header = String(req.headers['x-request-timeout-ms']); req.resume(); req.on('end', () => res.end(answer)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = testConfig(c => {
      c.api.backend = 'local'; c.api.localModel = 'openjev'; c.api.localTimeoutMs = 600_000;
      c.api.localEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone-local`;
    });
    const client = new LocalDecisionClient({ config, configHash: 'test', caller: 'test' });
    assert.equal((await client.ask({}, questions())).model, 'openjev');
    assert.ok(Number(header) > 0 && Number(header) <= SERVICE_DEADLINE_CAP_MS, header);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('the committed backend file selects the live local service with the TypeSafe fallback', () => {
  const live = loadConfig(defaultConfigPath());
  assert.ok(live.ok, JSON.stringify(live));
  if (!existsSync(backendPath(defaultConfigPath()))) return; // a checkout without the live switch
  assert.equal(live.config.api.backend, 'local');
  // The unqualified H2O proposal has a separate filename and must not change the default route.
  assert.equal(live.config.api.localEndpoint, 'http://127.0.0.1:18390/v1/systemone-local');
  assert.equal(live.config.api.localModel, 'openjev');
  assert.equal(live.config.api.fallback, 'typesafe');
  assert.ok((live.config.api.localTimeoutMs ?? 0) >= 300_000, 'a real compaction takes minutes');
  assert.equal(testConfig().api.backend, 'typesafe', 'tests still start from TypeSafe');
});

test('with several in flight, requests reach the service in FIFO order', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      const id = Object.keys(JSON.parse(body).questions)[0]!; seen.push(id);
      // Staggered: only one slot frees at a time, so each admitted request reaches the server before the next slot frees.
      setTimeout(() => res.end(JSON.stringify({ model: 'openjev', answers: { [id]: { type: 'noul', noul: 0.7 } } })), 40 * seen.length);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = testConfig(c => {
      c.api.backend = 'local'; c.api.localModel = 'openjev'; c.api.localMaxInflight = 3; c.api.timeoutMs = 5000; c.api.retryBudgetMs = 5000;
      c.api.localEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone-local`;
    });
    const client = new LocalDecisionClient({ config, configHash: 'test', caller: 'test' });
    const ids = Array.from({ length: 10 }, (_, i) => `q${String(i).padStart(2, '0')}`);
    await Promise.all(ids.map(id => client.ask({}, { [id]: { type: 'noul' as const, instructions: 'x' } })));
    // The first three race each other; everything after them is admitted strictly in order.
    assert.deepEqual([...seen.slice(0, 3)].sort(), ids.slice(0, 3));
    assert.deepEqual(seen.slice(3), ids.slice(3));
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('slots come back after timeouts with several in flight', async () => {
  let n = 0;
  const stub = await service(res => { n++; if (n > 2) res.end(answer); /* the first two hang */ }, c => { c.api.localMaxInflight = 2; c.api.localTimeoutMs = 1000; });
  try {
    const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => client.ask({}, questions())));
    for (const result of results) assert.equal(result.status, 'rejected');
    assert.equal(n, 2, 'only the two in flight were sent before the burst failed');
    assert.equal((await client.ask({}, questions())).model, 'openjev', 'a fresh burst gets a slot');
  } finally { await stub.close(); }
});

test('a pinned revision refuses any other revision as a service failure (the TypeSafe fallback applies)', async () => {
  const pinned = '0b6bb6e571bc7bcd6f1eb68de706f592f29c6483';
  for (const [served, ok] of [[pinned, true], ['4ec320f267401e67c9be04d5df1be4d2b6b64f10', false], [undefined, false]] as const) {
    const body = JSON.stringify({ model: 'openjev', revision: served, answers: { keep: { type: 'noul', noul: 0.7 } } });
    const stub = await service(res => res.end(body), c => { c.api.localRevision = pinned; });
    try {
      const client = new LocalDecisionClient({ config: stub.config, configHash: 'test', caller: 'test' });
      const [result] = await Promise.allSettled([client.ask({}, questions())]);
      assert.equal(result!.status, ok ? 'fulfilled' : 'rejected', String(served));
      if (!ok && result!.status === 'rejected') assert.equal((result!.reason as JevError).kind, 'http');
    } finally { await stub.close(); }
  }
  const at = (fields: string) => validateConfig(parse(committed.replace('[api]', '[api]\n' + fields)));
  assert.ok(at(LOCAL + `local_revision = "${pinned}"`).config);
  assert.equal(at(LOCAL + 'local_revision = "0b6bb6e5"').config, undefined, 'a full 40-hex revision only');
});

test('the footer says TypeSafe is being tried while the hosted retry runs', async () => {
  const status = new Map<string, string | undefined>();
  let during: string | undefined;
  const config = localConfig('typesafe');
  const deps = testDeps({
    config,
    makeAsker: c => (c.api.backend === 'local'
      ? { ask: async () => { throw new JevError('network', 'down'); } }
      : { ask: async (s, q, call) => { during ??= status.get('jev-compaction'); return new FakeAsker(allOnes).ask(s, q, call); } }),
  });
  const result = await handleCompact(piEvent(), piCtx([], 1_048_576, status), deps);
  assert.ok(result && 'compaction' in result);
  assert.match(during ?? '', /→ TypeSafe hosted/);
  assert.match(status.get('jev-compaction') ?? '', /^✓ Jev \[TypeSafe hosted\] · activity unknown/);
});

/** Authored five-level staleness answer. Not a production score. */
const STALE = { type: 'score', score: 4, confidence: 1, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } };
function fixedAnswers(body: string): Record<string, unknown> {
  const req = JSON.parse(body) as { model: string; questions: Record<string, { type: string; criteria?: Record<string, unknown> | unknown[] }> };
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: 1 };
    else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length !== 5) throw new Error(`unexpected score shape for ${id}`);
      answers[id] = STALE;
    } else if (question.type === 'choice' && question.criteria && !Array.isArray(question.criteria)) {
      const labels = Object.keys(question.criteria);
      if (labels.length < 2) throw new Error(`unexpected choice shape for ${id}`);
      const choice = labels.includes('none') ? 'none' : labels[0]!;
      answers[id] = { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? 1 : 0])) };
    } else throw new Error(`unexpected question ${id}`);
  }
  return { model: req.model, answers };
}
const KEPT = 'Keep the relay bound to loopback after a local outage.';
const READ = 'loopback bind confirmed';
const WIRE_T0 = '1970-01-01T00:00:00.000Z';
function wireEvent() {
  // The trailing text keeps the read off the boundary pin, so the pass has to ask the service.
  const span = [
    piUser(KEPT),
    ...piCall('note', 'read', { path: 'relay.txt' }, READ),
    { role: 'assistant', content: [{ type: 'text', text: 'The relay note is the fact to keep.' }], timestamp: 0 },
  ];
  const branch = span.map((message, i) => ({ type: 'message', id: `w${i}`, parentId: null, timestamp: WIRE_T0, message }));
  return piEvent({ branchEntries: branch, preparation: { messagesToSummarize: span, fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() } } });
}
async function wireServer(handler: (body: string) => { status: number; body: string }) {
  let hits = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    hits += 1;
    const outcome = handler(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(outcome.status, { 'content-type': 'application/json' });
    res.end(outcome.body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hits: () => hits,
    url: `http://127.0.0.1:${port}/v1/systemone-local`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); },
  };
}
function wireConfig(url: string) {
  return testConfig(c => {
    c.compaction.maxAfterShare = 0.5;
    c.compaction.charter = true;
    c.api.backend = 'local';
    c.api.localModel = 'openjev';
    c.api.localEndpoint = url;
    c.api.localRevision = 'fixture-rev-20261112';
    c.api.fallback = 'typesafe';
    c.api.maxRetries = 0;
    c.api.timeoutMs = 5000;
    c.api.retryBudgetMs = 5000;
    c.api.localTimeoutMs = 5000;
  });
}
async function withExternalMock(external: (body: string) => string, fn: (order: string[]) => Promise<void>) {
  const order: string[] = [];
  const real = globalThis.fetch;
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'wire-test-not-a-key';
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('http://127.0.0.1:')) {
      order.push('local');
      return real(input, init);
    }
    let host = 'unparsed';
    try { host = new URL(url).host; } catch { /* reported below */ }
    if (url !== JEV_ENDPOINT) throw new Error(`refusing unexpected host ${host}`);
    order.push('external');
    return new Response(external(String(init?.body ?? '')), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await fn(order);
  } finally {
    globalThis.fetch = real;
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
}

test('a down local service is followed by exactly one hosted pass over the external network', async () => {
  const local = await wireServer(() => ({ status: 503, body: '{}' }));
  const exit = process.exitCode;
  try {
    await withExternalMock(body => JSON.stringify(fixedAnswers(body)), async order => {
      const config = wireConfig(local.url);
      const notes: string[] = [];
      const status = new Map<string, string | undefined>();
      const deps = testDeps({
        config,
        now: () => 0,
        makeAsker: (c, hash, signal, context) => createCompactionAsker(c, hash, signal, context),
      });
      const result = await handleCompact(wireEvent(), piCtx(notes, 1_048_576, status, { mode: 'print', hasUI: false }), deps);
      assert.ok(result && 'compaction' in result, JSON.stringify(result));
      assert.ok(result.compaction.summary.includes(KEPT), 'the operator instruction survives the hosted pass');
      assert.ok(result.compaction.summary.includes(READ), 'the kept read survives the hosted pass');
      const jev = result.compaction.details.jev;
      assert.equal(jev.backend, 'typesafe');
      assert.equal(jev.model, config.api.model);
      assert.equal(jev.fallback_from, 'local');
      assert.equal(jev.fallback_reason, 'http');
      assert.notEqual(jev.backend, 'local');
      assert.ok(notes.some(note => note.includes('→ TypeSafe hosted')), notes.join(' | '));
      assert.match(status.get('jev-compaction') ?? '', /^✓ Jev \[TypeSafe hosted\]/);
      const lines = await rows(config);
      assert.deepEqual(lines.map(line => line.resolution), ['hosted_retry', 'jev']);
      assert.equal(lines[0].backend, 'local');
      assert.equal(lines[0].reason, 'http');
      assert.equal(lines[1].backend, 'typesafe');
      assert.equal(lines[1].fallback_from, 'local');
      await flushTelemetry();
      const calls = readFileSync(config.telemetry.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(calls.some(call => call.backend === 'local' && call.outcome === 'http'));
      assert.equal(calls.some(call => call.backend === 'local' && call.outcome === 'ok'), false);
      assert.ok(calls.some(call => call.backend === 'typesafe' && call.outcome === 'ok'));
      assert.match(order.join(','), /^local(,local)*,external(,external)*$/);
      assert.ok(local.hits() > 0);
      assert.equal(isPiCliProcess(), false);
      assert.equal(process.exitCode, exit, 'a successful fallback must not mark a non-CLI process');
    });
  } finally {
    process.exitCode = exit;
    await local.close();
  }
});

test('revision mismatch is not a successful local compaction', async () => {
  const local = await wireServer(body => ({ status: 200, body: JSON.stringify({ ...fixedAnswers(body), revision: 'other-revision' }) }));
  try {
    await withExternalMock(body => JSON.stringify(fixedAnswers(body)), async order => {
      const config = wireConfig(local.url);
      const notes: string[] = [];
      const status = new Map<string, string | undefined>();
      const deps = testDeps({
        config,
        now: () => 0,
        makeAsker: (c, hash, signal, context) => createCompactionAsker(c, hash, signal, context),
      });
      const result = await handleCompact(wireEvent(), piCtx(notes, 1_048_576, status, { mode: 'print', hasUI: false }), deps);
      assert.ok(result && 'compaction' in result, JSON.stringify(result));
      assert.ok(result.compaction.summary.includes(KEPT));
      assert.ok(result.compaction.summary.includes(READ));
      const jev = result.compaction.details.jev;
      assert.equal(jev.backend, 'typesafe', 'a wrong revision must not be recorded as the local service succeeding');
      assert.equal(jev.model, config.api.model);
      assert.equal(jev.fallback_from, 'local');
      assert.equal(jev.fallback_reason, 'http');
      assert.ok(notes.some(note => note.includes('→ TypeSafe hosted')), notes.join(' | '));
      const lines = await rows(config);
      assert.deepEqual(lines.map(line => line.resolution), ['hosted_retry', 'jev']);
      await flushTelemetry();
      const calls = readFileSync(config.telemetry.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(calls.some(call => call.backend === 'local' && call.outcome === 'ok'), false, 'the wrong revision is not an accepted local response');
      assert.ok(calls.some(call => call.backend === 'local' && call.outcome === 'http'));
      assert.match(order.join(','), /^local(,local)*,external(,external)*$/);
    });
  } finally { await local.close(); }
});

test('a malformed local answer cancels instead of falling back or succeeding', async () => {
  const local = await wireServer(body => {
    const req = JSON.parse(body) as { model: string };
    return { status: 200, body: JSON.stringify({ model: req.model, revision: 'fixture-rev-20261112', answers: { unanswered: { type: 'noul', noul: 1 } } }) };
  });
  const exit = process.exitCode;
  try {
    await withExternalMock(() => { throw new Error('hosted fallback is forbidden for a malformed answer'); }, async order => {
      const config = wireConfig(local.url);
      const notes: string[] = [];
      const status = new Map<string, string | undefined>();
      const deps = testDeps({
        config,
        now: () => 0,
        makeAsker: (c, hash, signal, context) => createCompactionAsker(c, hash, signal, context),
      });
      const result = await handleCompact(wireEvent(), piCtx(notes, 1_048_576, status, { mode: 'print', hasUI: false }), deps);
      assert.deepEqual(result, { cancel: true });
      assert.equal(order.includes('external'), false, order.join(','));
      assert.match(order.join(','), /^local(,local)*$/);
      assert.ok(notes.some(note => /failed \(parse\)/.test(note)), notes.join(' | '));
      assert.ok(notes.some(note => note.includes('Pi summary not used')), notes.join(' | '));
      assert.match(status.get('jev-compaction') ?? '', /Pi summary not used/);
      const lines = await rows(config);
      assert.deepEqual(lines.map(line => line.resolution), ['cancelled']);
      assert.equal(lines[0].backend, 'local');
      assert.equal(lines[0].reason, 'parse');
      await flushTelemetry();
      const calls = readFileSync(config.telemetry.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(calls.some(call => call.backend === 'local' && call.outcome === 'parse'));
      assert.equal(calls.some(call => call.outcome === 'ok'), false);
      assert.equal(isPiCliProcess(), false);
      assert.equal(process.exitCode, exit, 'this process is not the Pi CLI, so a cancel must not change its exit code');
    });
  } finally {
    process.exitCode = exit;
    await local.close();
  }
});
