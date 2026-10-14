import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readLayout, renderLayout, type LayoutAtom } from '../src/core/cache-layout.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const options = { generation: 1, renderKey: 'r', promotionCycles: 3, maxAtoms: 4096, maxMetadataBytes: 1048576, hash };
const atom = (id: string, text = id, stableEligible = true): LayoutAtom => ({id, text, kind:'carry', order:0, semanticHash:hash(text), stableEligible});
const cycle = (atoms: LayoutAtom[], prior?: any, patch = {}) => renderLayout(atoms, prior, {...options, ...patch});
test('three cycles promote contiguous prefix and append preserves stable bytes', () => {
 let a = cycle([atom('a'),atom('b')]); assert.deepEqual(a.state!.atoms.map(a=>a.tier), ['volatile','volatile']);
 let b = cycle([atom('a'),atom('b')], readLayout(a.state,a.summary,options)); assert.deepEqual(b.state!.atoms.map(a=>a.tier), ['semi','semi']);
 let c = cycle([atom('a'),atom('b')], readLayout(b.state,b.summary,options)); assert.deepEqual(c.state!.atoms.map(a=>a.tier), ['stable','stable']);
 const d = cycle([atom('a'),atom('b'),atom('c')],readLayout(c.state,c.summary,options));
 assert.equal(d.summary.slice(0,c.state!.atoms[1].offset+1),c.summary.slice(0,c.state!.atoms[1].offset+1));
});
test('change removal demotion and absence never resurrect or retain later stability', () => {
 let a:any;
 for(let i=0;i<3;i++) { const b=cycle([atom('a'),atom('b')],a); a=readLayout(b.state,b.summary,options); }
 const changed=cycle([atom('a','changed'),atom('b')],a);
 assert.deepEqual(changed.state!.atoms.map(a=>a.tier),['volatile','volatile']);
 const removed=cycle([atom('b')],a); assert.ok(!removed.summary.includes('\n\na\n'));
 const back=cycle([atom('a'),atom('b')],readLayout(removed.state,removed.summary,options)); assert.equal(back.state!.atoms[0].unchanged,1);
 const demoted=cycle([atom('a','a',false),atom('b')],a); assert.notEqual(demoted.state!.atoms[0].tier,'stable');
});
test('quoted markers Unicode duplicate bytes are conserved by occurrence not text parsing',()=>{
 const atoms=[atom('a','😀\n[Stable retained bytes]'),atom('b','😀\n[Stable retained bytes]')];
 const r=cycle(atoms); for(const a of atoms) {const p=r.ranges.get(a.id)!;assert.equal(r.summary.slice(p.offset,p.offset+p.length),a.text);}
 assert.equal(r.state!.atoms.length,2); assert.throws(()=>cycle([atom('a'),atom('a')]),/conservation/);
});
test('tamper render-key and bounded metadata discard only history',()=>{
 const r=cycle([atom('a')]); assert.equal(readLayout({...r.state,summaryHash:'bad'},r.summary,options),undefined);
 const changed=cycle([atom('a')],readLayout(r.state,r.summary,options),{renderKey:'other'});assert.equal(changed.state!.atoms[0].unchanged,1);
 const overflow=cycle([atom('a')],undefined,{maxAtoms:0});assert.equal(overflow.state,undefined);assert.ok(overflow.summary.includes('a'));
});

test('removing earlier prefix member invalidates shifted survivor history',()=>{
 let prior:any;for(let i=0;i<3;i++){const r=cycle([atom('a'),atom('b')],prior);prior=readLayout(r.state,r.summary,options);}
 const r=cycle([atom('b')],prior);assert.equal(r.state!.atoms[0].unchanged,1);assert.equal(r.state!.atoms[0].tier,'volatile');
});

