// Intentionally imports only pre-existing APIs: this same file runs against the base revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCompact } from '../src/pi/extension.js';
import { entryMarker, renderMarker, renderCompactionBox } from '../src/pi/marker.js';
import { JevError } from '../src/client/jev-client.js';
import { testConfig } from './support/config.js';
import { piCtx, piEvent, testDeps } from './support/pi-event.js';

const plain = { fg: (_: string, text: string) => text };

test('regression: handleCompact persists an explicit actual backend with JSON-safe output', async () => {
  const result = await handleCompact(piEvent(), piCtx(), testDeps());
  assert.ok(result && 'compaction' in result);
  assert.deepEqual(JSON.parse(JSON.stringify(result.compaction)), result.compaction);
  assert.equal(result.compaction.details.jev.backend, 'typesafe');
  assert.equal(result.compaction.details.jev.backend_descriptor.id, 'typesafe');
});

test('regression: historical renderers say backend not recorded and have three rows at 60/100', () => {
  const data = entryMarker({ tokensBefore: 120000, details: { jev: { model: 'openjev', stats: { kept: 42, truncated: 8, dropped: 17 } } } });
  for (const width of [60, 100]) for (const component of [renderMarker({ data }, { expanded: false }, plain), renderCompactionBox(data, { expanded: false }, plain)]) {
    const lines = component.render(width);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /Jev \[backend not recorded\]/);
  }
});

test('regression: success and failure surfaces identify the actual backend', async () => {
  const notes: string[] = [];
  await handleCompact(piEvent(), piCtx(notes), testDeps());
  assert.match(notes[0], /^✓ Jev \[TypeSafe hosted\]/);
  const failures: string[] = [];
  await handleCompact(piEvent(), piCtx(failures), testDeps({ makeAsker: () => ({ ask: async () => { throw new JevError('network', 'RAW SECRET'); } }) }));
  assert.match(failures[0], /^× Jev \[TypeSafe hosted\] failed \(network\)/);
  assert.ok(!failures.join('').includes('RAW SECRET'));
});

test('regression: two backend IDs do not suppress each other on the same failure reason', async () => {
  let config = testConfig(c => Object.assign(c.api, { backend: 'local', localEndpoint: 'http://127.0.0.1:18390/v1/systemone-local', localModel: 'openjev', fallback: 'none' }));
  const deps = testDeps({ loadConfig: () => ({ ok: true, config, hash: 'h' }), makeAsker: () => ({ ask: async () => { throw new JevError('network', 'unavailable'); } }) });
  const notices: string[] = [];
  await handleCompact(piEvent(), piCtx(notices), deps);
  config = testConfig();
  await handleCompact(piEvent(), piCtx(notices), deps);
  // Match old and new failure prefixes so this detects dedup, not just wording.
  assert.equal(notices.filter(n => n.startsWith('×') || n.startsWith('jev-compaction failed')).length, 2);
});
