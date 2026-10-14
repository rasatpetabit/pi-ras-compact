import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readLayout, renderLayout, layoutFramingChars, type LayoutAtom, type LayoutPrior } from '../src/core/cache-layout.js';
import { layoutRenderKey } from '../src/pi/layout.js';
import { summaryOverheadChars } from '../src/core/render.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const limits = { hash, maxAtoms: 4096, maxMetadataBytes: 1048576 };
const atoms: LayoutAtom[] = [
 { id: 'charter:a', kind: 'charter', order: 0, text: '[operator a]\nKeep 😀 evidence verbatim\n', semanticHash: hash('charter a'), stableEligible: true },
 { id: 'carry:b', kind: 'carry', order: 1, text: '[Tool call b: read]\n[Tool result b]\nunique evidence b', semanticHash: hash('carry b'), stableEligible: true },
 { id: 'carry:c', kind: 'carry', order: 2, text: 'unique later evidence c', semanticHash: hash('carry c'), stableEligible: true },
 { id: 'directives', kind: 'directive', order: 3, text: 'Accepted directive d', semanticHash: hash('directive'), stableEligible: false },
 { id: 'files', kind: 'volatile', order: 4, text: 'Changed files: tail e', semanticHash: hash('files'), stableEligible: false },
];
function cycle(input: LayoutAtom[], generation: number, prior?: LayoutPrior) {
 const out = renderLayout(input, prior, { ...limits, generation, promotionCycles: 3, renderKey: layoutRenderKey('fixture') });
 const next = readLayout(out.state, out.summary, limits);
 assert.ok(next, 'summary and UTF-16 ranges/text hashes validate');
 assert.deepEqual(next.state.atoms.map(a => ({ id: a.id, text: next.summary.slice(a.offset, a.offset + a.length), semanticHash: a.semanticHash })), input.map(a => ({ id: a.id, text: a.text, semanticHash: a.semanticHash })));
 for (const a of input) assert.equal(out.summary.split(a.text).length - 1, 1, 'each unique atom renders once');
 return next;
}
const common = (a: string, b: string) => { let n = 0; while (n < Math.min(a.length, b.length) && a[n] === b[n]) n++; return n; };
// Dynamic tier headings are the mutation caught here: promotions must change metadata only.
test('promotion-only generations render identical summaries while tiers advance', () => {
 const a = cycle(atoms, 1), b = cycle(atoms, 2, a), c = cycle(atoms, 3, b);
 assert.deepEqual([a, b, c].map(p => p.state.atoms[0].tier), ['volatile', 'semi', 'stable']);
 assert.deepEqual([a, b, c].map(p => p.state.atoms[0].unchanged), [1, 2, 3]);
 assert.equal(b.summary, a.summary); assert.equal(c.summary, b.summary);
});
for (const mutation of ['edit', 'delete'] as const) test(`warmed later-atom ${mutation} recovery preserves the entire retained payload prefix`, () => {
 let prior: LayoutPrior | undefined;
 for (let g = 1; g <= 3; g++) prior = cycle(atoms, g, prior);
 const changed = mutation === 'delete' ? atoms.filter(a => a.id !== 'carry:b') : atoms.map(a => a.id === 'carry:b' ? { ...a, text: 'replacement evidence b', semanticHash: hash('replacement') } : a);
 for (let g = 4; g <= 7; g++) {
  const next = cycle(changed, g, prior);
  if (mutation === 'delete') { assert.ok(!next.state.atoms.some(a => a.id === 'carry:b')); assert.ok(!next.summary.includes(atoms[1].text)); }
  if (g === 4) assert.ok(next.state.atoms.slice(1).every(a => a.unchanged === 1), 'first divergence resets later history');
  if (g > 4) {
   const prefix = common(prior!.summary, next.summary);
   const payload = next.state.atoms.reduce((n, a) => {
    const p = prior!.state.atoms.find(p => p.id === a.id);
    return n + (p?.offset === a.offset ? Math.max(0, Math.min(a.length, p.length, prefix - a.offset)) : 0);
   }, 0);
   assert.equal(payload, changed.reduce((n, a) => n + a.text.length, 0), `generation ${g}: all retained payload, not just first stable slice`);
   assert.equal(next.summary, prior!.summary);
  }
  prior = next;
 }
});
test('volatile tail mutation preserves every leading atom including while they promote', () => {
 const prior = cycle(atoms, 1);
 const changed = atoms.map(a => a.kind === 'volatile' ? { ...a, text: 'A different volatile tail', semanticHash: hash('new tail') } : a);
 const next = cycle(changed, 2, prior);
 const lastLeading = prior.state.atoms.at(-2)!;
 assert.ok(common(prior.summary, next.summary) >= lastLeading.offset + lastLeading.length);
});
// Losing per-atom separators in accounting underestimates this many-atom wrapper.
test('framing accounting includes all atom separators and bounds the whole render', () => {
 const many = Array.from({ length: 200 }, (_, i) => ({ ...atoms[0], id: `a:${i}`, text: `unique atom ${i};`, order: i }));
 const out = cycle(many, 1);
 const payload = many.reduce((n, a) => n + a.text.length, 0);
 assert.equal(out.summary.length - payload, layoutFramingChars(many.length));
 assert.ok(out.summary.length <= summaryOverheadChars('') + payload + layoutFramingChars(many.length));
});