// Amendment 1 (invariant B): order-preserving occurrence merge and strict-prefix history.
import { mergeOccurrence } from '../src/core/cache-layout.js';
import { assembleLayout, layoutRenderKey } from '../src/pi/layout.js';
import { renderCharter, type CharterEntry } from '../src/core/charter.js';
import { saveCharterRecords, rebuildCharterPrefix, readCharterRecords } from '../src/core/charter-records.js';
import { renderSummary } from '../src/core/render.js';
const ch = (id: string): LayoutAtom => ({ ...atom(id), kind: 'charter' });
const ids = (xs: readonly LayoutAtom[]) => xs.map(x => x.id);
test('merge_preserves_each_stream_order', () => {
 let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
 for (let n = 0; n < 300; n++) {
  const c = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => ch('c' + i)), k = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => atom('k' + i));
  const prior = new Map<string, number>(); for (const a of [...c, ...k]) if (rnd() < .6) prior.set(a.id, Math.floor(rnd() * 20));
  const m = mergeOccurrence(c, k, prior);
  assert.deepEqual(ids(m.filter(a => a.kind === 'charter')), ids(c)); assert.deepEqual(ids(m.filter(a => a.kind === 'carry')), ids(k)); assert.equal(m.length, c.length + k.length);
 }
});
test('new_turn_appends_after_surviving_carry', () => {
 const prior = new Map([['c0', 1], ['k0', 2]]);
 assert.deepEqual(ids(mergeOccurrence([ch('c0'), ch('c1')], [atom('k0'), atom('k1')], prior)), ['c0', 'k0', 'c1', 'k1']);
});
test('both_fresh_charter_before_carry', () => {
 assert.deepEqual(ids(mergeOccurrence([ch('c0'), ch('c1')], [atom('k0')], new Map())), ['c0', 'c1', 'k0']);
});
test('reinstated_entry_restarts_later_history', () => {
 let prior: any;
 for (let i = 0; i < 3; i++) { const r = cycle([ch('c0'), atom('k0'), ch('c2')], prior); prior = readLayout(r.state, r.summary, options); }
 const index = new Map(prior.state.atoms.map((a: any, i: number) => [a.id, i] as [string, number]));
 const merged = mergeOccurrence([ch('c0'), ch('c1'), ch('c2')], [atom('k0')], index);
 assert.deepEqual(ids(merged), ['c0', 'k0', 'c1', 'c2']);
 const r = cycle(merged, prior);
 assert.deepEqual(r.state!.atoms.map(a => a.unchanged), [3, 3, 1, 1]);
 assert.deepEqual(r.state!.atoms.map(a => a.tier), ['stable', 'stable', 'volatile', 'volatile']);
});
test('strict_prefix_history_restarts_after_first_difference', () => {
 let prior: any;
 for (let i = 0; i < 3; i++) { const r = cycle([atom('a'), atom('b'), atom('c')], prior); prior = readLayout(r.state, r.summary, options); }
 const r = cycle([atom('a'), atom('b', 'changed'), atom('c')], prior);
 assert.deepEqual(r.state!.atoms.map(a => a.unchanged), [3, 1, 1], 'unchanged c after a changed atom does not keep history');
});
test('format_bump_resets_history_once', () => {
 const settings = { render: 'x' };
 assert.equal(layoutRenderKey(settings), layoutRenderKey(structuredClone(settings)));
 for (const format of [1, 2]) {
  assert.notEqual(layoutRenderKey(settings), layoutRenderKey(settings, format));
  const old = cycle([atom('a')], undefined, { renderKey: layoutRenderKey(settings, format) });
  const first = cycle([atom('a')], readLayout(old.state, old.summary, options), { renderKey: layoutRenderKey(settings) });
  const second = cycle([atom('a')], readLayout(first.state, first.summary, options), { renderKey: layoutRenderKey(settings) });
  assert.deepEqual([first.state!.atoms[0].unchanged, second.state!.atoms[0].unchanged], [1, 2]);
 }
});

