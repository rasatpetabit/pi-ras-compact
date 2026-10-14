import { visibleWidth } from '@earendil-works/pi-tui';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevError } from '../src/client/jev-client.js';
import { appendJsonLine, flushTelemetry, setLedgerFs } from '../src/client/ledger.js';
import { SHUTDOWN_FLUSH_MS, register, type HookResult } from '../src/pi/extension.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MARKER_TYPE,
  MEASURED_TYPE,
  compactionBoxLines,
  entryMarker,
  markerFor,
  markerLines,
  renderCompactionBox,
  renderMarker,
  type MarkerData,
} from '../src/pi/marker.js';
import { piCtx, piEvent, testDeps } from './support/pi-event.js';

const plain = { fg: (_color: string, text: string) => text };

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A stand-in for Pi's extension API that records handlers, appended entries and renderers. */
function fakePi() {
  const handlers = new Map<string, Handler>();
  const entries: Array<[string, unknown]> = [];
  const renderers = new Map<string, unknown>();
  const compactionRenderers: unknown[] = [];
  return {
    handlers,
    entries,
    renderers,
    compactionRenderers,
    api: {
      on: (name: string, handler: Handler) => void handlers.set(name, handler),
      appendEntry: (type: string, data: unknown) => void entries.push([type, data]),
      registerEntryRenderer: (type: string, renderer: unknown) => void renderers.set(type, renderer),
      registerCompactionRenderer: (renderer: unknown) => void compactionRenderers.push(renderer),
    } as unknown as Parameters<typeof register>[0],
  };
}

/** The same fake, on a Pi without the compaction-box hook. */
function fakePiWithoutBox() {
  const pi = fakePi();
  delete (pi.api as { registerCompactionRenderer?: unknown }).registerCompactionRenderer;
  return pi;
}

/** One native Jev entry, in the shape the hook saves: budget and latency included. */
function nativeEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const stats = {
    segments: 205,
    kept: 83,
    truncated: 77,
    dropped: 60,
    pinned: 44,
    asked: 88,
    unasked: 41,
    unanswered: 32,
    demoted: 3,
    step: 2,
    generation: 1,
    jevRequests: 7,
    jevInputTokens: 271_000,
    jevOutputTokens: 3_000,
    pinnedByClass: { user: 5, error: 7, modify: 28, decision: 3, boundary: 1, instruction: 4 },
  };
  return {
    type: 'compaction',
    id: 'c-jev',
    fromHook: true,
    tokensBefore: 401_000,
    summary: 'y'.repeat(4000),
    details: {
      jev: {
        version: 1,
        model: 'jev-1.13.0',
        config_hash: 'abc',
        stats,
        budget: { predictedAfter: 180_000, trigger: 900_000, target: 250_000, fixedAfter: 20_000, budgetTokens: 90_000 },
        latencyMs: 700,
      },
    },
    ...over,
  };
}

/** The compacted-entry shape Pi saves when an extension produced it. */
function savedEntry(result: HookResult, tokensBefore: number): Record<string, unknown> {
  if (result && 'compaction' in result) return { type: 'compaction', id: 'c-jev', fromHook: true, ...result.compaction };  return { type: 'compaction', id: 'c-pi', fromHook: false, tokensBefore, summary: 'x'.repeat(4000), details: { readFiles: [] } };
}

