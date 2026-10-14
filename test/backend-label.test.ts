import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backendDescriptor, endpointOrigin } from '../src/client/backend-descriptor.js';
import { JevHttpClient, JevError } from '../src/client/jev-client.js';
import { LocalDecisionClient } from '../src/client/local-client.js';
import { flushTelemetry } from '../src/client/ledger.js';
import { handleCompact, successNote } from '../src/pi/extension.js';
import { entryMarker, markerFor, markerLines, compactionBoxLines, renderMarker, renderCompactionBox } from '../src/pi/marker.js';
import { outcomeLine } from '../src/pi/presentation.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { testConfig } from './support/config.js';
import { piCtx, piEvent, testDeps } from './support/pi-event.js';
import { piInstallRoot } from './support/pi-install.js';
import { FakeAsker, allOnes } from './support/fake-asker.js';
import { stubServer } from './support/stub-server.js';

const plain = { fg: (_: string, t: string) => t, bold: (t: string) => t };
const localConfig = () => testConfig(c => Object.assign(c.api, { backend: 'local', localEndpoint: 'http://127.0.0.1:18390/v1/systemone-local', localModel: 'openjev', localRevision: '0b6bb6e571bc0123456789', fallback: 'typesafe' }));
const saved = (jev: Record<string, unknown>) => ({ id: 'c1', tokensBefore: 120000, summary: 'summary', fromHook: true, details: { jev } });
const local = { id: 'local', label: 'Local', model: 'openjev', where: 'http://127.0.0.1:18390', revision: '0b6bb6e571bc0123456789' };
const hosted = { id: 'typesafe', label: 'TypeSafe hosted', model: 'jev-1.13.0', where: 'https://api.typesafe.ai' };
const fixture = () => entryMarker(saved({ backend: 'local', backend_descriptor: local, model: 'openjev', latencyMs: 4200,
  budget: { predictedAfter: 38000, trigger: 100000, target: 40000, fixedAfter: 10000, budgetTokens: 30000 },
  stats: { kept: 42, truncated: 8, dropped: 17, pinned: 9, jevRequests: 0, jevInputTokens: 0, jevOutputTokens: 0 },
  charter_stats: { said: 4, answered: 3, retired: 2 }, config_hash: 'abc' }));
