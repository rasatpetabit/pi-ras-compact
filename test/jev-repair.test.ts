import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { register, handleCompact } from '../src/pi/extension.js';
import { entryMarker, markerLines } from '../src/pi/marker.js';
import { JevHttpClient, JevError } from '../src/client/jev-client.js';
import { LocalDecisionClient } from '../src/client/local-client.js';
import { sampleCards, sampleOutcomes } from './support/backend-label-fixtures.js';
import { testConfig } from './support/config.js';
import { testDeps, piCtx, piEvent, piUser } from './support/pi-event.js';
import { stubServer } from './support/stub-server.js';
import { piInstallRoot } from './support/pi-install.js';
import { outcomeLine } from '../src/pi/presentation.js';

const plain = { fg: (_: string, text: string) => text, bold: (text: string) => text };
// Located from PI_PACKAGE_DIR or the `pi` on PATH; install-bound tests skip without one.
const piRoot = piInstallRoot();

test('repair: whitespace/control-only legacy native reason is explicitly absent', () => {
  const data = { ...entryMarker({}), reason: ' \t\n\x1b[31m\x00 ' };
  assert.equal(markerLines(data, false)[1], 'Jev [backend not recorded] did not produce it (reason not recorded)');
});

test('repair: direct client counters count fetches, not logical calls, and only validated revisions are verified', async () => {
  let hit = 0;
  const stub = await stubServer(() => ++hit === 1 ? { status: 529 } : { status: 200, body: JSON.stringify({ model: 'openjev', revision: 'rev-1', answers: { a: { type: 'noul', noul: 1 } } }) });
  try {
    const config = testConfig(c => { c.api.maxRetries = 1; c.api.retryBackoffMs = 1; });
    const hosted = new JevHttpClient({ config, caller: 'test', configHash: 'h', endpoint: stub.url, env: { TYPESAFE_API_KEY: 'test' } });
    assert.equal(hosted.requestCount, 0);
    await hosted.ask({}, { a: { type: 'noul', instructions: 'keep' } });
    assert.equal(hosted.requestCount, 2, 'one logical call, two fetches');
    const missingKey = new JevHttpClient({ config, caller: 'test', configHash: 'h', endpoint: stub.url, env: {} });
    await assert.rejects(missingKey.ask({}, { a: { type: 'noul', instructions: 'keep' } }));
    assert.equal(missingKey.requestCount, 0);
    const localConfig = testConfig(c => Object.assign(c.api, { backend: 'local', localEndpoint: stub.url.replace('/v1/systemone', '/v1/systemone-local'), localModel: 'openjev', localRevision: 'rev-1' }));
    const local = new LocalDecisionClient({ config: localConfig, caller: 'test', configHash: 'h' });
    assert.equal(local.requestCount, 0);
    assert.ok(!Object.hasOwn(local.backend_descriptor, 'verified_revision'));
    await local.ask({}, { a: { type: 'noul', instructions: 'keep' } });
    assert.equal(local.requestCount, 1);
    assert.equal(local.backend_descriptor.verified_revision, 'rev-1');
    // A reused client has prior fetches; a zero-fetch pass must not borrow them.
    const reused = testDeps({ config: localConfig, makeAsker: () => local });
    const zero = await handleCompact(piEvent({ preparation: { messagesToSummarize: [piUser('Keep this.')] } }), piCtx(), reused);
    assert.ok(zero && 'compaction' in zero);
    assert.deepEqual(zero.compaction.details.jev.backend_requests, { local: 0 });
    localConfig.api.localRevision = 'rev-2';
    const mismatch = new LocalDecisionClient({ config: localConfig, caller: 'test', configHash: 'h' });
    await assert.rejects(mismatch.ask({}, { a: { type: 'noul', instructions: 'keep' } }));
    assert.equal(mismatch.requestCount, 1);
    assert.ok(!Object.hasOwn(mismatch.backend_descriptor, 'verified_revision'));
  } finally { await stub.close(); }
});