test('a Jev compaction leaves a chat entry naming Jev, with its numbers and Pi\'s after-context estimate', async () => {
  const pi = fakePi();
  const deps = testDeps({ contextAfter: async () => 112_345 });
  register(pi.api, deps);
  assert.deepEqual([...pi.handlers.keys()], ['agent_settled', 'input', 'model_select', 'session_start', 'session_shutdown', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree', 'session_before_compact', 'session_compact', 'session_compact_failed', 'compaction_request_end', 'message_end']);
  assert.ok(pi.renderers.has(MARKER_TYPE));

  const event = piEvent();
  const result = (await pi.handlers.get('session_before_compact')!(event, piCtx())) as HookResult;
  assert.ok(result && 'compaction' in result, 'the hook compacted');
  await pi.handlers.get('session_compact')!({ compactionEntry: savedEntry(result, 0) }, {});

  assert.equal(pi.entries.length, 1);
  const [type, data] = pi.entries[0] as [string, MarkerData];
  assert.equal(type, MARKER_TYPE);
  assert.equal(data.engine, 'jev');
  assert.equal(data.compactionId, 'c-jev');
  assert.equal(data.contextAfter, 112_345);
  assert.equal(typeof data.latencyMs, 'number');
  assert.equal(data.stats?.segments, (result.compaction.details.jev as { stats: { segments: number } }).stats.segments);
  assert.equal(data.predictedAfter, result.compaction.estimatedTokensAfter, 'the saved prediction is the headline figure');
  assert.match(markerLines(data, false)[0], /^✓ Jev \[TypeSafe hosted\] · activity unknown · jev-/);
  assert.equal(markerLines(data, false)[1], 'At api.typesafe.ai');
  assert.match(markerLines(data, false)[2], /Context 120k → ~.* predicted · .*s attempt/);
  assert.ok(markerLines(data, true).some(l => l.startsWith('Pruning:')));
  assert.equal(deps.last, undefined, 'the outcome is consumed by its compaction');
});

test("an operator-chosen Pi summary leaves a chat entry saying Pi summarised and why", async () => {
  const pi = fakePi();
  register(pi.api, testDeps({ makeAsker: () => ({ ask: async () => { throw new JevError('network', 'x'); } }) }));
  const event = piEvent();
  const choosing = piCtx([], 1_048_576, new Map(), { hasUI: true, select: async () => "Use Pi's summary" });
  const result = (await pi.handlers.get('session_before_compact')!(event, choosing)) as HookResult;
  assert.equal(result, undefined, "the operator chose Pi's summary, so the hook returns none");
  const tokensBefore = (event.preparation as { tokensBefore: number }).tokensBefore;
  await pi.handlers.get('session_compact')!({ compactionEntry: savedEntry(result, tokensBefore) }, {});
  const data = pi.entries[0]![1] as MarkerData;
  assert.deepEqual([data.engine, data.reason, data.contextAfter], ['pi', 'network', null]);
  assert.equal(markerLines(data, false)[0], '! Pi [built-in summary] · selected fallback');
  assert.equal(markerLines(data, false)[1], 'Jev [TypeSafe hosted] failed (network)');
});

test('a compaction the hook never saw is marked as not Jev; the marker never throws', async () => {
  const data = markerFor({ id: 'c', tokensBefore: 5, summary: 's' }, undefined, null);
  assert.equal(markerLines(data, false)[1], 'Jev outcome not recorded');
  const stale = markerFor({ id: 'c', tokensBefore: 5, summary: 's' }, { engine: 'jev', reason: null, tokensBefore: 9, tokensAfter: 3, latencyMs: 1 }, null);
  assert.equal(stale.reason, null, 'an outcome for a different compaction is not borrowed');
  assert.equal(stale.latencyMs, null, "a different compaction's latency is not borrowed");
  assert.equal(stale.predictedAfter, null, "a different compaction's prediction is not borrowed");

  const pi = fakePi();
  const deps = testDeps({ contextAfter: async () => { throw new Error('no session'); } });
  register({ ...pi.api, appendEntry: () => { throw new Error('session closed'); } } as typeof pi.api, deps);
  await assert.doesNotReject(async () => { await pi.handlers.get('session_compact')!({ compactionEntry: {} }, {}); });
});

test('an outcome with no tokensBefore is not borrowed by a later compaction', () => {
  const data = markerFor(
    { id: 'c', tokensBefore: 401_000, summary: 's'.repeat(400) },
    { engine: 'jev', reason: null, tokensBefore: null, tokensAfter: 60_000, latencyMs: 4321 },
    null,
  );
  assert.equal(data.engine, 'pi');
  assert.equal(data.reason, null, 'an outcome with no tokensBefore is a wildcard and matches nothing');
  assert.equal(data.latencyMs, null, 'no latency is borrowed');
  assert.equal(data.predictedAfter, null, 'no context-after figure of its own is borrowed');
  const lines = markerLines(data, false);
  assert.equal(lines[0], 'Pi [built-in summary]');
  assert.equal(lines[1], 'Jev outcome not recorded');
  assert.equal(lines[2], 'Context 401k → unknown');
});

test('a matching outcome is still borrowed, with its reason, latency and prediction', () => {
  const entry = { id: 'c', tokensBefore: 401_000, summary: 's'.repeat(400) };
  const fallback = markerFor(
    entry,
    { engine: 'fallback', reason: 'timeout', tokensBefore: 401_000, tokensAfter: 60_000, latencyMs: 4321 },
    null,
  );
  assert.equal(fallback.reason, 'timeout');
  assert.equal(fallback.latencyMs, 4321);
  assert.equal(fallback.predictedAfter, 60_000);
  assert.equal(markerLines(fallback, false)[1], 'Jev [backend not recorded] did not produce it (timeout)');

  const jev = markerFor(
    { ...entry, details: { jev: { model: 'm', config_hash: 'h', stats: { segments: 1 } } } },
    { engine: 'jev', reason: null, tokensBefore: 401_000, tokensAfter: 60_000, latencyMs: 4321 },
    null,
  );
  assert.equal(jev.engine, 'jev');
  assert.equal(jev.latencyMs, 4321);
  assert.equal(jev.predictedAfter, 60_000);
  assert.match(markerLines(jev, false)[2]!, /· 4\.3s attempt$/);
});

test('small numbers get one decimal place; large ones still round to whole thousands', () => {
  const small = markerFor({ id: 'c', tokensBefore: 1_500, summary: 's'.repeat(400) }, undefined, null);
  assert.equal(markerLines(small, false)[2], 'Context 1.5k → unknown');
  const large = markerFor({ id: 'c', tokensBefore: 12_345, summary: 's'.repeat(40_000) }, undefined, null);
  assert.equal(markerLines(large, false)[2], 'Context 12k → unknown');
});

test('a Jev marker shows the saved prediction, and counts what was asked, unasked and pinned', () => {
  const stats = { segments: 205, kept: 70, truncated: 74, dropped: 61, pinned: 44, asked: 88, unasked: 41, unanswered: 32, demoted: 3, step: 2, generation: 1 };
  const data = markerFor({ id: 'c1', tokensBefore: 401000, estimatedTokensAfter: 55400, summary: '', details: { jev: { model: 'm', stats } } }, undefined, 999999);
  assert.equal(data.predictedAfter, 55400);
  assert.equal(data.contextAfter, 999999);
  assert.deepEqual(markerLines(data, false), ['✓ Jev [backend not recorded] · activity unknown · m', 'Destination not recorded', 'Context 401k → ~55k predicted']);
  assert.ok(markerLines(data, true).includes('Segments: 70 kept · 74 cut · 61 dropped · 44 pinned'));
  assert.ok(!markerLines(data, true).join(' ').includes('generation'));

});

test('without a saved prediction the marker uses the hook\'s own, and Pi\'s messages-only estimate when neither exists', () => {
  const entry = {
    id: 'c1',
    tokensBefore: 401_000,
    summary: '',
    details: { jev: { model: 'm', config_hash: 'h', stats: { segments: 1, kept: 1, truncated: 0, dropped: 0, pinned: 0 } } },
  };
  const fromHook = markerFor(entry, { engine: 'jev', reason: null, tokensBefore: 401_000, tokensAfter: 60_000, latencyMs: 5 }, 111_000);
  assert.equal(fromHook.predictedAfter, 60_000);
  assert.match(markerLines(fromHook, false)[2]!, /→ ~60k predicted/);

  const older = markerFor(entry, { engine: 'jev', reason: null, tokensBefore: 401_000, latencyMs: 5 }, 111_000);
  assert.equal(older.predictedAfter, null);
  assert.match(markerLines(older, false)[2]!, /Messages after ~111k estimated/);
});

test('an entry from before the counts existed keeps the old wording', () => {
  const data = markerFor(
    { id: 'c', tokensBefore: 1, summary: '', details: { jev: { stats: { segments: 9, kept: 3, truncated: 2, dropped: 4, pinned: 1 } } } },
    undefined,
    null,
  );
  assert.equal(markerLines(data, true)[4], 'Segments: 3 kept · 2 cut · 4 dropped · 1 pinned');
});

test('a compaction another extension saved is named as such, borrowing nothing from Jev\'s last outcome', () => {
  const data = markerFor(
    { id: 'c-other', fromHook: true, tokensBefore: 401_000, summary: 'z'.repeat(4000) },
    { engine: 'jev', reason: null, tokensBefore: 401_000, tokensAfter: 60_000, latencyMs: 4321 },
    7_000,
  );
  assert.equal(data.engine, 'other');
  assert.equal(data.reason, null);
  assert.equal(data.latencyMs, null, 'no latency is borrowed from Jev');
  assert.equal(data.predictedAfter, null, "another extension's prediction is not Jev's");
  const lines = markerLines(data, false);
  assert.equal(lines[0], 'Compaction [other extension]');
  assert.equal(lines[1], 'Jev did not produce this compaction');
  assert.equal(lines[2], 'Messages after ~7.0k estimated');
  const colours: string[] = [];
  renderMarker({ data }, { expanded: false }, { fg: (c, t) => (colours.push(c), t) }).render(80);
  assert.ok(colours.includes('muted'));
});

test('a fallback marker names the reason in plain words', () => {
  const words: Record<string, string> = {
    no_room: 'the kept turns and the fixed prompt leave no room under the trigger',
    no_progress: 'the result would not have freed enough',
    uncalibrated: 'no overhead measurement yet for this model',
    estimator: "Pi's context estimator failed",
  };
  for (const [reason, plain] of Object.entries(words)) {
    const data = markerFor(
      { id: 'c', tokensBefore: 5, summary: 's' },
      { engine: 'fallback', reason, tokensBefore: 5, latencyMs: 1 },
      null,
    );
    assert.equal(markerLines(data, false)[1], `Jev [backend not recorded] did not produce it (${reason})`);
  }
});

test('the rendered marker fits the terminal width and colours only the headline by engine', () => {
  const data = entryMarker(nativeEntry());
  for (const width of [40, 80, 178]) for (const expanded of [false, true]) {
    const lines = renderMarker({ data }, { expanded }, plain).render(width);
    if (!expanded) assert.equal(lines.length, 3);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  const colours: Array<[string, string]> = [];
  renderMarker({ data }, { expanded: false }, { fg: (c, t) => (colours.push([c,t]), t) }).render(100);
  assert.deepEqual(colours.filter(([c]) => c === 'success'), [['success', '✓']]);
  assert.ok(colours.some(([c]) => c === 'accent'));

});

test('a Pi with the box hook gets a compaction renderer; the marker entry renderer draws nothing', async () => {
  const pi = fakePi();
  register(pi.api, testDeps({ defer: () => assert.fail('a boxed Pi writes the entry at once') }));
  assert.equal(pi.compactionRenderers.length, 1, 'the renderer is registered');
  assert.equal(
    (pi.renderers.get(MARKER_TYPE) as (e: unknown, o: { expanded: boolean }, t: unknown) => unknown)(
      { data: entryMarker(nativeEntry()) },
      { expanded: false },
      plain,
    ),
    undefined,
    'the entry renderer draws nothing twice',
  );
  await pi.handlers.get('session_compact')!({ compactionEntry: { id: 'c-pi', fromHook: false, tokensBefore: 5, summary: 's' } }, {});
  assert.equal(pi.entries.length, 1, 'the durable marker entry is still appended');
});

test('a native entry renders the collapsed headline and the expanded detail in the box', () => {
  const pi = fakePi(); register(pi.api, testDeps());
  const renderer = pi.compactionRenderers[0] as (e: unknown, o: { expanded: boolean }, t: typeof plain) => Rendered;
  const data = entryMarker(nativeEntry());
  assert.deepEqual(renderer(nativeEntry(), { expanded: false }, plain).render(100), [
    '✓ Jev [backend not recorded] · activity unknown · jev-1.13.0', 'Destination not recorded',
    'Context 401k → ~180k predicted · 0.7s attempt · 83 kept / 77 cut / 60 dropped',
  ]);
  const expanded = renderer(nativeEntry(), { expanded: true }, plain).render(200);
  assert.ok(expanded.includes('Pruning: 7 requests · 271k tokens in · 3.0k tokens out'));
  assert.ok(expanded.includes('Attempt: 0.7s · successful pass only'));
  assert.ok(expanded.includes('Budget: target 250k · trigger 900k · fixed 20k · summary 90k'));
  assert.ok(expanded.includes('Record: entry c-jev · config abc'));
  const colours: Array<[string, string]> = [];
  renderer(nativeEntry(), { expanded: false }, { fg: (c, t) => (colours.push([c,t]), t) }).render(100);
  assert.deepEqual(colours.filter(([c]) => c === 'success'), [['success', '✓']]);

});

test('an entry from before budget and latency existed renders without throwing', () => {
  const entry = nativeEntry();
  const jev = (entry.details as { jev: Record<string, unknown> }).jev;
  delete jev.budget; delete jev.latencyMs;
  const data = entryMarker(entry);
  assert.equal(data.latencyMs, null); assert.equal(data.budget, null);
  assert.deepEqual(compactionBoxLines(data, false), ['✓ Jev [backend not recorded] · activity unknown · jev-1.13.0', 'Destination not recorded', 'Context 401k → unknown']);
  assert.ok(!compactionBoxLines(data, true).some(l => l.startsWith('Budget:')));

});

test('a known fallback marker draws the warning headline; an unknown entry says outcome not recorded', async () => {
  const pi = fakePi();
  const deps = testDeps({ makeAsker: () => ({ ask: async () => { throw new JevError('network', 'x'); } }) });
  register(pi.api, deps);
  const renderer = pi.compactionRenderers[0] as (e: unknown, o: { expanded: boolean }, t: { fg(c: string, t: string): string }) => { render(w: number): string[] } | undefined;
  const plain = { fg: (_c: string, text: string) => text };

  assert.equal(renderer({ type: 'compaction', id: 'c-plain', summary: 's' }, { expanded: false }, plain)!.render(100)[1], 'Jev outcome not recorded');

  const event = piEvent();
  const choosing = piCtx([], 1_048_576, new Map(), { hasUI: true, select: async () => "Use Pi's summary" });
  const result = (await pi.handlers.get('session_before_compact')!(event, choosing)) as HookResult;
  const tokensBefore = (event.preparation as { tokensBefore: number }).tokensBefore;
  await pi.handlers.get('session_compact')!({ compactionEntry: savedEntry(result, tokensBefore) }, {});
  const fallback = savedEntry(result, tokensBefore);
  const lines = renderer(fallback, { expanded: false }, plain)!.render(100);
  assert.deepEqual(lines, ['! Pi [built-in summary] · selected fallback', 'Jev [TypeSafe hosted] failed (network)', 'Context 120k → unknown']);
  const colours: string[] = [];
  renderer(fallback, { expanded: false }, { fg: (c, t) => (colours.push(c), t) }).render(100);
  assert.ok(colours.includes('warning'));
  const detail = renderer(fallback, { expanded: true }, plain)!.render(100);
  assert.ok(detail.includes('Failed Jev route typesafe · https://api.typesafe.ai'));
  assert.ok(detail.includes('Context: after-context not recorded'));
  assert.ok(!detail.join(' ').includes('Pruning:'));
  // The marker entry itself is still written, as the durable record of the reason.
  assert.equal((pi.entries[0]![1] as MarkerData).engine, 'pi');
});

test('session_start fills the known-marker map from a resumed session, so its fallback draws', () => {
  const pi = fakePi();
  register(pi.api, testDeps());
  const data: MarkerData = {
    version: 1,
    compactionId: 'c-resumed',
    engine: 'pi',
    reason: 'timeout',
    tokensBefore: 5,
    summaryChars: 1,
    predictedAfter: null,
    contextAfter: null,
    latencyMs: null,
    model: null,
    configHash: null,
    stats: null,
  };
  pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, {
    sessionManager: { getEntries: () => [{ type: 'custom', customType: MARKER_TYPE, data }, { type: 'compaction', id: 'c-other' }] },
  });
  const renderer = pi.compactionRenderers[0] as (e: unknown, o: { expanded: boolean }, t: { fg(c: string, t: string): string }) => { render(w: number): string[] } | undefined;
  const plain = { fg: (_c: string, text: string) => text };
  assert.deepEqual(renderer({ type: 'compaction', id: 'c-resumed' }, { expanded: false }, plain)!.render(100), [
    'Pi [built-in summary]', 'Jev [backend not recorded] did not produce it (timeout)', 'Context 5 → unknown',
  ]);
  assert.equal(renderer({ type: 'compaction', id: 'c-other' }, { expanded: false }, plain)!.render(100)[1], 'Jev outcome not recorded');
});

test('without the box hook the entry is appended after Pi redraws, not synchronously', async () => {
  const pi = fakePiWithoutBox();
  const deferred: Array<() => void> = [];
  register(pi.api, testDeps({ defer: fn => void deferred.push(fn) }));
  assert.equal(pi.compactionRenderers.length, 0);
  assert.ok(pi.renderers.has(MARKER_TYPE), 'the entry renderer is still registered');

  const event = piEvent();
  const result = (await pi.handlers.get('session_before_compact')!(event, piCtx())) as HookResult;
  await pi.handlers.get('session_compact')!({ compactionEntry: savedEntry(result, 0) }, {});
  assert.equal(pi.entries.length, 0, 'nothing is appended during the handler');
  assert.equal(deferred.length, 1, 'the append is deferred');
  deferred[0]!();
  assert.equal(pi.entries.length, 1);
  const data = pi.entries[0]![1] as MarkerData;
  assert.equal(data.engine, 'jev');
  assert.equal(typeof data.latencyMs, 'number', 'the marker records a latency');
  assert.equal(typeof (result as { compaction: { details: { jev: { latencyMs: number } } } }).compaction.details.jev.latencyMs, 'number', 'the entry records a latency');  const rendered = (pi.renderers.get(MARKER_TYPE) as (e: unknown, o: { expanded: boolean }, t: unknown) => { render(w: number): string[] })({ data }, { expanded: false }, plain).render(100);
  assert.match(rendered[0]!, /^ ✓ Jev \[TypeSafe hosted\]/);
});

test('a native entry saves the budget and latency the box renders from', async () => {
  const pi = fakePi();
  register(pi.api, testDeps());
  const event = piEvent();
  const result = (await pi.handlers.get('session_before_compact')!(event, piCtx())) as HookResult;
  assert.ok(result && 'compaction' in result);
  const jev = result.compaction.details.jev;
  assert.deepEqual(Object.keys(jev.budget).sort(), ['budgetTokens', 'fixedAfter', 'predictedAfter', 'target', 'trigger']);
  assert.equal(jev.budget.predictedAfter, result.compaction.estimatedTokensAfter);
  assert.equal(jev.budget.trigger, 1_048_576 - 50_000);
  assert.equal(jev.budget.fixedAfter, Math.round((120_000 / 105_000) * 5_000));
  assert.equal(typeof jev.latencyMs, 'number');
  assert.equal(JSON.parse(JSON.stringify(jev)).latencyMs, jev.latencyMs, 'the entry survives JSON.stringify');
});

test('a refused append inside the deferred write never throws out of Pi', async () => {
  const pi = fakePiWithoutBox();
  const deferred: Array<() => void> = [];
  register({ ...pi.api, appendEntry: () => { throw new Error('session closed'); } } as typeof pi.api, testDeps({ defer: fn => void deferred.push(fn) }));
  const event = piEvent();
  const result = (await pi.handlers.get('session_before_compact')!(event, piCtx())) as HookResult;
  await pi.handlers.get('session_compact')!({ compactionEntry: savedEntry(result, 0) }, {});
  assert.equal(deferred.length, 1, 'the append is deferred');
  assert.doesNotThrow(() => deferred[0]!(), 'the deferred append swallows the refusal');
});

test('a second session in one process forgets the first session\'s markers', () => {
  const pi = fakePi();
  register(pi.api, testDeps());
  const renderer = pi.compactionRenderers[0] as (e: unknown, o: { expanded: boolean }, t: { fg(c: string, t: string): string }) => { render(w: number): string[] } | undefined;
  const plain = { fg: (_c: string, text: string) => text };
  const data = entryMarker(nativeEntry({ id: 'c-1' }));
  pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, {
    sessionManager: { getEntries: () => [{ type: 'custom', customType: MARKER_TYPE, data }] },
  });
  assert.equal(renderer({ type: 'compaction', id: 'c-1' }, { expanded: false }, plain)!.render(100)[0], compactionBoxLines(data, false)[0]);
  pi.handlers.get('session_start')!({ type: 'session_start', reason: 'new' }, {
    sessionManager: { getEntries: () => [] },
  });
  assert.equal(renderer({ type: 'compaction', id: 'c-1' }, { expanded: false }, plain)!.render(100)[1], 'Jev outcome not recorded', 'the previous session\'s marker is gone');
});

test('an entry without details.jev is Pi\'s summary, never Jev\'s', () => {
  const data = entryMarker({ type: 'compaction', id: 'c-plain', tokensBefore: 401_000, summary: 's'.repeat(400) });
  assert.equal(data.engine, 'pi');
  assert.equal(data.reason, null);
  assert.equal(data.stats, null);
  assert.equal(data.latencyMs, null);
  assert.equal(data.tokensBefore, 401_000);
  assert.deepEqual(compactionBoxLines(data, false), ['Pi [built-in summary]', 'Jev outcome not recorded', 'Context 401k → unknown']);
});

test('a marker with no recorded reason says so in words, never "null"', () => {
  const data = entryMarker({ id: 'c-plain', tokensBefore: 5 });
  assert.deepEqual(markerLines(data, false), ['Pi [built-in summary]', 'Jev outcome not recorded', 'Context 5 → unknown']);
  assert.deepEqual(markerLines(data, true).slice(3), ['Context: after-context not recorded', 'Record: entry c-plain']);
  assert.ok(!markerLines(data, true).join(' ').includes('null'));

});

test('no box or marker line exceeds the width it was given, however narrow', () => {
  const native = entryMarker(nativeEntry());
  const fallback: MarkerData = { ...entryMarker({ type: 'compaction', id: 'c-plain', tokensBefore: 5, summary: 's' }) };
  const theme = { fg: (_c: string, text: string) => text };
  for (const width of [1, 5, 9]) {
    for (const expanded of [false, true]) {
      for (const data of [native, fallback]) {
        for (const line of renderCompactionBox(data, { expanded }, theme).render(width)) {
          assert.ok(visibleWidth(line) <= width, `box ${width}: ${line}`);
        }
        for (const line of renderMarker({ data }, { expanded }, theme).render(width)) {
          assert.ok(visibleWidth(line) <= width, `marker ${width}: ${line}`);
        }
      }
    }
  }
});

test('session_shutdown drains pending telemetry, so an RPC or print-mode exit keeps the rows', async () => {
  // Pi's non-interactive modes end with process.exit() after awaiting session_shutdown,
  // which abandons appends still on the worker pool. The handler waits for them.
  const pi = fakePi();
  register(pi.api, testDeps());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const written: string[] = [];
  await flushTelemetry(); // earlier tests' rows land on the real filesystem, not in this fake
  setLedgerFs({
    stat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    mkdir: async () => undefined,
    appendFile: async (_path, data) => { await gate; written.push(data); },
  });
  try {
    appendJsonLine('/nowhere/compactions.jsonl', { row: 1 });
    const done = pi.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, {});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(written, [], 'the append is still pending');
    release();
    await done;
    assert.deepEqual(written, ['{"row":1,"source":"live"}\n']);
  } finally {
    setLedgerFs(undefined);
  }
});