// Located from PI_PACKAGE_DIR or the `pi` on PATH; install-bound tests skip without one.
const piRoot = piInstallRoot();
async function rows(config: ReturnType<typeof testConfig>) {
  await flushTelemetry(); return readFileSync(join(dirname(config.telemetry.path), 'compactions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('client-owned descriptors contain effective models, safe origins and omitted optional keys', () => {
  const config = localConfig();
  assert.deepEqual(backendDescriptor(config), local);
  assert.deepEqual(new LocalDecisionClient({ config, caller: 'test', configHash: 'h' }).backend_descriptor, local);
  const cloud = testConfig();
  assert.deepEqual(new JevHttpClient({ config: cloud, caller: 'test', configHash: 'h' }).backend_descriptor, { ...hosted, model: cloud.api.model });
  assert.equal(endpointOrigin('https://user:secret@example.com:443/path?key=secret#hash'), 'https://example.com');
  assert.equal(endpointOrigin('http://[::1]:18390/path'), 'http://[::1]:18390');
  assert.deepEqual(JSON.parse(JSON.stringify(backendDescriptor(cloud))), backendDescriptor(cloud));
  assert.ok(!Object.hasOwn(backendDescriptor(cloud), 'revision'));
});

test('handleCompact round trips descriptors and records actual override, fallback reason and source', async () => {
  for (const fallback of [false, true]) {
    const config = localConfig();
    const notes: string[] = [];
    const deps = testDeps({ config, makeAsker: c => c.api.backend === 'local' && fallback
      ? { ask: async () => { throw new JevError('timeout', 'RAW SECRET'); } } : new FakeAsker(allOnes) });
    const result = await handleCompact(piEvent(), piCtx(notes), deps);
    assert.ok(result && 'compaction' in result);
    const jev = result.compaction.details.jev;
    assert.deepEqual(JSON.parse(JSON.stringify(result.compaction)), result.compaction, 'handleCompact must accept persistence-safe output');
    assert.equal(jev.backend, fallback ? 'typesafe' : 'local');
    assert.deepEqual(jev.backend_descriptor, fallback ? { ...hosted, model: config.api.model } : local);
    const logged = await rows(config);
    const line = logged.at(-1)!;
    assert.equal(line.backend, jev.backend);
    assert.deepEqual(line.backend_descriptor, jev.backend_descriptor);
    assert.deepEqual(deps.last?.backend_descriptor, jev.backend_descriptor);
    for (const data of [entryMarker(saved(jev)), markerFor(saved(jev), deps.last, null)]) {
      assert.deepEqual(data.backend_descriptor, jev.backend_descriptor);
      assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
      assert.equal(data.fallback_reason, fallback ? 'timeout' : undefined);
    }
    if (fallback) {
      assert.equal(jev.fallback_from, 'local'); assert.equal(jev.fallback_reason, 'timeout');
      assert.deepEqual(jev.fallback_descriptor, local);
      assert.equal(logged[0].backend, 'local');
      assert.match(notes.join('\n'), /↻ Jev \[Local\] failed \(timeout\) → TypeSafe hosted/);
      assert.match(notes.at(-1)!, /✓ Jev \[TypeSafe hosted\] · activity unknown/);
    } else {
      assert.ok(!Object.hasOwn(jev, 'fallback_reason')); assert.ok(!Object.hasOwn(jev, 'fallback_from'));
    }
  }
});

test('hosted calls explicitly record backend typesafe', async () => {
  const stub = await stubServer(() => ({ status: 200, body: JSON.stringify({ answers: { a: { noul: 1 } } }) }));
  const config = testConfig();
  try {
    await new JevHttpClient({ config, caller: 'test', configHash: 'h', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } }).ask({}, { a: { type: 'noul', instructions: 'keep' } });
    await flushTelemetry();
    assert.equal(JSON.parse(readFileSync(config.telemetry.path, 'utf8').trim()).backend, 'typesafe');
  } finally { await stub.close(); }
});

test('failure dedup is backend ID plus reason, not label or reason alone', async () => {
  let config = localConfig(); config.api.fallback = 'none';
  const notes: string[] = [];
  const deps = testDeps({ loadConfig: () => ({ ok: true, config, hash: 'h' }), makeAsker: () => ({ ask: async () => { throw new JevError('network', 'SECRET\n\x1b[31m'); } }) });
  for (let i = 0; i < 2; i++) await handleCompact(piEvent(), piCtx(notes), deps);
  config = testConfig();
  for (let i = 0; i < 2; i++) await handleCompact(piEvent(), piCtx(notes), deps);
  const failures = notes.filter(n => n.startsWith('×'));
  assert.equal(failures.length, 2);
  assert.match(failures[0], /^× Jev \[Local\] failed \(network\)/);
  assert.match(failures[1], /^× Jev \[TypeSafe hosted\] failed \(network\)/);
  assert.ok(!notes.join('').includes('SECRET'));
});