test('repair: zero requests are explicit, accepted responses can serve; model names never imply inference', () => {
  const data = sampleCards()['Local predicted'];
  const selected = { ...data, backend_requests: { local: 0 } };
  const served = { ...data, backend_requests: { local: 2 }, backend_responses: { local: 1 }, backend_descriptor: { ...data.backend_descriptor!, verified_revision: data.backend_descriptor!.revision } };
  assert.match(markerLines(selected, false)[0], /no requests/);
  assert.ok(!markerLines(selected, true).join('\n').includes('served'));
  assert.match(markerLines(served, false)[0], /served/);
  assert.match(markerLines(selected, false, 100)[1], /pinned/);
  assert.match(markerLines(served, false, 100)[1], /verified/);
  assert.match(markerLines(entryMarker({ details: { jev: { model: 'openjev' } } }), false)[0], /backend not recorded/);
});

// Spec-faithful presentation wrapper: ordered first-success selection, exact validated
// rows, no spacer/chrome on replacement, explicit false for stock decoration, and
// host-owned keyboard/mouse expansion even when the replacement has no setExpanded.
class SpecHost {
  expanded = false;
  calls: unknown[] = [];
  constructor(readonly entry: unknown, readonly renderers: Array<(entry: unknown, options: any, theme: any) => any>, readonly stock: any) {}
  setExpanded(value: boolean) { this.expanded = value; }
  mouseExpand() { this.setExpanded(!this.expanded); }
  render(width: number): string[] {
    if (!this.expanded) for (const renderer of this.renderers) {
      const options = { expanded: false, supportsCollapsedReplacement: true, expandHint: 'ctrl+o to expand' };
      this.calls.push(options);
      try {
        const result = renderer(this.entry, options, plain);
        if (result?.kind !== 'replace-collapsed') continue;
        const rows = result.component.render(width);
        if (!Array.isArray(rows) || rows.length === 0 || rows.some(row => typeof row !== 'string' || /[\r\n]/.test(row) || visibleWidth(row) > width)) continue;
        return rows;
      } catch { /* isolate failures and try next renderer */ }
    }
    this.stock.setExpanded(this.expanded);
    return ['', ...this.stock.render(width)];
  }
}

test('repair: feature-detected replacement controls complete geometry and host owns expansion', { skip: !piRoot }, async () => {
  const root = piRoot!;
  const { CompactionSummaryMessageComponent } = await import(`${root}/dist/modes/interactive/components/compaction-summary-message.js`);
  const { initTheme } = await import(`${root}/dist/modes/interactive/theme/theme.js`); initTheme('dark');
  let renderer: any;
  register({ on() {}, registerEntryRenderer() {}, registerCompactionRenderer(value: any) { renderer = value; } } as never, testDeps());
  for (const [label, data] of Object.entries(sampleCards())) for (const width of [60, 100]) {
    const entry = data.engine === 'jev' ? { details: { jev: { backend: data.backend, backend_descriptor: data.backend_descriptor, backend_requests: data.backend_requests, backend_responses: data.backend_responses } } } : {};
    let laterCalls = 0;
    const stock = new CompactionSummaryMessageComponent({ role: 'compactionSummary', summary: 'saved summary body', tokensBefore: 120000, timestamp: 0 }, undefined,
      (expanded: boolean) => {
        const result = renderer(entry, { expanded, supportsCollapsedReplacement: false }, plain);
        assert.ok(!result?.kind, 'stock decoration must be an ordinary component');
        return result ? [result] : [];
      });
    const host = new SpecHost(entry, [() => ({ kind: 'replace-collapsed', component: { render() { throw Error('broken'); } } }), renderer, () => { laterCalls++; }], stock);
    const lines = host.render(width);
    assert.equal(lines.length, 3, `${label}: complete presentation, no leading spacer`);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.some(line => line.includes('ctrl+o to expand')));
    assert.equal(laterCalls, 0);
    assert.equal(renderer(entry, { expanded: false }, plain).render(width).length, 3, 'old host receives additive child');
    assert.ok(!renderer(entry, { expanded: false, supportsCollapsedReplacement: false }, plain)?.kind);
    host.setExpanded(true);
    assert.ok(host.render(width).some(line => line.includes('saved summary body')));
    host.mouseExpand(); assert.equal(host.render(width).length, 3);
    // A bad capability call must degrade to stock, not pretend compliant replacement.
    assert.ok(!renderer(entry, { expanded: false, supportsCollapsedReplacement: true }, plain)?.kind);
    assert.ok(!renderer(entry, { expanded: true, supportsCollapsedReplacement: true, expandHint: 'expand' }, plain)?.kind);
  }
});