test('session_shutdown never holds the exit on a stalled filesystem', async () => {
  const pi = fakePi();
  register(pi.api, testDeps());
  const never = new Promise<never>(() => {});
  setLedgerFs({ stat: () => never, mkdir: () => never, appendFile: () => never });
  try {
    appendJsonLine('/nowhere/compactions.jsonl', { row: 1 });
    const started = Date.now();
    await pi.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, {});
    const waited = Date.now() - started;
    assert.ok(waited >= SHUTDOWN_FLUSH_MS - 20 && waited < SHUTDOWN_FLUSH_MS + 1000, `waited ${waited} ms`);
  } finally {
    setLedgerFs(undefined);
  }
});

// ---- the measured context after: the provider's own count on the first response after -----

const MEASURED_ASSISTANT = {
  role: 'assistant',
  provider: 'meridian',
  model: 'claude-opus-5-5',
  stopReason: 'toolUse',
  usage: { input: 12, output: 400, cacheRead: 150_000, cacheWrite: 3_100, totalTokens: 153_512 },
};
type Rendered = { render(width: number): string[] };
const boxText = (pi: ReturnType<typeof fakePi>, entry: unknown, expanded = false): string =>
  ((pi.compactionRenderers[0] as (e: unknown, o: { expanded: boolean }, t: typeof plain) => Rendered)(entry, { expanded }, plain))
    .render(200)
    .join('\n');