test('three-row route cards fit both actual extension renderers at 60 and 100 columns', () => {
  const data = { ...fixture(), measuredAfter: 44000 };
  const narrow = ['✓ Jev [Local] · activity unknown · openjev', 'At 127.0.0.1:18390', 'Context 120k → 44k measured · 4.2s attempt'];
  const wide = [narrow[0], 'At 127.0.0.1:18390 · pinned 0b6bb6e571bc', narrow[2] + ' · 42 kept / 8 cut / 17 dropped'];
  for (const width of [60, 100]) {
    assert.deepEqual(renderCompactionBox(data, { expanded: false }, plain).render(width), width === 60 ? narrow : wide);
    assert.deepEqual(renderMarker({ data }, { expanded: false }, plain).render(width), (width === 60 ? narrow : wide).map(l => ' ' + l));
    assert.deepEqual(compactionBoxLines(data, false, width), markerLines(data, false, width));
    for (const expanded of [false, true]) for (const render of [renderCompactionBox(data, { expanded }, plain), renderMarker({ data }, { expanded }, plain)]) {
      const lines = render.render(width); if (!expanded) assert.equal(lines.length, 3);
      assert.ok(lines.every(l => visibleWidth(l) <= width));
    }
  }
  const expanded = markerLines(data, true);
  assert.deepEqual(expanded.slice(0, 3), narrow);
  assert.ok(expanded.includes('Route local · http://127.0.0.1:18390 · pinned revision 0b6bb6e571bc0123456789'));
  assert.ok(expanded.includes('Context: next-response provider input 44k; prediction ~38k; includes system + tools'));
  assert.ok(expanded.includes('Pruning: 0 requests · 0 tokens in · 0 tokens out'));
  assert.ok(expanded.includes('Attempt: 4.2s · successful pass only'));
  assert.ok(expanded.includes('Charter sources: 4 said · 3 answered · 2 retired IDs'));
  assert.ok(expanded.length <= 13);
});

test('historical, fallback, future, native and other provenance never infer backend identity', () => {
  const legacy = entryMarker(saved({ model: 'openjev', latencyMs: 4200 }));
  assert.deepEqual(markerLines(legacy, false), ['✓ Jev [backend not recorded] · activity unknown · openjev', 'Destination not recorded', 'Context 120k → unknown · 4.2s attempt']);
  const fallback = { ...fixture(), backend_descriptor: hosted, fallback_from: 'local', fallback_reason: 'timeout', fallback_descriptor: local };
  assert.equal(markerLines(fallback, false)[1], '! Fallback from Local (timeout) · api.typesafe.ai');
  assert.ok(markerLines(fallback, true).includes('Attempt: 4.2s · successful pass only; excludes failed Local attempt'));
  assert.equal(markerLines({ ...fallback, fallback_descriptor: undefined, fallback_reason: undefined }, false)[1], '! Fallback from local (reason not recorded) · api.typesafe.ai');
  const future = { ...fixture(), backend_descriptor: { id: 'edge', label: 'Edge West', model: 'edge-2', where: 'https://edge-west.example:8443' } };
  assert.deepEqual(markerLines(future, false).slice(0, 2), ['✓ Jev [Edge West] · activity unknown · edge-2', 'At edge-west.example:8443']);
  for (const [resolution, reason, row1, row2] of [
    ['native', 'network', '! Pi [built-in summary] · selected fallback', 'Jev [Local] failed (network)'],
    ['disabled', 'disabled', 'Pi [built-in summary]', 'Jev disabled'],
    [undefined, 'timeout', 'Pi [built-in summary]', 'Jev [Local] did not produce it (timeout)'],
  ]) {
    const data = markerFor({ id: 'pi', tokensBefore: 120000 }, { engine: 'fallback', reason, resolution, backend_descriptor: local, tokensBefore: 120000, tokensAfter: null, latencyMs: 10 }, null);
    assert.deepEqual(markerLines(data, false).slice(0, 2), [row1, row2]);
    assert.ok(!markerLines(data, true).join('\n').includes('Pruning:'));
  }
  assert.equal(markerLines(entryMarker({ tokensBefore: 120000 }), false)[1], 'Jev outcome not recorded');
  assert.deepEqual(markerLines(markerFor({ fromHook: true }, undefined, null), false).slice(0, 2), ['Compaction [other extension]', 'Jev did not produce this compaction']);
});