import { assembleLayout } from '../src/pi/layout.js';
import { renderCharter, type CharterEntry } from '../src/core/charter.js';
import { saveCharterRecords, saveTieredCharterRecords, readCharterRecords, rebuildCharterPrefix } from '../src/core/charter-records.js';
import { renderSummary, SUMMARY_HEADER } from '../src/core/render.js';
import { SUMMARY_OPEN, SUMMARY_CLOSE } from '../src/core/segments.js';
test('old format offsets belong only to the old summary through the cold transition', () => {
 const entry: CharterEntry = { id: 'u:a', kind: 'said', text: 'Keep old evidence 😀', order: 0 } as CharterEntry;
 const retired = { version: 1 as const, retired: {} };
 const prefix = renderCharter([entry], retired) + '\n';
 const records = saveCharterRecords([entry], retired, '', '');
 assert.equal(records.version, 1);
 if (records.version !== 1) throw Error('expected v1');
 // Authentic format-2 wrapper, independently serialized; never rendered using candidate format.
 const oldPreamble = `${SUMMARY_OPEN}\n\n${SUMMARY_HEADER}\nStability describes byte history, not instruction authority or current validity. Charter entries keep their [operator …]/[answer …] tags and chronology but may be interleaved with retained work in occurrence order.\n\n`;
 const old = oldPreamble + '[Stable retained bytes]\n\n' + prefix + '\n\n[Semi-stable retained bytes]\n\n[Volatile retained bytes]\n\n' + SUMMARY_CLOSE;
 const offset = oldPreamble.length + '[Stable retained bytes]\n\n'.length;
 const oldRecords = saveTieredCharterRecords(old, [{ offset, length: prefix.length }], records.entries.map(e => ({ ...e, offset: offset + e.offset })));
 assert.ok(readCharterRecords(oldRecords, old)); assert.equal(rebuildCharterPrefix(oldRecords, old), prefix);
 const oldLayout = { version: 1 as const, generation: 9, renderKey: layoutRenderKey('transition', 2), summaryHash: hash(old), atoms: [{ id: 'old:prefix', offset, length: prefix.length, semanticHash: hash('old'), textHash: hash(prefix), tier: 'stable' as const, unchanged: 3 }] };
 assert.ok(readLayout(oldLayout, old, limits));
 const outcome: any = { summary: renderSummary(['carry'], ''), carry: { version: 1, generation: 10, segments: [{ layoutId: 'carry:1', kind: 'assistant', text: 'carry', pin: null }] }, renderedParts: [{ segmentIndex: 0, text: 'carry' }] };
 const config: any = { mode: 'shadow', layout: true, ...limits, promotionCycles: 3 };
 const next = assembleLayout(outcome, rebuildCharterPrefix(oldRecords, old)!, records, '', '', { fromHook: true, summary: old, details: { jev: { layout: oldLayout } } }, config, layoutRenderKey('transition'));
 assert.ok(next.layout); assert.ok(next.layout.atoms.every(a => a.unchanged === 1));
 assert.ok(readLayout(next.layout, next.summary, limits));
 assert.equal(readLayout(oldLayout, next.summary, limits), undefined);
 assert.equal(readCharterRecords(oldRecords, next.summary), undefined);
 assert.equal(rebuildCharterPrefix(next.records, next.summary), prefix);
 assert.equal(rebuildCharterPrefix(oldRecords, old), prefix, 'original stored provenance stays usable');
});