const sessionContext = (id: string) => ({ sessionManager: { getSessionId: () => id, getEntries: () => [] } });

test('interleaved sessions measure only their own compaction and telemetry identity', async () => {
  const pi = fakePi();
  const deps = testDeps();
  let currentSession = 'A';
  const measuredEntries: Array<[string, unknown]> = [];
  register({ ...pi.api, appendEntry: (type: string, data: unknown) => {
    if (type === MEASURED_TYPE) measuredEntries.push([currentSession, data]);
  } } as typeof pi.api, deps);
  const a = sessionContext('A');
  const b = sessionContext('B');
  const path = join(dirname(deps.config.telemetry.path), 'measurements.jsonl');
  await pi.handlers.get('session_start')!({}, a);
  await pi.handlers.get('session_start')!({}, b);
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-A' }) }, a);

  currentSession = 'B';
  await pi.handlers.get('message_end')!({ message: { ...MEASURED_ASSISTANT, usage: { input: 42 } } }, b);
  await flushTelemetry();
  assert.deepEqual(measuredEntries, [], 'B must not append a measurement for A');
  assert.equal(existsSync(path), false, 'B must not log its tokens against A');

  currentSession = 'A';
  await pi.handlers.get('message_end')!({ message: MEASURED_ASSISTANT }, a);
  await flushTelemetry();
  assert.deepEqual(measuredEntries, [['A', { version: 1, compactionId: 'c-A', measuredAfter: 153_112, model: 'claude-opus-5-5' }]]);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'A');
  assert.equal(rows[0].compaction_id, 'c-A');
  assert.equal(rows[0].measured_after, 153_112);
});

test('B session_start preserves A pending measurement', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const a = sessionContext('A');
  const b = sessionContext('B');
  await pi.handlers.get('session_start')!({}, a);
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-A' }) }, a);
  await pi.handlers.get('session_start')!({}, b);
  await pi.handlers.get('message_end')!({ message: MEASURED_ASSISTANT }, a);
  await flushTelemetry();
  assert.deepEqual(pi.entries.filter(([type]) => type === MEASURED_TYPE), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-A', measuredAfter: 153_112, model: 'claude-opus-5-5' }],
  ], 'starting B must leave A pending');
  const rows = readFileSync(join(dirname(deps.config.telemetry.path), 'measurements.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'A');
  assert.equal(rows[0].compaction_id, 'c-A');
});

test('two pending sessions with the same compaction id keep separate measured counts', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const a = sessionContext('A');
  const b = sessionContext('B');
  const entryA = nativeEntry(); // distinct entries can collide across sessions
  const entryB = nativeEntry();
  const draw = (entry: unknown) => (pi.compactionRenderers[0] as (e: unknown, o: { expanded: boolean }, t: typeof plain) => Rendered)(entry, { expanded: false }, plain);
  await pi.handlers.get('session_start')!({}, a);
  await pi.handlers.get('session_compact')!({ compactionEntry: entryA }, a);
  await pi.handlers.get('session_start')!({}, b);
  await pi.handlers.get('session_compact')!({ compactionEntry: entryB }, b);
  // Both callbacks run after B's hook, not immediately after the owning compact.
  const drawnA = draw(entryA);
  const drawnB = draw(entryB);
  await pi.handlers.get('message_end')!({ message: { ...MEASURED_ASSISTANT, usage: { input: 42_000 } } }, b);
  assert.match(drawnB.render(200).join('\n'), /42k measured/);
  assert.match(drawnA.render(200).join('\n'), /~180k predicted/);
  await pi.handlers.get('message_end')!({ message: MEASURED_ASSISTANT }, a);
  assert.match(drawnA.render(200).join('\n'), /153k measured/);
  assert.match(drawnB.render(200).join('\n'), /42k measured/);
  assert.match(boxText(pi, entryB), /42k measured/, 'a newly created B box also ignores the last A hook');
  await flushTelemetry();
  const rows = readFileSync(join(dirname(deps.config.telemetry.path), 'measurements.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(row => [row.session_id, row.compaction_id, row.measured_after]), [
    ['B', 'c-jev', 42_000], ['A', 'c-jev', 153_112],
  ]);
});

test('starting and shutting down B preserves A learned marker and measured count', async () => {
  const pi = fakePi();
  register(pi.api, testDeps());
  const data = { ...entryMarker(nativeEntry()), engine: 'pi', reason: 'timeout' } as MarkerData;
  const entry = { type: 'compaction', id: 'c-jev' };
  const a = { sessionManager: {
    getSessionId: () => 'A',
    getEntries: () => [
      { type: 'custom', customType: MARKER_TYPE, data },
      { type: 'custom', customType: MEASURED_TYPE, data: { compactionId: 'c-jev', measuredAfter: 99_000 } },
    ],
  } };
  const b = sessionContext('B');
  await pi.handlers.get('session_start')!({}, a);
  await pi.handlers.get('session_start')!({}, b);
  assert.match(boxText(pi, entry), /Jev \[backend not recorded\] did not produce it \(timeout\)/, 'A draws while B is live and last handled');
  assert.match(boxText(pi, nativeEntry()), /99k measured/);
  await pi.handlers.get('session_shutdown')!({}, b);
  assert.match(boxText(pi, entry), /Jev \[backend not recorded\] did not produce it \(timeout\)/);
  assert.match(boxText(pi, nativeEntry()), /99k measured/);
});

test('without the box hook, delayed marker callbacks resolve their own session after B hooks', async () => {
  const pi = fakePiWithoutBox();
  register(pi.api, testDeps({ defer: (run: () => void) => run() }));
  const a = sessionContext('A');
  const b = sessionContext('B');
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ estimatedTokensAfter: 180_000 }) }, a);
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ estimatedTokensAfter: 180_000 }) }, b);
  const markers = pi.entries.filter(([type]) => type === MARKER_TYPE);
  const draw = (data: unknown) => (pi.renderers.get(MARKER_TYPE) as (e: unknown, o: { expanded: boolean }, t: typeof plain) => Rendered)({ data }, { expanded: false }, plain);
  const drawnA = draw(markers[0]![1]);
  const drawnB = draw(markers[1]![1]);
  await pi.handlers.get('message_end')!({ message: { ...MEASURED_ASSISTANT, usage: { input: 42_000 } } }, b);
  assert.match(drawnA.render(200).join('\n'), /predicted/);
  assert.match(drawnB.render(200).join('\n'), /42k measured/);
  await pi.handlers.get('message_end')!({ message: MEASURED_ASSISTANT }, a);
  assert.match(drawnA.render(200).join('\n'), /153k measured/);
  assert.match(draw(markers[1]![1]).render(200).join('\n'), /42k measured/);
  await flushTelemetry();
});

test('resumed colliding entries retain ownership when callbacks run after the other session starts', async () => {
  const pi = fakePi();
  register(pi.api, testDeps());
  const entryA = nativeEntry();
  const entryB = nativeEntry();
  for (const [id, entry, measuredAfter] of [['A', entryA, 99_000], ['B', entryB, 42_000]] as const) {
    await pi.handlers.get('session_start')!({}, { sessionManager: {
      getSessionId: () => id,
      getEntries: () => [entry, { type: 'custom', customType: MEASURED_TYPE, data: { compactionId: 'c-jev', measuredAfter } }],
    } });
  }
  assert.match(boxText(pi, entryA), /99k measured/);
  assert.match(boxText(pi, entryB), /42k measured/);
  assert.match(boxText(pi, nativeEntry()), /~180k predicted/, 'an ambiguous detached entry must not borrow either measurement');
  await pi.handlers.get('session_shutdown')!({}, sessionContext('B'));
  assert.match(boxText(pi, nativeEntry()), /99k measured/, 'shutdown removes only B from the id index');
  assert.match(boxText(pi, entryB), /~180k predicted/, 'the closed exact B entry must not borrow A measurement');
});

