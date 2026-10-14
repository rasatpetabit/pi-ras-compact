/** Additive, versioned offsets into the saved summary, in UTF-16 code units (String.slice).
 * No duplicated transcript text. Unknown/malformed versions are absent, not fatal. */
import { createHash } from 'node:crypto';
import { CHARTER_HEADER, CHARTER_PREAMBLE, renderCharter, shownInCharter, type CharterEntry, type CharterState } from './charter.js';

export interface LegacyCharterRecords {
  version: 1;
  prefixLength: number;
  charterLength: number;
  directivesLength: number;
  entries: Array<{ id: string; kind: 'said' | 'answered'; offset: number; length: number }>;
}
export interface TieredCharterRecords {
  version: 2; summaryHash: string; summaryLength: number;
  prefixParts: Array<{ offset: number; length: number }>;
  entries: LegacyCharterRecords['entries'];
}
export type CharterRecords = LegacyCharterRecords | TieredCharterRecords;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const CHARTER_PREFIX = `${CHARTER_HEADER}\n${CHARTER_PREAMBLE}\n\n`;
export function saveTieredCharterRecords(summary: string, prefixParts: TieredCharterRecords['prefixParts'], entries: TieredCharterRecords['entries'], hash = digest): TieredCharterRecords {
  return { version: 2, summaryHash: hash(summary), summaryLength: summary.length, prefixParts, entries };
}
export function saveCharterRecords(entries: readonly CharterEntry[], state: CharterState,
  directivesText: string, chainText: string): CharterRecords {
  const charter = renderCharter(entries, state);
  const live = entries.filter(e => shownInCharter(e.id, state));
  let offset = CHARTER_PREFIX.length;
  const records = live.map(e => {
    const length = `[${e.kind === 'said' ? 'operator' : 'answer'} ${e.id}]\n${e.text}`.length;
    const r = { id: e.id, kind: e.kind, offset, length };
    offset += length + 2;
    return r;
  });
  const directivesLength = directivesText ? directivesText.length + 1 : 0;
  const charterAndDirectives = charter.length + directivesLength;
  return { version: 1, prefixLength: charterAndDirectives + (charterAndDirectives ? 1 : 0) + (chainText ? chainText.length + 1 : 0),
    charterLength: charter.length, directivesLength, entries: records };
}
export function readCharterRecords(raw: unknown, summary: string): CharterRecords | undefined {
  if (!raw || typeof raw !== 'object') return;
  const r = raw as LegacyCharterRecords;
  const size = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if ((raw as TieredCharterRecords).version === 2) {
    const t = raw as TieredCharterRecords;
    const range = (p: any) => p && size(p.offset) && size(p.length) && p.offset + p.length <= summary.length;
    if (t.summaryLength !== summary.length || t.summaryHash !== digest(summary) || !Array.isArray(t.prefixParts) || !Array.isArray(t.entries) || t.prefixParts.length > 16384 || t.entries.length > 4096 || !t.prefixParts.every(range)) return;
    const sorted=[...t.prefixParts].sort((a,b)=>a.offset-b.offset);
    if(sorted.some((p,i)=>i>0 && p.offset<sorted[i-1].offset+sorted[i-1].length)) return;
    const ids = new Set<string>();
    for (const e of t.entries) {
      if (!range(e) || !t.prefixParts.some(p=>e.offset>=p.offset&&e.offset+e.length<=p.offset+p.length) || typeof e.id !== 'string' || ids.has(e.id) || !['said','answered'].includes(e.kind) || !summary.slice(e.offset,e.offset+e.length).startsWith(`[${e.kind === 'said' ? 'operator' : 'answer'} ${e.id}]\n`)) return;
      ids.add(e.id);
    }
    return t;
  }
  if (r.version !== 1 || !size(r.prefixLength) || !size(r.charterLength) || !size(r.directivesLength)
    || r.prefixLength > summary.length || r.charterLength + r.directivesLength > r.prefixLength || !Array.isArray(r.entries)) return;
  let end = CHARTER_PREFIX.length;
  const ids = new Set<string>();
  for (const e of r.entries) {
    if (!e || typeof e.id !== 'string' || ids.has(e.id) || !['said', 'answered'].includes(e.kind)
      || !size(e.offset) || !size(e.length) || e.offset !== end || e.offset + e.length >= r.charterLength
      || !summary.slice(e.offset, e.offset + e.length).startsWith(`[${e.kind === 'said' ? 'operator' : 'answer'} ${e.id}]\n`)) return;
    ids.add(e.id); end = e.offset + e.length + 2;
  }
  if (r.entries.length && r.charterLength < end - 1) return;
  if (r.entries.length && !summary.startsWith(CHARTER_PREFIX)) return;
  if (!r.entries.length && r.charterLength !== 0) return;
  return r;
}
export function rebuildCharterPrefix(raw: unknown, summary: string): string | undefined {
  const r = readCharterRecords(raw, summary);
  return r ? r.version === 1 ? summary.slice(0, r.prefixLength) : r.prefixParts.map(p => summary.slice(p.offset,p.offset+p.length)).join('') : undefined;
}