test('context precedence, trigger warning and terminal-cell fitting are truthful', () => {
  const base = fixture();
  for (const [patch, expected] of [
    [{ measuredAfter: 44000 }, 'Context 120k → 44k measured'],
    [{}, 'Context 120k → ~38k predicted'],
    [{ predictedAfter: null, contextAfter: 900 }, 'Messages after ~900 estimated'],
    [{ predictedAfter: null }, 'Context 120k → unknown'],
    [{ predictedAfter: null, tokensBefore: null }, 'Context after unknown'],
    [{ measuredAfter: 44000, tokensBefore: null }, 'Context after 44k measured'],
  ] as const) assert.ok(markerLines({ ...base, ...patch, latencyMs: null }, false)[2].startsWith(expected));
  assert.equal(markerLines({ ...base, measuredAfter: 110000 }, true)[3], '! Context measured exceeds trigger 100k');
  const hostile = { ...base, backend_descriptor: { id: 'edge', label: '\x1b[31m界\n'.repeat(100), model: 'm'.repeat(100), where: 'https://edge.example' } };
  for (const width of [1, 2, 10, 60, 100]) {
    const lines = renderMarker({ data: hostile }, { expanded: false }, plain).render(width);
    assert.equal(lines.length, 3); assert.ok(lines.every(l => visibleWidth(l) <= width));
    assert.ok(lines.every(l => !/[\n\x1b]/.test(l)));
  }
});