test('resumed colliding Pi summaries and fallback markers use their learned entry ownership', async () => {
  for (const pi of [fakePi(), fakePiWithoutBox()]) {
    register(pi.api, testDeps());
    const entryA = { type: 'compaction', id: 'c-jev' };
    const entryB = { type: 'compaction', id: 'c-jev' };
    const markerA = { type: 'custom', customType: MARKER_TYPE, data: { ...entryMarker(nativeEntry()), engine: 'pi', reason: 'timeout' } };
    const markerB = { type: 'custom', customType: MARKER_TYPE, data: { ...entryMarker(nativeEntry()), engine: 'pi', reason: 'disabled' } };
    for (const [id, entry, marker, measuredAfter] of [['A', entryA, markerA, 99_000], ['B', entryB, markerB, 42_000]] as const) {
      await pi.handlers.get('session_start')!({}, { sessionManager: {
        getSessionId: () => id,
        getEntries: () => [entry, marker, { type: 'custom', customType: MEASURED_TYPE, data: { compactionId: 'c-jev', measuredAfter } }],
      } });
    }
    if (pi.compactionRenderers.length) {
      assert.match(boxText(pi, entryA), /Jev \[backend not recorded\] did not produce it \(timeout\)/);
      assert.match(boxText(pi, entryB), /Jev disabled/);
    } else {
      const draw = (entry: unknown) => (pi.renderers.get(MARKER_TYPE) as (e: unknown, o: { expanded: boolean }, t: typeof plain) => Rendered)(entry, { expanded: false }, plain).render(200).join('\n');
      assert.match(draw(markerA), /99k measured/);
      assert.match(draw(markerB), /42k measured/);
    }
  }
});

test('session_shutdown drops only that session pending measurement and caches', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const a = sessionContext('A');
  const b = sessionContext('B');
  await pi.handlers.get('session_start')!({}, a);
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-A' }) }, a);
  await pi.handlers.get('session_start')!({}, b);
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-B' }) }, b);
  await pi.handlers.get('message_end')!({ message: MEASURED_ASSISTANT }, b);
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-B-pending' }) }, b);
  await pi.handlers.get('session_shutdown')!({}, b);
  await pi.handlers.get('message_end')!({ message: MEASURED_ASSISTANT }, b);
  assert.equal(pi.entries.filter(([type]) => type === MEASURED_TYPE).length, 1, 'B pending measurement was dropped');
  assert.match(boxText(pi, nativeEntry({ id: 'c-B' })), /~180k predicted/, 'B measured cache was dropped');
  const renderer = pi.compactionRenderers[0] as (e: unknown, o: { expanded: boolean }, t: typeof plain) => Rendered | undefined;
  assert.equal(renderer({ type: 'compaction', id: 'c-B' }, { expanded: false }, plain)!.render(100)[1], 'Jev outcome not recorded', 'B marker cache was dropped');
  await pi.handlers.get('message_end')!({ message: MEASURED_ASSISTANT }, a);
  assert.equal(pi.entries.filter(([type]) => type === MEASURED_TYPE).length, 2, 'A pending measurement survived');
  await flushTelemetry();
  const rows = readFileSync(join(dirname(deps.config.telemetry.path), 'measurements.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(row => [row.session_id, row.compaction_id]), [['B', 'c-B'], ['A', 'c-A']]);
});

test('the first response after a compaction measures the context, and an already-drawn box shows it', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const entry = nativeEntry();
  await pi.handlers.get('session_start')!({ type: 'session_start' }, {}); // a new session: nothing measured yet
  await pi.handlers.get('session_compact')!({ compactionEntry: entry }, {});
  const drawn = (pi.compactionRenderers[0] as (e: unknown, o: { expanded: boolean }, t: typeof plain) => Rendered)(entry, { expanded: false }, plain);
  assert.match(drawn.render(200).join('\n'), /~180k predicted/);

  // An aborted or errored response, or one with no usage, measures nothing.
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, stopReason: 'error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } }, {});
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { role: 'user', content: 'go' } }, {});
  assert.match(drawn.render(200).join('\n'), /~180k predicted/);

  await pi.handlers.get('message_end')!({ type: 'message_end', message: MEASURED_ASSISTANT }, {});
  // The component drawn before the measurement shows it on its next render: no new chat line.
  assert.match(drawn.render(200).join('\n'), /Context 401k → 153k measured/);
  assert.match(boxText(pi, entry, true), /next-response provider input 153k; prediction ~180k/);

  const measured = pi.entries.filter(([type]) => type === MEASURED_TYPE);
  assert.deepEqual(measured, [[MEASURED_TYPE, { version: 1, compactionId: 'c-jev', measuredAfter: 153_112, model: 'claude-opus-5-5' }]]);

  // Only the first response after the compaction measures it.
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, usage: { ...MEASURED_ASSISTANT.usage, cacheRead: 170_000 } } }, {});
  assert.equal(pi.entries.filter(([type]) => type === MEASURED_TYPE).length, 1);

  await flushTelemetry();
  const rows = readFileSync(join(dirname(deps.config.telemetry.path), 'measurements.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].compaction_id, 'c-jev');
  assert.equal(rows[0].engine, 'jev');
  assert.equal(rows[0].tokens_before, 401_000);
  assert.equal(rows[0].predicted_after, 180_000);
  assert.equal(rows[0].measured_after, 153_112);
});

test('without the box hook, the chat marker shows the measured count once it arrives', async () => {
  const pi = fakePiWithoutBox();
  register(pi.api, testDeps({ defer: (run: () => void) => run() }));
  await pi.handlers.get('session_start')!({ type: 'session_start' }, {}); // a new session: nothing measured yet
  // A saved Jev entry carries the hook's estimate, which the chat marker reads.
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ estimatedTokensAfter: 180_000 }) }, {});
  const [, data] = pi.entries.find(([type]) => type === MARKER_TYPE)!;
  const drawn = (pi.renderers.get(MARKER_TYPE) as (e: unknown, o: { expanded: boolean }, t: typeof plain) => Rendered)({ data }, { expanded: false }, plain);
  assert.match(drawn.render(200).join('\n'), /~180k predicted/);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: MEASURED_ASSISTANT }, {});
  assert.match(drawn.render(200).join('\n'), /→ 153k measured/);
});

test('a resumed session restores measurements from its entries, and a throwing append never escapes', async () => {
  const pi = fakePi();
  register(pi.api, testDeps());
  const entry = nativeEntry();
  const ctx = { sessionManager: { getEntries: () => [entry, { type: 'custom', customType: MEASURED_TYPE, data: { version: 1, compactionId: 'c-jev', measuredAfter: 99_000, model: 'm' } }] } };
  await pi.handlers.get('session_start')!({ type: 'session_start' }, ctx);
  assert.match(boxText(pi, entry), /99k measured/);

  const throwing = fakePi();
  (throwing.api as { appendEntry: unknown }).appendEntry = () => { throw new Error('closed'); };
  register(throwing.api, testDeps());
  await throwing.handlers.get('session_compact')!({ compactionEntry: entry }, {});
  await assert.doesNotReject(async () => { await throwing.handlers.get('message_end')!({ type: 'message_end', message: MEASURED_ASSISTANT }, {}); });
  assert.match(boxText(throwing, entry), /153k measured/);
});

test('a second compaction before any response takes the measurement, and odd usage measures nothing', async () => {
  const pi = fakePi();
  register(pi.api, testDeps());
  await pi.handlers.get('session_start')!({ type: 'session_start' }, {});
  const first = nativeEntry();
  const second = nativeEntry({ id: 'c-jev-2' });
  await pi.handlers.get('session_compact')!({ compactionEntry: first }, {});
  await pi.handlers.get('session_compact')!({ compactionEntry: second }, {});
  for (const usage of [
    { input: Number.NaN, cacheRead: 'many', cacheWrite: -5 },
    { input: Number.POSITIVE_INFINITY },
    null,
  ]) {
    await assert.doesNotReject(async () => { await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, usage } }, {}); });
  }
  await assert.doesNotReject(async () => { await pi.handlers.get('message_end')!(null, {}); });
  assert.equal(pi.entries.filter(([type]) => type === MEASURED_TYPE).length, 0);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: MEASURED_ASSISTANT }, {});
  assert.match(boxText(pi, second), /153k measured/);
  assert.match(boxText(pi, first), /~180k predicted/, 'the older compaction keeps its estimate');
});

// ---- ordering: only a response built after the commit measures the compaction -----------

/** The incident's commit: the 45eed97f compaction entry that was measured 3x too high. */
const RACE_COMMIT = '2026-10-02T03:05:58.729Z';
/** The racing request ecb31167 started 21s before that commit, and finished 95s after it. */
const RACE_STARTED = Date.parse('2026-10-02T03:05:37.752Z');
/** The first request built after it (8baaa76f): input 2 + cacheRead 66_169 + cacheWrite 77_084. */
const POST_COMMIT_ASSISTANT = {
  role: 'assistant',
  provider: 'meridian',
  model: 'claude-opus-5-5',
  stopReason: 'toolUse',
  usage: { input: 2, output: 635, cacheRead: 66_169, cacheWrite: 77_084, totalTokens: 143_890 },
};
const committedAtMs = Date.parse(RACE_COMMIT);
const raceMeasurementPath = (deps: ReturnType<typeof testDeps>) => join(dirname(deps.config.telemetry.path), 'measurements.jsonl');