test('repair: every emitted message renders one real installed-host content row at 60 without a supplied width', { skip: !piRoot }, async () => {
  const root = piRoot!;
  const { InteractiveMode } = await import(`${root}/dist/modes/interactive/interactive-mode.js`);
  const { ExtensionSelectorComponent } = await import(`${root}/dist/modes/interactive/components/extension-selector.js`);
  const { FooterComponent } = await import(`${root}/dist/modes/interactive/components/footer.js`);
  const { initTheme } = await import(`${root}/dist/modes/interactive/theme/theme.js`); initTheme('dark');
  let width = 60;
  const draw = (message: string, level: string) => {
    const mode = Object.create(InteractiveMode.prototype);
    mode.outputPad = 1; mode.chatContainer = { children: [], addChild(child: unknown) { this.children.push(child); } }; mode.ui = { requestRender() {} };
    mode.showExtensionNotify(message, level);
    return mode.chatContainer.children.at(-1).render(width);
  };
  const check = (line: string, surface: string, level = 'error') => {
    assert.ok(!/[\x1b\n\r]/.test(line));
    if (surface === 'chooser') {
      const chooser = new ExtensionSelectorComponent(line, ['Retry Jev', "Use Pi's summary", 'Cancel compaction'], () => {}, () => {});
      assert.equal(chooser.titleText.render(width).length, 1, line);
      // Real host countdown appends up to " (600s)" to baseTitle.
      chooser.titleText.setText(line + ' (600s)');
      assert.equal(chooser.titleText.render(width).length, 1, 'title plus countdown: ' + line);
    } else if (surface === 'status') {
      const session = { state: {}, getContextUsage: () => null, sessionManager: { getEntryCount: () => 0, getSessionId: () => 's', getLeafId: () => null, getEntries: () => [], getCwd: () => '/tmp', getSessionName: () => undefined } };
      const footer = new FooterComponent(session, { getGitBranch: () => undefined, getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map([['jev-compaction', line]]) });
      const row = footer.render(width)[2];
      assert.ok(visibleWidth(row) <= width); assert.ok(row.includes(line), 'status must not need host clipping');
    } else assert.equal(draw(line, level).length, 1, line);
  };
  for (width of [60, 100]) for (const { state, route, explanation } of sampleOutcomes()) {
    const line = outcomeLine(state, route, undefined, explanation);
    check(line, state === 'chooser' ? 'chooser' : 'notify');
    if (state !== 'chooser') check(line, 'notify', 'warning');
  }
  for (width of [60, 100]) for (const kind of ['success', 'cancel', 'rpc', 'retry', 'native', 'abort', 'config', 'hosted_retry', 'last_resort']) {
    const emitted: Array<[string, string, string?]> = [];
    let tries = 0;
    const config = testConfig(c => { if (kind === 'hosted_retry') Object.assign(c.api, { backend: 'local', localEndpoint: 'http://127.0.0.1:18390/v1/systemone-local', localModel: 'openjev', fallback: 'typesafe' }); });
    const deps = testDeps({ config });
    const fake = deps.makeAsker;
    deps.makeAsker = (...args) => (++tries > 1 || kind === 'success') ? fake(...args) : { ask: async () => { throw new JevError('network', 'secret'); } };
    if (kind === 'config') deps.loadConfig = () => ({ ok: false, errors: ['secret'] });
    if (kind === 'last_resort') Object.defineProperty(deps, 'notified', { get() { throw Error('handler failed'); } });
    const signal = new AbortController(); if (kind === 'abort') signal.abort();
    const ctx = piCtx([], 1048576, new Map(), { mode: kind === 'rpc' ? 'rpc' : 'tui', hasUI: true, select: async title => { emitted.push([title, 'chooser']); return kind === 'retry' ? 'Retry Jev' : kind === 'native' ? "Use Pi's summary" : 'Cancel compaction'; } });
    ctx.ui!.notify = (line, level) => { emitted.push([line, 'notify', level]); };
    ctx.ui!.setStatus = (_key, line) => { if (line) emitted.push([line, 'status']); };
    await handleCompact(piEvent({ signal: signal.signal }), ctx, deps);
    assert.ok(emitted.length > 0, kind);
    for (const [line, surface, level] of emitted) check(line, surface, level);
  }
});