test('every one-line outcome fits 60 and 100 cells and preserves actions before detail', () => {
  const route = { backend_descriptor: hosted, fallback_descriptor: local, fallback_from: 'local', fallback_reason: 'timeout', reason: 'timeout' };
  for (const state of ['success', 'hosted_success', 'failure', 'chooser', 'retry', 'hosted_retry', 'native', 'cancel', 'abort', 'headless', 'rpc', 'last_resort']) {
    for (const width of [60, 100]) {
      const line = outcomeLine(state, route, width, 'SECRET\n\x1b[31m');
      assert.ok(visibleWidth(line) <= width); assert.ok(!/[\n\x1b]/.test(line));
      assert.match(line, /Jev \[/);
      if (['cancel', 'abort', 'headless', 'rpc'].includes(state)) assert.match(line, /cancelled.*Pi (summary )?not used/);
      if (state === 'last_resort') assert.match(line, /cancelled; Pi (summary )?not used/);
    }
  }
  assert.equal(successNote({ backend_descriptor: hosted, tokens_before: 120000, predicted_after: 38000 }, 0, 4200), '✓ Jev [TypeSafe hosted] · activity unknown');
});

test('failure chooser, cancellation, native, retry, pre-config, RPC and abort use the recorded backend', async () => {
  for (const choice of ['Cancel compaction', "Use Pi's summary", 'Retry Jev', undefined]) {
    const notes: string[] = [], status = new Map<string, string | undefined>(), titles: string[] = [];
    let asks = 0;
    const deps = testDeps({ makeAsker: () => ++asks === 1 ? { ask: async () => { throw new JevError('network', 'SECRET'); } } : new FakeAsker(allOnes) });
    const ctx = piCtx(notes, 1048576, status, { hasUI: true, select: async title => { titles.push(title); return choice; } });
    await handleCompact(piEvent(), ctx, deps);
    assert.equal(titles[0], '× Jev [TypeSafe hosted] failed (network) · choose');
    assert.ok(!notes.join('').includes('SECRET'));
    assert.match(status.get('jev-compaction')!, choice === 'Retry Jev' ? /^✓ Jev \[TypeSafe hosted\]/ : choice === "Use Pi's summary" ? /Pi summary selected/ : /cancelled.*Pi (summary )?not used/);
  }
  const notes: string[] = [];
  await handleCompact(piEvent(), piCtx(notes), testDeps({ loadConfig: () => ({ ok: false, errors: ['SECRET'] }) }));
  assert.equal(notes[0], '× Jev [backend not recorded] failed (config)');
  const rpc: string[] = [];
  await handleCompact(piEvent(), piCtx(rpc, 1048576, new Map(), { mode: 'rpc', hasUI: true }), testDeps({ makeAsker: () => ({ ask: async () => { throw new JevError('timeout', 'SECRET'); } }) }));
  assert.match(rpc.at(-1)!, /cancelled; Pi not used/);
  const controller = new AbortController(); controller.abort();
  const statuses = new Map<string, string | undefined>();
  await handleCompact(piEvent({ signal: controller.signal }), piCtx([], 1048576, statuses), testDeps());
  assert.equal(statuses.get('jev-compaction'), '! Jev [backend not recor…] cancelled; Pi not used');
});

test('notify, status, failure and chooser messages handed to the UI fit supplied content widths', async () => {
  for (const width of [60, 100]) for (const kind of ['success', 'cancel', 'rpc', 'retry', 'native', 'abort']) {
    const notes: string[] = [], statuses: string[] = [], titles: string[] = [];
    let attempts = 0;
    const deps = testDeps({ makeAsker: () => ++attempts > 1 || kind === 'success' ? new FakeAsker(allOnes) : { ask: async () => { throw new JevError('network', 'RAW\nSECRET'); } } });
    const controller = new AbortController(); if (kind === 'abort') controller.abort();
    const ctx = piCtx(notes, 1048576, new Map(), { hasUI: true, mode: kind === 'rpc' ? 'rpc' : 'tui', select: async title => { titles.push(title); return kind === 'retry' ? 'Retry Jev' : kind === 'native' ? "Use Pi's summary" : 'Cancel compaction'; } });
    ctx.messageWidth = width;
    ctx.ui!.setStatus = (_key, text) => { if (text) statuses.push(text); };
    await handleCompact(piEvent({ signal: controller.signal }), ctx, deps);
    for (const line of [...notes, ...statuses, ...titles]) {
      assert.ok(visibleWidth(line) <= width, `${kind} ${width}: ${line}`);
      assert.ok(!/[\x1b\n]/.test(line));
      assert.ok(!line.includes('SECRET'));
    }
    if (kind === 'success') assert.equal(notes[0], statuses[0]);
  }
});

test('last resort preserves known actual backend or uses unknown before config', async () => {
  for (const known of [false, true]) {
    const notes: string[] = [];
    const deps = testDeps({ loadConfig: () => known ? { ok: true, config: localConfig(), hash: 'h' } : { ok: false, errors: ['invalid'] } });
    Object.defineProperty(deps, 'notified', { get() { throw new Error('error handler failed'); } });
    if (known) deps.makeAsker = () => ({ ask: async () => { throw new JevError('parse', 'SECRET'); } });
    assert.deepEqual(await handleCompact(piEvent(), piCtx(notes), deps), { cancel: true });
    assert.equal(notes.at(-1), known ? '× Jev [Local] · cancelled; Pi summary not used' : '× Jev [backend not recor…] cancelled; Pi not used');
  }
});

test('failed hosted override is attributed to TypeSafe on every failure surface', async () => {
  const notes: string[] = [], titles: string[] = [];
  const deps = testDeps({ config: localConfig(), makeAsker: c => ({ ask: async () => { throw new JevError(c.api.backend === 'local' ? 'network' : 'auth', 'SECRET'); } }) });
  await handleCompact(piEvent(), piCtx(notes, 1048576, new Map(), { hasUI: true, select: async title => { titles.push(title); return 'Cancel compaction'; } }), deps);
  assert.match(notes[1], /^× Jev \[TypeSafe hosted\] failed \(auth\)/);
  assert.match(titles[0], /^× Jev \[TypeSafe hosted\] failed \(auth\)/);
  assert.match(notes.at(-1)!, /^! Jev \[TypeSafe hosted\] cancelled/);
  assert.equal((await rows(deps.config)).at(-1).backend, 'typesafe');
});

test('all recorded failure kinds have safe backend-labelled notices', async () => {
  for (const reason of ['auth', 'timeout', 'network', 'http', 'parse', 'error']) {
    const notes: string[] = [];
    const deps = testDeps({ makeAsker: () => ({ ask: async () => { throw reason === 'error' ? new Error('RAW SECRET') : new JevError(reason as never, 'RAW SECRET'); } }) });
    await handleCompact(piEvent(), piCtx(notes), deps);
    assert.match(notes[0], new RegExp(`^× Jev \\[TypeSafe hosted\\] failed \\(${reason}\\)`));
    assert.ok(!notes.join('').includes('RAW SECRET'));
  }
});

test('all-state samples are literal real-renderer output and regenerate byte-identically', async () => {
  const { backendLabelSamples } = await import('../scripts/backend-label-samples.mts');
  const { sampleCards } = await import('./support/backend-label-fixtures.js');
  assert.equal(readFileSync(new URL('../docs/backend-label-samples.txt', import.meta.url), 'utf8'), backendLabelSamples());
  assert.ok(!backendLabelSamples().includes('\x1b'));
  for (const data of Object.values(sampleCards())) for (const width of [60, 100]) {
    for (const renderer of [renderCompactionBox(data, { expanded: false }, plain), renderMarker({ data }, { expanded: false }, plain)]) {
      const lines = renderer.render(width); assert.equal(lines.length, 3); assert.ok(lines.every(l => visibleWidth(l) <= width));
    }
    assert.ok(markerLines(data, true).length <= 16);
  }
});

test('installed host probe reproduces complete-box blocker, not compliant replacement output', { skip: !piRoot }, async () => {
  const root = piRoot!;
  const { CompactionSummaryMessageComponent } = await import(`${root}/dist/modes/interactive/components/compaction-summary-message.js`);
  const { initTheme } = await import(`${root}/dist/modes/interactive/theme/theme.js`);
  initTheme('dark');
  const { sampleCards } = await import('./support/backend-label-fixtures.js');
  const data = sampleCards()['Local measured (zero pruning requests)'];
  for (const width of [60, 100]) {
    const box = new CompactionSummaryMessageComponent({ role: 'compactionSummary', summary: 'saved summary body', tokensBefore: 120000, timestamp: 0 }, undefined,
      (expanded: boolean) => [renderCompactionBox(data, { expanded }, plain)]);
    const lines = box.render(width);
    assert.equal(lines.length, 8, 'installed additive host has eight rows, NOT the required three');
    assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
    box.setExpanded(true);
    assert.ok(box.render(width).some((line: string) => line.includes('saved summary body')));
  }
});

test('installed notification/title production defaults render one content row', { skip: !piRoot }, async () => {
  const root = piRoot!;
  const { InteractiveMode } = await import(`${root}/dist/modes/interactive/interactive-mode.js`);
  const { ExtensionSelectorComponent } = await import(`${root}/dist/modes/interactive/components/extension-selector.js`);
  const { FooterComponent } = await import(`${root}/dist/modes/interactive/components/footer.js`);
  const { initTheme } = await import(`${root}/dist/modes/interactive/theme/theme.js`);
  const { sampleOutcomes } = await import('./support/backend-label-fixtures.js');
  initTheme('dark');
  for (const width of [60, 100]) {
    const successes = sampleOutcomes().find(f => f.state === 'success' && f.route.backend === 'typesafe')!;
    for (const state of ['success', 'failure', 'cancel']) {
      const raw = outcomeLine(state, successes.route);
      const draw = (message: string) => {
        const mode = Object.create(InteractiveMode.prototype);
        mode.outputPad = 1;
        mode.chatContainer = { children: [], addChild(child: unknown) { this.children.push(child); } };
        mode.ui = { requestRender() {} };
        mode.showExtensionNotify(message, state === 'success' ? 'info' : 'error');
        return mode.chatContainer.children.at(-1).render(width);
      };
      assert.equal(draw(raw).length, 1, 'production default needs no supplied width');
      // Error: prefix (7 cells) + two padding cells; info has two padding cells only.
      const fitted = outcomeLine(state, successes.route, width - (state === 'success' ? 2 : 9));
      assert.equal(draw(fitted).length, 1, 'fitted candidate with known host content width');
    }
    const chooser = new ExtensionSelectorComponent(outcomeLine('chooser', successes.route), ['Retry Jev', "Use Pi's summary", 'Cancel compaction'], () => {}, () => {});
    assert.equal(chooser.titleText.render(width).length, 1);
    const fittedChooser = new ExtensionSelectorComponent(outcomeLine('chooser', successes.route, width - 2), ['Retry Jev', "Use Pi's summary", 'Cancel compaction'], () => {}, () => {});
    assert.equal(fittedChooser.titleText.render(width).length, 1);
    const session = { state: {}, getContextUsage: () => null, sessionManager: {
      getEntryCount: () => 0, getSessionId: () => 's', getLeafId: () => null,
      getEntries: () => [], getCwd: () => '/tmp', getSessionName: () => undefined,
    } };
    const status = outcomeLine('cancel', successes.route, width);
    const footer = new FooterComponent(session, { getGitBranch: () => undefined, getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map([['jev-compaction', status]]) });
    const footerLines = footer.render(width);
    assert.equal(footerLines.length, 3);
    assert.ok(visibleWidth(footerLines[2]) <= width);
    assert.match(footerLines[2], /cancelled.*Pi (summary )?not used/);
  }
});

test('custom markers persist descriptor/source provenance and explicit native association', async () => {
  const { register } = await import('../src/pi/extension.js');
  for (const native of [false, true]) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const entries: Array<[string, unknown]> = [];
    const deps = testDeps({ config: localConfig(), makeAsker: c => c.api.backend === 'local' || native ? { ask: async () => { throw new JevError('network', 'SECRET'); } } : new FakeAsker(allOnes), defer: fn => fn() });
    register({ on: (name: string, handler: never) => handlers.set(name, handler), appendEntry: (kind: string, data: unknown) => entries.push([kind, data]), registerEntryRenderer() {} } as never, deps);
    const result = await handlers.get('session_before_compact')!(piEvent(), piCtx([], 1048576, new Map(), { hasUI: true, select: async () => "Use Pi's summary" })) as Awaited<ReturnType<typeof handleCompact>>;
    const entry = result && 'compaction' in result ? { id: 'c1', fromHook: true, ...result.compaction } : { id: 'pi', tokensBefore: 120000, summary: 'Pi saved summary' };
    await handlers.get('session_compact')!({ compactionEntry: entry }, {});
    const data = entries[0][1] as ReturnType<typeof entryMarker>;
    assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
    assert.equal(data.backend_descriptor?.id, 'typesafe');
    if (native) {
      assert.equal(data.resolution, 'native'); assert.match(markerLines(data, false)[0], /selected fallback/);
    } else {
      assert.equal(data.fallback_from, 'local'); assert.equal(data.fallback_reason, 'network'); assert.equal(data.fallback_descriptor?.id, 'local');
    }
  }
});