/** One measured entry per row, in the order they were appended. */
const measuredEntries = (pi: ReturnType<typeof fakePi>) => pi.entries.filter(([type]) => type === MEASURED_TYPE);

async function startSession(pi: ReturnType<typeof fakePi>, id: string) {
  const ctx = sessionContext(id);
  await pi.handlers.get('session_start')!({ type: 'session_start' }, ctx);
  return ctx;
}

test('a response started before the commit is not measured; the next one is', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const a = await startSession(pi, 'RACE');
  const path = raceMeasurementPath(deps);
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-race', timestamp: RACE_COMMIT }) }, a);

  // ecb31167: the request began before the commit, so its prompt was the pre-compaction context.
  await pi.handlers.get('message_end')!({ type: 'message_end', message: {
    ...MEASURED_ASSISTANT, timestamp: RACE_STARTED, usage: { input: 2, cacheRead: 424_854, cacheWrite: 4_477, totalTokens: 442_430 },
  } }, a);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [], 'a pre-commit response must not measure the compaction');
  assert.equal(existsSync(path), false, 'a pre-commit response must not log a row');

  // 8baaa76f: the first response built from the context the commit installed.
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...POST_COMMIT_ASSISTANT, timestamp: committedAtMs + 101_977 } }, a);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-race', measuredAfter: 143_255, model: 'claude-opus-5-5' }],
  ]);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'RACE');
  assert.equal(rows[0].compaction_id, 'c-race');
  assert.equal(rows[0].measured_after, 143_255);
});

test('a response stamped exactly at the commit is pre-commit, and the next one measures', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const a = await startSession(pi, 'BOUNDARY');
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-boundary', timestamp: RACE_COMMIT }) }, a);

  // Pi core compares `assistant.timestamp <= Date.parse(compactionEntry.timestamp)`.
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs } }, a);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [], 'a response stamped at the commit instant is pre-commit');
  assert.equal(existsSync(raceMeasurementPath(deps)), false);

  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 1 } }, a);
  assert.deepEqual(measuredEntries(pi), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-boundary', measuredAfter: 153_112, model: 'claude-opus-5-5' }],
  ]);
});

test('a missing compaction or response timestamp falls back to the first-response measurement', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  // No ordering key on the entry: Pi did not stamp the commit, so nothing can be compared.
  const a = await startSession(pi, 'NOCOMMITSTAMP');
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-unstamped' }) }, a);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: RACE_STARTED } }, a);

  // A stamped commit, but a response Pi did not stamp.
  const b = await startSession(pi, 'NOMESSAGESTAMP');
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-unstamped-answer', timestamp: RACE_COMMIT }) }, b);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: MEASURED_ASSISTANT }, b);
  await flushTelemetry();

  const rows = readFileSync(raceMeasurementPath(deps), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(row => [row.session_id, row.compaction_id, row.measured_after]), [
    ['NOCOMMITSTAMP', 'c-unstamped', 153_112],
    ['NOMESSAGESTAMP', 'c-unstamped-answer', 153_112],
  ]);
});

test('two commits before any response measure only the second, and a response built between them measures neither', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const a = await startSession(pi, 'SUPERSEDED');
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-1', timestamp: RACE_COMMIT }) }, a);
  const mid = committedAtMs + 31_271; // after c-1, before c-2: built from neither final context
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-2', timestamp: new Date(mid).toISOString() }) }, a);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: mid } }, a);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [], 'a response built between the two commits measures neither');

  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: mid + 101_977 } }, a);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-2', measuredAfter: 153_112, model: 'claude-opus-5-5' }],
  ], 'the superseded commit gets no measurement');
  const rows = readFileSync(raceMeasurementPath(deps), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(row => [row.compaction_id, row.measured_after]), [['c-2', 153_112]]);
});

test('an aborted post-commit response leaves the measurement pending for the next one', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const a = await startSession(pi, 'ABORTED');
  await pi.handlers.get('session_compact')!({ compactionEntry: nativeEntry({ id: 'c-aborted', timestamp: RACE_COMMIT }) }, a);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: {
    ...POST_COMMIT_ASSISTANT, stopReason: 'aborted', timestamp: committedAtMs + 101_977,
  } }, a);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [], 'an aborted response measures nothing');

  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...POST_COMMIT_ASSISTANT, timestamp: committedAtMs + 103_000 } }, a);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-aborted', measuredAfter: 143_255, model: 'claude-opus-5-5' }],
  ]);
});

test('old saved data without a measurement retains context wording and makes activity unknown', () => {
  const data = entryMarker(nativeEntry());
  assert.equal('measuredAfter' in data, false);
  assert.deepEqual(compactionBoxLines(data, false), ['✓ Jev [backend not recorded] · activity unknown · jev-1.13.0', 'Destination not recorded', 'Context 401k → ~180k predicted · 0.7s attempt']);
  const lines = renderCompactionBox(data, { expanded: true }, plain).render(12);
  assert.ok(lines.every(line => visibleWidth(line) <= 12));
});


test('detector trigger appears on the existing headline, both live and resumed, without extra lines', () => {
  const entry: any = nativeEntry(); entry.details.jev.origin = 'extension'; entry.details.jev.requestId = 'req-card';
  for (const data of [entryMarker(entry), markerFor(entry, undefined, null)]) {
    assert.equal(data.origin, 'extension'); assert.equal(data.requestId, 'req-card');
    for (const width of [40, 80, 120]) {
      const ordinary = markerLines({ ...data, origin: 'native' }, false, width);
      const detector = markerLines(data, false, width);
      assert.equal(detector.length, ordinary.length); assert.ok(detector.some(line => line.includes('detector')));
      detector.forEach(line => assert.ok(visibleWidth(line) <= width));
    }
  }
});

test('a detector-origin compaction whose armed request is unknown (lost across reload) fails closed', async () => {
  // A fresh registration has no armed requests: exactly the state after reload between arm and hook.
  const pi = fakePi(); let passes = 0;
  const deps = testDeps(); const original = deps.makeAsker;
  deps.makeAsker = (...args: Parameters<typeof original>) => { passes++; return original(...args); };
  register(pi.api, deps);
  const result = (await pi.handlers.get('session_before_compact')!(piEvent({ reason: 'threshold', origin: 'extension', requestId: 'lost-request' }), piCtx())) as HookResult;
  assert.deepEqual(result, { cancel: true }, 'no compaction without the armed minimum net reduction');
  assert.equal(passes, 0, 'no engine pass is attempted');
  // A user/threshold compaction (no detector origin) is unaffected.
  const ordinary = (await pi.handlers.get('session_before_compact')!(piEvent(), piCtx())) as HookResult;
  assert.ok(ordinary && 'compaction' in ordinary);
});

// ---- a session_start between a compaction and its first valid response keeps it pending ----

/** A Jev compaction entry carrying the hook and attempt ids the measurement row records. */
function stampedEntry(id: string, timestamp: string): Record<string, unknown> {
  const entry = nativeEntry({ id, timestamp });
  const details = entry.details as { jev: Record<string, unknown> };
  details.jev = { ...details.jev, hook_id: `hook-${id}`, attempt_id: `attempt-${id}` };
  return entry;
}

/** The session context Pi hands a restarted extension: the same session id, its saved entries. */
const savedSession = (id: string, entries: unknown[], header: Record<string, unknown> | null = null) => {
  let branch = entries;
  return {
    setBranch: (path: unknown[]) => { branch = path; },
    sessionManager: { getSessionId: () => id, getEntries: () => entries, getBranch: () => branch, getHeader: () => header },
  };
};

/** The session-file entry Pi persists for a response: entry timestamp ISO, message timestamp epoch ms. */
const responseEntry = (id: string, message: Record<string, unknown>) =>
  ({ type: 'message', id, parentId: null, timestamp: new Date(message.timestamp as number).toISOString(), message });

/** The entries a session file holds after `session_compact`: the compaction, then the marker the extension appended. */
function savedEntries(pi: ReturnType<typeof fakePi>, compaction: unknown): unknown[] {
  return [compaction, ...pi.entries.map(([customType, data]) => ({ type: 'custom', customType, data }))];
}