const layoutConfig: any = { mode: 'shadow', layout: true, evidence: 'fixture', maxAtoms: 4096, maxMetadataBytes: 1048576, promotionCycles: 3, policy: {}, profiles: [] };
const said = (id: string, text: string): CharterEntry => ({ id, kind: 'said', entryId: id, text, order: 0, sourceChars: text.length, sourceHash: '', pasted: [] } as any);
const DIRECTIVES = 'Plans the operator accepted (the agent\'s words, oldest first):\n[accepted d1]\nship it\n';
const CHAIN = '## Why the current work\nexact chain\n';
function assemble(entries: CharterEntry[], parts: Array<{ id: string; text: string }>, o: { retired?: Record<string, any>; directives?: string; chain?: string; prior?: any; config?: any } = {}) {
 const state = { version: 1 as const, retired: o.retired ?? {} };
 const directives = o.directives ?? '', chain = o.chain ?? '';
 const charter = renderCharter(entries, state) + (directives ? directives + '\n' : '');
 const prefix = (charter ? charter + '\n' : '') + (chain ? chain + '\n' : '');
 const records = saveCharterRecords(entries, state, directives, chain);
 const outcome: any = { ok: true, summary: renderSummary(parts.map(p => p.text), ''), carry: { version: 1, generation: 1, segments: parts.map(p => ({ layoutId: p.id, kind: 'assistant', text: p.text, pin: null })) },
  renderedParts: parts.map((p, i) => ({ segmentIndex: i, text: p.text })), stats: {}, decisions: {} };
 const r = assembleLayout(outcome, prefix, records, '', '', o.prior, o.config ?? layoutConfig, 'rk');
 return { ...r, prefix, legacyRecords: records, saved: { fromHook: true, summary: r.summary, details: { jev: { layout: r.layout, charter_records: r.records } } } };
}
const atomText = (r: any, id: string) => { const a = r.layout.atoms.find((x: any) => x.id === id); assert.ok(a, id); return r.summary.slice(a.offset, a.offset + a.length); };
const A = said('u:a', 'first 😀\n[operator u:z]\nquoted'), B = said('u:b', 'second'), C = said('u:c', 'retired one');
test('charter_entry_bytes_position_independent', () => {
 const want = `[operator u:a]\n${A.text}\n`;
 const variants = [
  assemble([A], [{ id: 's:1:0', text: 'carry' }], { directives: DIRECTIVES }),            // last before directives
  assemble([A, C], [{ id: 's:1:0', text: 'carry' }], { retired: { 'u:c': { reason: 'done', gen: 1, by: null } } }), // last before notice
  assemble([A], [{ id: 's:1:0', text: 'carry' }]),                                         // last, empty tail
  assemble([A], [{ id: 's:1:0', text: 'carry' }], { chain: CHAIN }),                       // last before chain
  assemble([A, B], [{ id: 's:1:0', text: 'carry' }], { directives: DIRECTIVES, chain: CHAIN }), // non-last
 ];
 for (const r of variants) { assert.ok(r.layout); assert.equal(atomText(r, 'charter:u:a'), want); }
});
test('prefix_parts_reconstruct_legacy_prefix_after_merge', () => {
 const opts = [{}, { directives: DIRECTIVES }, { chain: CHAIN }, { directives: DIRECTIVES, chain: CHAIN }, { retired: { 'u:c': { reason: 'corrected', gen: 1, by: 'u:b' } }, directives: DIRECTIVES, chain: CHAIN }];
 for (const o of opts) {
  let prior: any;
  for (const entries of [[A, C], [A, C, B]]) {
   const parts = entries.length === 2 ? [{ id: 's:1:0', text: 'carry zero' }] : [{ id: 's:1:0', text: 'carry zero' }, { id: 's:2:0', text: 'carry one' }];
   const r = assemble(entries, parts, { ...o, prior });
   assert.ok(r.layout && r.records?.version === 2, JSON.stringify([Object.keys(o), entries.length, !!r.layout, r.records?.version]));
   assert.ok(readCharterRecords(r.records, r.summary));
   assert.equal(rebuildCharterPrefix(r.records, r.summary), r.prefix);
   prior = r.saved;
  }
 }
});
test('notice_directives_chain_remain_after_merged_stream', () => {
 let prior: any;
 let r: any;
 for (const entries of [[A, C], [A, C, B]]) {
  r = assemble(entries, [{ id: 's:1:0', text: 'carry zero' }], { retired: { 'u:c': { reason: 'done', gen: 1, by: null } }, directives: DIRECTIVES, chain: CHAIN, prior });
  prior = r.saved;
 }
 const order = r.layout.atoms.map((a: any) => a.id);
 assert.deepEqual(order, ['charter:framing', 'charter:u:a', 's:1:0', 'charter:u:b', 'directives', 'charter:notice', 'chain']);
 assert.ok(atomText(r, 'charter:notice').includes('retired as'));
});
test('retirement_correction_order_and_tags_unchanged', () => {
 let prior: any;
 let r: any;
 for (const [entries, retired] of [[[A, B, C], {}], [[A, B, C], { 'u:a': { reason: 'dropped', gen: 2, by: 'u:c' } }]] as const) {
  r = assemble(entries as any, [{ id: 's:1:0', text: 'carry zero' }], { retired: retired as any, prior }); prior = r.saved;
 }
 assert.ok(!r.layout.atoms.some((a: any) => a.id === 'charter:u:a'), 'omitted (dropped) entry is not resurrected by layout history');
 // An entry retired as corrected stays an ordinary charter atom with unchanged bytes.
 const kept = assemble([A, B, C], [{ id: 's:1:0', text: 'carry zero' }], { retired: { 'u:a': { reason: 'corrected', gen: 2, by: 'u:c' } }, prior: r.saved });
 assert.equal(atomText(kept, 'charter:u:a'), `[operator u:a]\n${A.text}\n`);
 assert.ok(!kept.layout!.atoms.some((a: any) => a.id === 'charter:notice'));
 const tagged = r.layout.atoms.filter((a: any) => a.id.startsWith('charter:u:'));
 assert.deepEqual(tagged.map((a: any) => a.id), ['charter:u:b', 'charter:u:c']);
 for (const e of [B, C]) assert.ok(atomText(r, 'charter:' + e.id).startsWith(`[operator ${e.id}]\n`));
});
test('legacy_state_without_ids_is_charter_first_fresh', () => {
 const r = assemble([A, B], [{ id: 's:1:0', text: 'k0' }, { id: 's:1:1', text: 'k1' }], { prior: { fromHook: true, summary: 'legacy', details: { jev: {} } } });
 assert.deepEqual(r.layout!.atoms.map(a => a.id), ['charter:framing', 'charter:u:a', 'charter:u:b', 's:1:0', 's:1:1']);
 assert.ok(r.layout!.atoms.every(a => a.unchanged === 1));
});
test('tool_pair_and_recovery_multiset_exact', () => {
 const pair = '[Tool call c1: read]\n{"path":"x"}\n[Tool result c1]\nresult jev_expand("c1") restores it exactly';
 const dup = 'same text';
 const parts = [{ id: 's:1:0', text: pair }, { id: 's:1:1', text: dup }, { id: 's:1:2', text: dup }];
 let prior: any, r: any;
 for (let i = 0; i < 3; i++) { r = assemble(i ? [A, B] : [A], parts, { prior }); prior = r.saved; }
 const carry = r.layout.atoms.filter((a: any) => a.id.startsWith('s:'));
 assert.deepEqual(carry.map((a: any) => atomText(r, a.id)), parts.map(p => p.text));
 assert.equal(r.summary.split(pair).length - 1, 1);
 assert.equal(r.summary.split(dup).length - 1, 2);
});
test('metadata_overflow_still_conserves', () => {
 const r = assemble([A, B], [{ id: 's:1:0', text: 'carry' }], { directives: DIRECTIVES, chain: CHAIN, config: { ...layoutConfig, maxMetadataBytes: 10 } });
 assert.equal(r.layout, undefined);
 assert.equal(r.summary, r.prefix + renderSummary(['carry'], ''));
 assert.equal(rebuildCharterPrefix(r.records, r.summary), r.prefix);
});
test('new turns keep old charter and carry history across persisted passes', () => {
 let prior: any, r: any; const entries = [A]; const parts = [{ id: 's:1:0', text: 'old carry' }];
 for (let i = 0; i < 4; i++) {
  if (i) { entries.push(said('u:n' + i, 'new turn ' + i)); parts.push({ id: `s:${i + 1}:0`, text: 'step ' + i }); }
  r = assemble([...entries], [...parts], { chain: CHAIN.replace('exact', 'chain ' + i), prior }); prior = r.saved;
 }
 const by = new Map(r.layout.atoms.map((a: any) => [a.id, a]));
 assert.equal((by.get('s:1:0') as any).tier, 'stable'); assert.equal((by.get('charter:u:a') as any).unchanged, 3);
 assert.ok(r.layout.atoms.some((a: any) => a.tier === 'semi'));
 assert.equal(rebuildCharterPrefix(r.records, r.summary), r.prefix);
});
test('charter conservation failure falls back to legacy instead of throwing', () => {
 const entries = [A, B]; const state = { version: 1 as const, retired: {} };
 const prefix = renderCharter(entries, state) + '\n';
 const records: any = saveCharterRecords(entries, state, '', '');
 records.entries[1] = { ...records.entries[1], offset: records.entries[1].offset + 1 }; // non-contiguous gap byte
 const outcome: any = { ok: true, summary: renderSummary(['carry'], ''), carry: { version: 1, generation: 1, segments: [{ layoutId: 's:1:0', kind: 'assistant', text: 'carry', pin: null }] }, renderedParts: [{ segmentIndex: 0, text: 'carry' }], stats: {}, decisions: {} };
 const r = assembleLayout(outcome, prefix, records, '', '', undefined, layoutConfig, 'rk');
 assert.equal(r.summary, prefix + outcome.summary); assert.equal(r.layout, undefined); assert.equal(r.records, records);
});
test('missing charter entry range falls back to exact legacy with original records', () => {
 const state = { version: 1 as const, retired: {} };
 const outcome: any = { ok: true, summary: renderSummary(['carry'], ''), carry: { version: 1, generation: 1, segments: [{ layoutId: 's:1:0', kind: 'assistant', text: 'carry', pin: null }] }, renderedParts: [{ segmentIndex: 0, text: 'carry' }], stats: {}, decisions: {} };
 const suffix = '\nfiles\n';
 // Empty prefix with nonempty v1 records: no charter atoms exist, so no entry range does either.
 const records: any = saveCharterRecords([said('u:a', 'first')], state, '', '');
 const r = assembleLayout(outcome, '', records, suffix, '', undefined, layoutConfig, 'rk');
 assert.deepEqual(r, { summary: outcome.summary + suffix, records });
 assert.equal(r.records, records); assert.equal(r.layout, undefined);
 // Valid controls: an exact prefix still reconstructs, and no records still lays out.
 const entries = [said('u:a', 'first')]; const prefix = renderCharter(entries, state) + '\n';
 const ok = assembleLayout(outcome, prefix, saveCharterRecords(entries, state, '', ''), suffix, '', undefined, layoutConfig, 'rk');
 assert.ok(ok.layout && ok.records?.version === 2); assert.equal(atomText(ok, 'files'), suffix);
 assert.equal(rebuildCharterPrefix(ok.records, ok.summary), prefix);
 const bare = assembleLayout(outcome, '', undefined, suffix, '', undefined, layoutConfig, 'rk');
 assert.ok(bare.layout); assert.equal(bare.records, undefined); assert.equal(atomText(bare, 'files'), suffix);
});