test('abort while chooser is pending retains attempted identity and says user cancelled', async () => {
  const controller = new AbortController();
  const notes: string[] = [], status = new Map<string, string | undefined>();
  const deps = testDeps({ makeAsker: () => ({ ask: async () => { throw new JevError('network', 'SECRET'); } }) });
  await handleCompact(piEvent({ signal: controller.signal }), piCtx(notes, 1048576, status, { hasUI: true, select: async () => { controller.abort(); return "Use Pi's summary"; } }), deps);
  assert.equal(notes.at(-1), '! Jev [TypeSafe hosted] cancelled; Pi not used');
  assert.equal(status.get('jev-compaction'), notes.at(-1));
});

test('narrow cancellation clips long identity before losing the cancellation outcome', () => {
  for (const state of ['cancel', 'abort', 'rpc', 'headless', 'last_resort']) for (const width of [60, 100]) {
    const line = outcomeLine(state, { backend_descriptor: { id: 'future', label: '界'.repeat(100) }, reason: 'network' }, width);
    assert.ok(visibleWidth(line) <= width); assert.match(line, /cancelled.*Pi (summary )?not used/); assert.ok(line.includes('…'));
  }
  const disabled = markerFor({ tokensBefore: 120000 }, { engine: 'fallback', reason: 'disabled', resolution: 'disabled', backend_descriptor: local, tokensBefore: 120000, tokensAfter: null, latencyMs: 0 }, null);
  assert.ok(!markerLines(disabled, true).join('').includes('Failed Jev route'));
});