const measurementRows = (deps: ReturnType<typeof testDeps>) => existsSync(raceMeasurementPath(deps))
  ? readFileSync(raceMeasurementPath(deps), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  : [];
const withoutTs = (row: Record<string, unknown>) => { const { ts: _ts, ...rest } = row; return rest; };

test('a reload between a compaction and its first response still measures it, with the row the no-reload path writes', async () => {
  const answer = { type: 'message_end', message: { ...POST_COMMIT_ASSISTANT, timestamp: committedAtMs + 5_000 } };

  // Control: no session_start between the commit and the response.
  const control = fakePi();
  const controlDeps = testDeps();
  register(control.api, controlDeps);
  const c = await startSession(control, 'RELOAD');
  await control.handlers.get('session_compact')!({ compactionEntry: stampedEntry('c-reload', RACE_COMMIT) }, c);
  await control.handlers.get('message_end')!(answer, c);
  await flushTelemetry();
  const [controlRow] = measurementRows(controlDeps);
  assert.ok(controlRow, 'the control run writes its row');

  // Reload in the same process: Pi emits session_shutdown, then session_start with reason 'reload'.
  const reloaded = fakePi();
  const reloadedDeps = testDeps();
  register(reloaded.api, reloadedDeps);
  const r = await startSession(reloaded, 'RELOAD');
  const entry = stampedEntry('c-reload', RACE_COMMIT);
  await reloaded.handlers.get('session_compact')!({ compactionEntry: entry }, r);
  const saved = savedSession('RELOAD', savedEntries(reloaded, entry));
  await reloaded.handlers.get('session_shutdown')!({ type: 'session_shutdown' }, r);
  await reloaded.handlers.get('session_start')!({ type: 'session_start', reason: 'reload' }, saved);
  await reloaded.handlers.get('message_end')!(answer, saved);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(reloaded), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-reload', measuredAfter: 143_255, model: 'claude-opus-5-5' }],
  ]);
  const reloadedRows = measurementRows(reloadedDeps);
  assert.equal(reloadedRows.length, 1);
  assert.deepEqual(withoutTs(reloadedRows[0]), withoutTs(controlRow));
  assert.equal(reloadedRows[0].hook_id, 'hook-c-reload');
  assert.equal(reloadedRows[0].attempt_id, 'attempt-c-reload');

  // Resume in a new process: a fresh registration sees only the saved entries.
  const resumed = fakePi();
  const resumedDeps = testDeps();
  register(resumed.api, resumedDeps);
  await resumed.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, saved);
  await resumed.handlers.get('message_end')!(answer, saved);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(resumed), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-reload', measuredAfter: 143_255, model: 'claude-opus-5-5' }],
  ]);
  const resumedRows = measurementRows(resumedDeps);
  assert.equal(resumedRows.length, 1);
  assert.deepEqual(withoutTs(resumedRows[0]), withoutTs(controlRow));
});

test('a session_start after the compaction was measured re-measures nothing', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const s = await startSession(pi, 'MEASURED');
  const entry = stampedEntry('c-done', RACE_COMMIT);
  await pi.handlers.get('session_compact')!({ compactionEntry: entry }, s);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 1_000 } }, s);
  assert.equal(measuredEntries(pi).length, 1);

  // Control: the same saved session without its measured entry is re-derived and measured.
  const control = fakePi();
  const controlDeps = testDeps();
  register(control.api, controlDeps);
  const unmeasured = savedSession('MEASURED', savedEntries(pi, entry).filter(e => (e as { customType?: string }).customType !== MEASURED_TYPE));
  await control.handlers.get('session_start')!({ type: 'session_start', reason: 'reload' }, unmeasured);
  await control.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 2_000 } }, unmeasured);
  assert.equal(measuredEntries(control).length, 1, 'control: the unmeasured compaction is measured');

  const saved = savedSession('MEASURED', savedEntries(pi, entry));
  await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'reload' }, saved);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 2_000 } }, saved);
  await flushTelemetry();
  assert.equal(measuredEntries(pi).length, 1, 'no second measured entry');
  assert.equal(measurementRows(deps).length, 1, 'no second row');
});

test('the ordering gate still applies to a measurement re-derived on session_start', async () => {
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const s = await startSession(pi, 'REGATE');
  const entry = stampedEntry('c-regate', RACE_COMMIT);
  await pi.handlers.get('session_compact')!({ compactionEntry: entry }, s);
  const saved = savedSession('REGATE', savedEntries(pi, entry));
  await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'reload' }, saved);

  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs } }, saved);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: RACE_STARTED } }, saved);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [], 'a response stamped at or before the commit measures nothing');
  assert.equal(measurementRows(deps).length, 0);

  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...POST_COMMIT_ASSISTANT, timestamp: committedAtMs + 1 } }, saved);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-regate', measuredAfter: 143_255, model: 'claude-opus-5-5' }],
  ]);
  assert.deepEqual(measurementRows(deps).map(row => row.compaction_id), ['c-regate']);
});

test('session_start with no compaction, or with its newest compaction measured, leaves nothing pending', async () => {
  const entry = stampedEntry('c-old', RACE_COMMIT);
  const marker = { type: 'custom', customType: MARKER_TYPE, data: entryMarker(entry) };
  const measured = { type: 'custom', customType: MEASURED_TYPE, data: { version: 1, compactionId: 'c-old', measuredAfter: 99_000, model: 'm' } };
  // Control: the same compaction and marker without the measured entry is re-derived and measured.
  const control = fakePi();
  register(control.api, testDeps());
  const unmeasured = savedSession('NOTHING', [entry, marker]);
  await control.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, unmeasured);
  await control.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 1_000 } }, unmeasured);
  assert.equal(measuredEntries(control).length, 1, 'control: the unmeasured compaction is measured');

  for (const entries of [[], [{ type: 'message', id: 'm-1' }], [entry, marker, measured]]) {
    const pi = fakePi();
    const deps = testDeps();
    register(pi.api, deps);
    const saved = savedSession('NOTHING', entries);
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, saved);
    await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 1_000 } }, saved);
    await flushTelemetry();
    assert.deepEqual(pi.entries, [], 'a following valid response appends nothing');
    assert.equal(measurementRows(deps).length, 0);
  }
});

test('with two unmeasured compactions, session_start leaves only the newest pending', async () => {
  const first = stampedEntry('c-first', RACE_COMMIT);
  const second = stampedEntry('c-second', new Date(committedAtMs + 60_000).toISOString());
  const entries = [
    first, { type: 'custom', customType: MARKER_TYPE, data: entryMarker(first) },
    second, { type: 'custom', customType: MARKER_TYPE, data: entryMarker(second) },
  ];
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const saved = savedSession('TWO', entries);
  await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, saved);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 120_000 } }, saved);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 180_000 } }, saved);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-second', measuredAfter: 153_112, model: 'claude-opus-5-5' }],
  ]);
  const rows = measurementRows(deps);
  assert.deepEqual(rows.map(row => [row.compaction_id, row.hook_id, row.attempt_id, row.session_id]), [['c-second', 'hook-c-second', 'attempt-c-second', 'TWO']]);
});

test('a forked session does not re-derive its parent\'s pending measurement', async () => {
  const entry = stampedEntry('c-parent', RACE_COMMIT);
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const saved = savedSession('FORK', [entry, { type: 'custom', customType: MARKER_TYPE, data: entryMarker(entry) }]);

  // Control: the same entries on a resume are re-derived and measured.
  const control = fakePi();
  register(control.api, testDeps());
  await control.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, saved);
  await control.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 1_000 } }, saved);
  assert.equal(measuredEntries(control).length, 1, 'control: the resumed compaction is measured');

  await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'fork' }, saved);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 1_000 } }, saved);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), []);
  assert.equal(measurementRows(deps).length, 0);
});

// ---- a re-derived measurement only for a compaction whose first response is still to come ----

/** A Pi built-in compaction from before pi-jev measured: no Jev details, no marker entry. */
const builtinEntry = (id: string, timestamp: string) => ({ type: 'compaction', id, parentId: null, timestamp, summary: 's', firstKeptEntryId: 'k', tokensBefore: 180_000 });

test('session_start does not re-derive a compaction a valid response already followed', async () => {
  const jev = stampedEntry('c-stale', RACE_COMMIT);
  const jevMarker = { type: 'custom', customType: MARKER_TYPE, data: entryMarker(jev) };
  const later = responseEntry('m-later', { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 60_000 });
  const cases: Array<[string, unknown[]]> = [
    ['a built-in compaction with no marker, answered before pi-jev ran', [builtinEntry('c-builtin', RACE_COMMIT), later]],
    ['a Jev compaction from a version that never measured, answered', [jev, jevMarker, later]],
  ];
  for (const [name, entries] of cases) {
    const pi = fakePi();
    const deps = testDeps();
    register(pi.api, deps);
    const saved = savedSession('STALE', entries);
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, saved);
    await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...POST_COMMIT_ASSISTANT, timestamp: committedAtMs + 86_400_000 } }, saved);
    await flushTelemetry();
    assert.deepEqual(measuredEntries(pi), [], `${name}: a response days later measures nothing`);
    assert.equal(measurementRows(deps).length, 0, `${name}: no row`);
  }
});

test('a pre-commit, aborted or errored response after the compaction leaves the re-derived measurement pending', async () => {
  const entry = stampedEntry('c-fresh', RACE_COMMIT);
  const entries = [
    entry,
    { type: 'custom', customType: MARKER_TYPE, data: entryMarker(entry) },
    // The racing request started before the commit and finished after it: Pi saves it after the compaction.
    responseEntry('m-race', { ...MEASURED_ASSISTANT, timestamp: RACE_STARTED }),
    responseEntry('m-aborted', { ...MEASURED_ASSISTANT, stopReason: 'aborted', timestamp: committedAtMs + 1_000 }),
    responseEntry('m-error', { ...MEASURED_ASSISTANT, stopReason: 'error', timestamp: committedAtMs + 2_000 }),
    { type: 'message', id: 'u-1', parentId: null, timestamp: new Date(committedAtMs + 3_000).toISOString(), message: { role: 'user', content: 'go', timestamp: committedAtMs + 3_000 } },
  ];
  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const saved = savedSession('FRESH', entries);
  await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, saved);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...POST_COMMIT_ASSISTANT, timestamp: committedAtMs + 4_000 } }, saved);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [
    [MEASURED_TYPE, { version: 1, compactionId: 'c-fresh', measuredAfter: 143_255, model: 'claude-opus-5-5' }],
  ]);
  assert.deepEqual(measurementRows(deps).map(row => row.compaction_id), ['c-fresh']);
});

