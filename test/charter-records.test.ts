import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCharter, readCharterState, type CharterEntry } from '../src/core/charter.js';
import { saveCharterRecords, readCharterRecords, rebuildCharterPrefix } from '../src/core/charter-records.js';
const entry = (id: string, text: string): CharterEntry => ({ id, kind: 'said', entryId: id, text, order: 0, sourceChars: text.length, sourceHash: '', pasted: [] });
test('records rebuild exact assembled prefix, with retirement, directives, chain and Unicode', () => {
  const entries = [entry('u:a', '😀\n[operator u:b]\nquoted marker'), entry('u:b', 'retired')];
  const state = readCharterState({ version: 1, retired: { 'u:b': { reason: 'done', gen: 2, by: null } } });
  for (const directives of ['', 'Plans the operator accepted\nverbatim\n']) for (const chain of ['', '## Why the current work\nexact\n']) {
    const text = renderCharter(entries, state) + (directives ? directives + '\n' : '');
    const prefix = (text ? text + '\n' : '') + (chain ? chain + '\n' : '');
    const r = JSON.parse(JSON.stringify(saveCharterRecords(entries, state, directives, chain)));
    assert.equal(rebuildCharterPrefix(r, prefix + '<compacted-conversation>body'), prefix);
    assert.equal(r.entries.length, 1);
    assert.equal(prefix.slice(r.entries[0].offset, r.entries[0].offset + r.entries[0].length), '[operator u:a]\n' + entries[0].text);
  }
});
test('empty charter, old details and unknown/malformed offsets are tolerant', () => {
  const old = { version: 1, retired: {} };
  assert.deepEqual(readCharterState(old), old);
  assert.equal(readCharterRecords(undefined, 'summary'), undefined);
  assert.equal(rebuildCharterPrefix({ version: 2 }, 'summary'), undefined);
  assert.equal(rebuildCharterPrefix(saveCharterRecords([], old, '', ''), 'summary'), '');
  assert.equal(readCharterRecords({ version: 1, prefixLength: Infinity, entries: [] }, 'summary'), undefined);
  const r = saveCharterRecords([entry('u:a', 'hello')], old, '', '');
  assert.equal(readCharterRecords({ ...r, entries: [{ ...r.entries[0], offset: 0 }] }, 'summary'), undefined);
});

test('v2 dispersed ranges reconstruct legacy prefix and reject tampered digest', async () => {
 const { saveTieredCharterRecords, rebuildCharterPrefix } = await import('../src/core/charter-records.js');
 const { createHash } = await import('node:crypto');
 const hash = (s: string) => createHash('sha256').update(s).digest('hex');
 const summary = 'abc---def';
 const r = saveTieredCharterRecords(summary,[{offset:6,length:3},{offset:0,length:3}],[],hash);
 assert.equal(rebuildCharterPrefix(r,summary), 'defabc');
 assert.equal(rebuildCharterPrefix(r,summary+'!'),undefined);
});

test('v2 overlapping provenance ranges cannot duplicate retained prefix bytes',async()=>{
 const {saveTieredCharterRecords,readCharterRecords}=await import('../src/core/charter-records.js');
 const r=saveTieredCharterRecords('abcdef',[{offset:0,length:3},{offset:1,length:3}],[]);assert.equal(readCharterRecords(r,'abcdef'),undefined);
});

test('records cover an entry retired as corrected (it is rendered); omitted reasons have none', () => {
  const entries = [entry('u:a', 'Proof the rye dough for 45 minutes.'), entry('u:b', 'Make it 60 minutes instead.'), entry('u:c', 'finished thing')];
  const state = readCharterState({ version: 1, retired: { 'u:a': { reason: 'corrected', gen: 1, by: 'u:b' }, 'u:c': { reason: 'done', gen: 1, by: null } } });
  const text = renderCharter(entries, state);
  const prefix = text + '\n';
  const r = JSON.parse(JSON.stringify(saveCharterRecords(entries, state, '', '')));
  assert.deepEqual(r.entries.map((e: { id: string }) => e.id), ['u:a', 'u:b']);
  assert.ok(readCharterRecords(r, prefix + '<compacted-conversation>body'));
  assert.equal(rebuildCharterPrefix(r, prefix + '<compacted-conversation>body'), prefix);
  for (const e of r.entries) assert.equal(prefix.slice(e.offset, e.offset + e.length), `[operator ${e.id}]\n` + entries.find(x => x.id === e.id)!.text);
});
