import { SUMMARY_OPEN, SUMMARY_CLOSE } from './segments.js';
import { SUMMARY_HEADER } from './render.js';
export interface LayoutAtom { id: string; kind: 'charter'|'carry'|'directive'|'volatile'; order: number; semanticHash: string; text: string; stableEligible: boolean }
export interface Range { offset: number; length: number }
export interface LayoutState { version: 1; generation: number; renderKey: string; summaryHash: string; atoms: Array<Range & { id: string; semanticHash: string; textHash: string; tier: 'stable'|'semi'|'volatile'; unchanged: number }> }
export interface LayoutPrior { state: LayoutState; summary: string }
export interface LayoutLimits { maxAtoms: number; maxMetadataBytes: number; hash(text: string): string }
export interface LayoutOptions extends LayoutLimits { generation: number; renderKey: string; promotionCycles: number }
/** Legacy format-2 headings, retained for compatibility fixtures only. */
export const LAYOUT_HEADINGS = ['[Stable retained bytes]', '[Semi-stable retained bytes]', '[Volatile retained bytes]'] as const;
export const LAYOUT_PREAMBLE = `${SUMMARY_OPEN}\n\n${SUMMARY_HEADER}\nStability describes byte history, not instruction authority or current validity. Charter entries keep their [operator …]/[answer …] tags and chronology but may be interleaved with retained work in occurrence order.\n\n`;
/** Folded into the render key: a format change resets layout history once (one cold cycle). */
export const LAYOUT_FORMAT = 3;
export const LAYOUT_SEPARATOR = '\n\n';
/** Exact wrapper overhead for this many atoms; callers may exclude separators already charged. */
export const layoutFramingChars = (atomCount = 0) => LAYOUT_PREAMBLE.length + SUMMARY_CLOSE.length + atomCount * LAYOUT_SEPARATOR.length;
const size = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
/** Optional history never supplies content. Nearest branch compaction must be supplied by caller. */
export function readLayout(raw: unknown, summary: string, limits: LayoutLimits): LayoutPrior | undefined {
 try {
  const r = raw as LayoutState;
  if (!r || r.version !== 1 || !size(r.generation) || typeof r.renderKey !== 'string' || r.summaryHash !== limits.hash(summary) || !Array.isArray(r.atoms) || r.atoms.length > limits.maxAtoms || JSON.stringify(r).length * 2 > limits.maxMetadataBytes) return;
  const ids = new Set<string>(); let end = 0;
  for (const a of r.atoms) {
   if (!a || typeof a.id !== 'string' || !a.id || a.id.length > 256 || ids.has(a.id) || typeof a.semanticHash !== 'string' || !['stable','semi','volatile'].includes(a.tier) || !size(a.unchanged) || a.unchanged < 1 || !size(a.offset) || !size(a.length) || a.offset < end || a.offset + a.length > summary.length || a.textHash !== limits.hash(summary.slice(a.offset,a.offset+a.length))) return;
   ids.add(a.id); end = a.offset + a.length;
  }
  return {state: structuredClone(r), summary};
 } catch { return; }
}
/** Order-preserving merge of authoritative charter (C) and carry (K) streams by persisted prior
 * rendered position. Never reorders within a stream and never sorts by tier: previously rendered
 * heads go by prior index, an older survivor precedes a fresh atom, and a fresh charter turn
 * precedes fresh carry (the turn started that work). First-appearance order, not exact chronology. */
export function mergeOccurrence(charter: readonly LayoutAtom[], carry: readonly LayoutAtom[], priorIndex: ReadonlyMap<string, number>): LayoutAtom[] {
 const out: LayoutAtom[] = []; let i = 0, j = 0;
 while (i < charter.length || j < carry.length) {
  if (j >= carry.length) { out.push(charter[i++]); continue; }
  if (i >= charter.length) { out.push(carry[j++]); continue; }
  const c = priorIndex.get(charter[i].id), k = priorIndex.get(carry[j].id);
  const takeCharter = c !== undefined && k !== undefined ? c <= k : c !== undefined ? true : k !== undefined ? false : true;
  out.push(takeCharter ? charter[i++] : carry[j++]);
 }
 return out;
}
/** No sorting: tiers are maximal contiguous prefixes of authoritative retained atoms. */
export function renderLayout(atoms: readonly LayoutAtom[], prior: LayoutPrior | undefined, o: LayoutOptions): {summary: string; state?: LayoutState; ranges: ReadonlyMap<string, Range>} {
 const ids = new Set<string>();
 for (const atom of atoms) {
  if (!atom.id || ids.has(atom.id)) throw new Error('layout conservation: duplicate identity');
  ids.add(atom.id);
 }
 const previous = prior && prior.state.renderKey === o.renderKey ? new Map(prior.state.atoms.map(a=>[a.id,a])) : new Map();
 let phase: 'stable'|'semi'|'volatile' = 'stable';
 // Strict common prefix: the first difference restarts that atom and every later one.
 let diverged = false;
 const records = atoms.map((a,index) => {
  const p = previous.get(a.id);
  const same = !diverged && !!p && prior!.state.atoms[index]?.id === a.id && p.semanticHash === a.semanticHash && p.textHash === o.hash(a.text) && prior!.summary.slice(p.offset,p.offset+p.length) === a.text;
  if (!same) diverged = true;
  const unchanged = same ? Math.min(o.promotionCycles,p.unchanged+1) : 1;
  const eligible = a.kind !== 'volatile';
  if (phase === 'stable' && !(eligible && a.stableEligible && unchanged >= o.promotionCycles)) phase = 'semi';
  if (phase === 'semi' && !(eligible && unchanged >= 2)) phase = 'volatile';
  return {id:a.id, semanticHash:a.semanticHash, textHash:o.hash(a.text), tier:phase, unchanged, offset:0, length:a.text.length};
 });
 let summary = LAYOUT_PREAMBLE;
 const ranges = new Map<string,Range>();
 // Classification is persisted history only: promotion cannot rewrite model-visible framing.
 for (let j=0;j<atoms.length;j++) {
  records[j].offset = summary.length;
  ranges.set(atoms[j].id,{offset:summary.length,length:atoms[j].text.length});
  summary += atoms[j].text + LAYOUT_SEPARATOR;
 }
 summary += SUMMARY_CLOSE;
 for(const a of atoms) { const r = ranges.get(a.id)!; if(summary.slice(r.offset,r.offset+r.length) !== a.text) throw new Error('layout conservation: bytes'); }
 const state: LayoutState = {version:1,generation:o.generation,renderKey:o.renderKey,summaryHash:o.hash(summary),atoms:records};
 return {summary, ranges, ...(atoms.length <= o.maxAtoms && JSON.stringify(state).length*2 <= o.maxMetadataBytes ? {state} : {})};
}