test('resuming a fork does not re-derive the compaction it copied from its parent', async () => {
  const copied = stampedEntry('c-copied', RACE_COMMIT);
  const forkHeader = { type: 'session', version: 3, id: 'FORKED', timestamp: new Date(committedAtMs + 30_000).toISOString(), cwd: '/w', parentSession: '/s/parent.jsonl' };
  const copiedEntries = [copied, { type: 'custom', customType: MARKER_TYPE, data: entryMarker(copied) }];

  const pi = fakePi();
  const deps = testDeps();
  register(pi.api, deps);
  const saved = savedSession('FORKED', copiedEntries, forkHeader);
  await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, saved);
  await pi.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 60_000 } }, saved);
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi), [], 'the parent\'s compaction is not measured from the fork');
  assert.equal(measurementRows(deps).length, 0);

  // Control: a compaction the fork committed itself, after it was forked, is re-derived and measured.
  const own = stampedEntry('c-own', new Date(committedAtMs + 40_000).toISOString());
  const control = fakePi();
  const controlDeps = testDeps();
  register(control.api, controlDeps);
  const ownSaved = savedSession('FORKED', [...copiedEntries, own, { type: 'custom', customType: MARKER_TYPE, data: entryMarker(own) }], forkHeader);
  await control.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, ownSaved);
  await control.handlers.get('message_end')!({ type: 'message_end', message: { ...MEASURED_ASSISTANT, timestamp: committedAtMs + 60_000 } }, ownSaved);
  await flushTelemetry();
  assert.deepEqual(measurementRows(controlDeps).map(row => row.compaction_id), ['c-own']);
});

// ---- pending measurements follow the current root-to-leaf branch, not file order ----

const branchAnswer = { type: 'message_end', message: { ...POST_COMMIT_ASSISTANT, timestamp: committedAtMs + 5_000 } };

async function assertBranchMeasurement(pi: ReturnType<typeof fakePi>, deps: ReturnType<typeof testDeps>, id: string | null) {
  await flushTelemetry();
  assert.deepEqual(measuredEntries(pi).map(([, data]) => (data as { compactionId: string }).compactionId), id === null ? [] : [id]);
  assert.deepEqual(measurementRows(deps).map(row => [row.compaction_id, row.measured_after]), id === null ? [] : [[id, 143_255]]);
  if (id === null) assert.equal(existsSync(raceMeasurementPath(deps)), false, 'no measurements.jsonl is created');
}

test('T1: reload ignores an off-branch compaction, but measures the identical on-branch entry', async () => {
  // Run the positive control first so it executes even against the unfixed implementation.
  for (const onBranch of [true, false]) {
    const pi = fakePi(); const deps = testDeps(); register(pi.api, deps);
    const c1 = stampedEntry('C1', RACE_COMMIT);
    const entries = [c1, { type: 'custom', customType: MARKER_TYPE, data: entryMarker(c1) }];
    const ctx = savedSession('T1', entries);
    ctx.setBranch(onBranch ? entries : []);
    await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'reload' }, ctx);
    await pi.handlers.get('message_end')!(branchAnswer, ctx);
    await assertBranchMeasurement(pi, deps, onBranch ? 'C1' : null);
  }
});

test('T2: resume measures current-branch C1, not file-newest off-branch C2', async () => {
  const pi = fakePi(); const deps = testDeps(); register(pi.api, deps);
  const c1 = stampedEntry('C1', RACE_COMMIT);
  const c2 = stampedEntry('C2', new Date(committedAtMs + 1_000).toISOString());
  const ctx = savedSession('T2', [c1, c2]);
  ctx.setBranch([c1]);
  await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, ctx);
  await pi.handlers.get('message_end')!(branchAnswer, ctx);
  await assertBranchMeasurement(pi, deps, 'C1');
});

test('T3: tree abandons an in-process C1 only when the new branch excludes it', async () => {
  for (const onBranch of [true, false]) {
    const pi = fakePi(); const deps = testDeps(); register(pi.api, deps);
    const c1 = stampedEntry('C1', RACE_COMMIT);
    const ctx = savedSession('T3', [c1]);
    await pi.handlers.get('session_compact')!({ compactionEntry: c1 }, ctx);
    ctx.setBranch(onBranch ? [c1] : []);
    await pi.handlers.get('session_tree')!({ type: 'session_tree' }, ctx);
    await pi.handlers.get('message_end')!(branchAnswer, ctx);
    await pi.handlers.get('message_end')!(branchAnswer, ctx);
    await assertBranchMeasurement(pi, deps, onBranch ? 'C1' : null);
  }
});

test('T4: tree replaces pending C1 with unanswered C3 on the new branch', async () => {
  const pi = fakePi(); const deps = testDeps(); register(pi.api, deps);
  const c1 = stampedEntry('C1', RACE_COMMIT);
  const c3 = stampedEntry('C3', new Date(committedAtMs + 1_000).toISOString());
  const ctx = savedSession('T4', [c1, c3]);
  ctx.setBranch([c1]);
  await pi.handlers.get('session_compact')!({ compactionEntry: c1 }, ctx);
  ctx.setBranch([c3]);
  await pi.handlers.get('session_tree')!({ type: 'session_tree' }, ctx);
  await pi.handlers.get('message_end')!(branchAnswer, ctx);
  await assertBranchMeasurement(pi, deps, 'C3');
});

test('T6: tree restores unanswered C1 after navigating away and back, but never measures it twice', async () => {
  const pi = fakePi(); const deps = testDeps(); register(pi.api, deps);
  const c1 = stampedEntry('C1', RACE_COMMIT);
  const ctx = savedSession('T6', [c1]);
  await pi.handlers.get('session_compact')!({ compactionEntry: c1 }, ctx);

  ctx.setBranch([]);
  await pi.handlers.get('session_tree')!({ type: 'session_tree' }, ctx);
  await assertBranchMeasurement(pi, deps, null);
  ctx.setBranch([c1]);
  await pi.handlers.get('session_tree')!({ type: 'session_tree' }, ctx);
  await pi.handlers.get('message_end')!(branchAnswer, ctx);
  await assertBranchMeasurement(pi, deps, 'C1');

  // The in-process measured guard must survive another round trip even when the
  // branch fake does not contain the measured entry appended by message_end.
  ctx.setBranch([]);
  await pi.handlers.get('session_tree')!({ type: 'session_tree' }, ctx);
  ctx.setBranch([c1]);
  await pi.handlers.get('session_tree')!({ type: 'session_tree' }, ctx);
  await pi.handlers.get('message_end')!(branchAnswer, ctx);
  await assertBranchMeasurement(pi, deps, 'C1');
});

test('T5: without getBranch, session_start fails closed and re-derives nothing', async () => {
  const pi = fakePi(); const deps = testDeps(); register(pi.api, deps);
  const saved = savedSession('T5', [stampedEntry('C1', RACE_COMMIT)]);
  const { getBranch: _getBranch, ...sessionManager } = saved.sessionManager;
  const ctx = { sessionManager };
  await pi.handlers.get('session_start')!({ type: 'session_start', reason: 'resume' }, ctx);
  await pi.handlers.get('message_end')!(branchAnswer, ctx);
  await assertBranchMeasurement(pi, deps, null);
});


test('expanded segments show capped counts when present', () => {
  const data = entryMarker(nativeEntry());
  assert.ok(markerLines({ ...data, stats: { ...data.stats, capped: 3 } }, true).includes(
    'Segments: 83 kept · 77 pruning cuts · 60 dropped · 44 pinned · 3 capped'));
});

test('expanded recovery row appears even for zero restorable stubs', () => {
  const data = entryMarker(nativeEntry());
  for (const stubbed of [0, 9]) assert.ok(markerLines({ ...data, stats: { ...data.stats, stubbed } }, true).includes(
    `Recoverable: ${stubbed} stubs restorable with jev_expand`));
});

test('expanded box warns only for positive unlinked stub counts', () => {
  const data = entryMarker(nativeEntry());
  assert.ok(markerLines({ ...data, stats: { ...data.stats, unlinked: 2 } }, true).includes('! 2 stubs without a restore id'));
  assert.ok(!markerLines({ ...data, stats: { ...data.stats, unlinked: 0 } }, true).some(line => line.includes('without a restore id')));
});

test('old entries without recovery stats preserve the exact expanded box', () => {
  const data = entryMarker(nativeEntry());
  assert.deepEqual(markerLines(data, true), [
    '✓ Jev [backend not recorded] · activity unknown · jev-1.13.0',
    'Destination not recorded',
    'Context 401k → ~180k predicted · 0.7s attempt',
    'Context: prediction ~180k; includes system + tools; next-response measurement not recorded',
    'Segments: 83 kept · 77 cut · 60 dropped · 44 pinned',
    'Pruning: 7 requests · 271k tokens in · 3.0k tokens out',
    'Attempt: 0.7s · successful pass only',
    'Budget: target 250k · trigger 900k · fixed 20k · summary 90k',
    'Record: entry c-jev · config abc',
  ]);
  assert.ok(markerLines({ ...data, stats: { ...data.stats, stubbed: 0 } }, true).includes('Recoverable: 0 stubs restorable with jev_expand'));
});