test('repair: handleCompact persists per-backend fetch counts through fallback, telemetry and markers', async () => {
  const localStub = await stubServer(() => ({ status: 503 }));
  const cloudStub = await stubServer(hit => {
    const { questions } = JSON.parse(hit.body);
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      const q = question as { type: string; criteria?: string[] | Record<string, string> };
      if (q.type === 'noul') return [id, { type: 'noul', noul: 1 }];
      const labels = Array.isArray(q.criteria) ? q.criteria.map((_, i) => String(i)) : Object.keys(q.criteria!);
      const probabilities = Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 1 : 0]));
      return [id, { type: q.type, confidence: 1, probabilities,
        ...(q.type === 'score' ? { score: 0 } : { choice: labels[0] }) }];
    }));
    return { status: 200, body: JSON.stringify({ answers }) };
  });
  try {
    const config = testConfig(c => Object.assign(c.api, { backend: 'local', localEndpoint: localStub.url.replace('/v1/systemone', '/v1/systemone-local'), localModel: 'openjev', fallback: 'typesafe' }));
    const deps = testDeps({ config, makeAsker: c => c.api.backend === 'local'
      ? new LocalDecisionClient({ config: c, caller: 'test', configHash: 'h' })
      : new JevHttpClient({ config: c, caller: 'test', configHash: 'h', endpoint: cloudStub.url, env: { TYPESAFE_API_KEY: 'test' } }) });
    const result = await handleCompact(piEvent(), piCtx(), deps);
    assert.ok(result && 'compaction' in result);
    const jev = result.compaction.details.jev;
    assert.deepEqual(jev.backend_requests, { local: localStub.hits.length, typesafe: cloudStub.hits.length });
    assert.ok(jev.backend_requests!.local > 0 && jev.backend_requests!.typesafe > 0);
    assert.deepEqual(jev.backend_responses, { local: 0, typesafe: cloudStub.hits.length });
    assert.deepEqual(deps.last?.backend_responses, jev.backend_responses);
    assert.deepEqual(deps.last?.backend_requests, jev.backend_requests);
    const data = entryMarker({ ...result.compaction, fromHook: true });
    assert.deepEqual(data.backend_requests, jev.backend_requests);
    assert.match(markerLines(data, false)[0], /served/);
    assert.equal(jev.fallback_descriptor?.id, 'local');
    assert.ok(!Object.hasOwn(jev.fallback_descriptor!, 'verified_revision'));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    const { flushTelemetry } = await import('../src/client/ledger.js'); await flushTelemetry();
    const { readFileSync } = await import('node:fs'); const { dirname, join } = await import('node:path');
    const rows = readFileSync(join(dirname(config.telemetry.path), 'compactions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows[0].backend_requests, { local: localStub.hits.length });
    assert.deepEqual(rows.at(-1).backend_requests, jev.backend_requests);
    assert.deepEqual(rows.at(-1).backend_responses, jev.backend_responses);
    const zero = testDeps({ config, compact: testDeps().compact });
    zero.makeAsker = c => new LocalDecisionClient({ config: c, caller: 'test', configHash: 'h' });
    const noRequests = await handleCompact(piEvent({ preparation: { messagesToSummarize: [piUser('Keep this user request.')] } }), piCtx(), zero);
    assert.ok(noRequests && 'compaction' in noRequests);
    assert.deepEqual(noRequests.compaction.details.jev.backend_requests, { local: 0 });
    assert.match(markerLines(entryMarker({ ...noRequests.compaction, fromHook: true }), false)[0], /no requests/);
  } finally { await localStub.close(); await cloudStub.close(); }
});

test('repair: long future labels cannot hide zero-request provenance, and invalid counters imply nothing', () => {
  const data = sampleCards()['Local predicted'];
  const route = { ...data, backend: 'edge', backend_descriptor: { id: 'edge', label: '界'.repeat(100) }, backend_requests: { edge: 0 } };
  for (const width of [60, 100]) {
    assert.match(markerLines(route, false, width)[0], /no requests/);
    assert.match(outcomeLine('success', route, width), /no requests/);
  }
  const malformed = entryMarker({ details: { jev: { backend: 'local', backend_requests: { local: -1, typesafe: Infinity } } } });
  assert.ok(!markerLines(malformed, false)[0].includes('served'));
});
