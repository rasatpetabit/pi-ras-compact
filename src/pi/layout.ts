import { createHash } from 'node:crypto';
import { readLayout, renderLayout, mergeOccurrence, LAYOUT_FORMAT, type LayoutAtom, type LayoutState } from '../core/cache-layout.js';
import { saveTieredCharterRecords, type CharterRecords } from '../core/charter-records.js';
import { renderSummary } from '../core/render.js';
import type { CompactOutcome } from '../core/prune.js';
import type { ControllerConfig } from '../client/controller-config.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Render key over rendering settings plus the layout format; format 1 reproduces the pre-amendment key. */
export function layoutRenderKey(settings:unknown,format=LAYOUT_FORMAT):string{return hash(JSON.stringify(format===1?settings:{layoutFormat:format,settings}));}
/** Layout consumes finished retained bytes, never prior content. Numeric provenance, no heading parsing. */
export function assembleLayout(outcome:CompactOutcome, charterPrefix:string, records:CharterRecords|undefined, suffix:string, goal:string, prior:any, config:Exclude<ControllerConfig,{mode:'off'}>,renderKey:string): {summary:string;layout?:LayoutState;records?:CharterRecords} {
 const legacy=charterPrefix+outcome.summary+suffix;
 if(!outcome.renderedParts || (charterPrefix && (!records || records.version!==1))) return {summary:legacy,records};
 const atoms:LayoutAtom[]=[];const prefixIds:string[]=[];
 const add=(id:string,text:string,kind:LayoutAtom['kind'],semantic:unknown,eligible:boolean)=>{if(!text)return;atoms.push({id,text,kind,order:atoms.length,semanticHash:hash(JSON.stringify(semantic)),stableEligible:eligible});};
 // Exact legacy slices; offsets are writer-owned, not user headings. prefixIds keep legacy order.
 // An entry atom is exactly `[tag id]\n<text>\n` wherever it renders. Its blank-line separator,
 // when present, is owned by the entry's prefix part as the first byte of the joiner after it.
 const ownsSeparator=new Set<string>();
 if(records?.version===1 && charterPrefix) {
  let start=0;
  for(const [i,e] of records.entries.entries()) {
   if(i===0){add('charter:framing',charterPrefix.slice(0,e.offset),'charter','framing',true);prefixIds.push('charter:framing');}
   const end=e.offset+e.length+1;
   if(charterPrefix[end-1]!=='\n') return {summary:legacy,records};
   add('charter:'+e.id,charterPrefix.slice(e.offset,end),'charter',{id:e.id,kind:e.kind},true);prefixIds.push('charter:'+e.id);
   start=end;
   if(charterPrefix[end]==='\n'){ownsSeparator.add('charter:'+e.id);start=end+1;}
  }
  const charterEnd=records.charterLength;
  if(start<charterEnd){add('charter:notice',charterPrefix.slice(start,charterEnd),'volatile','notice',false);prefixIds.push('charter:notice');}
  const directivesStart=Math.max(start,charterEnd);
  if(records.directivesLength){add('directives',charterPrefix.slice(directivesStart,charterEnd+records.directivesLength),'directive','directives',false);prefixIds.push('directives');}
  const rest=charterPrefix.slice(Math.max(start,charterEnd+records.directivesLength));
  if(rest){add('chain',rest,'volatile','chain',false);prefixIds.push('chain');}
 }
 const carries:LayoutAtom[]=[];
 for(const p of outcome.renderedParts) {
  const s=outcome.carry.segments[p.segmentIndex];if(!s?.layoutId) return {summary:legacy,records};
  carries.push({id:s.layoutId,text:p.text,kind:'carry',order:0,semanticHash:hash(JSON.stringify(s)),stableEligible:true});
 }
 const limits={maxAtoms:config.maxAtoms,maxMetadataBytes:config.maxMetadataBytes,hash};
 const previous=prior?.fromHook?readLayout(prior.details?.jev?.layout,prior.summary,limits):undefined;
 // Persisted rendered order is the occurrence order; a different render key starts fresh (charter first).
 const priorIndex=new Map<string,number>(previous?.state.renderKey===renderKey?previous.state.atoms.map((a,i)=>[a.id,i] as [string,number]):[]);
 // Canonical: framing, occurrence merge of charter entries and carry, directives, dynamic suffix.
 const framing=atoms.filter(a=>a.id==='charter:framing');
 const ordered=[...framing,...mergeOccurrence(atoms.filter(a=>a.kind==='charter'&&a.id!=='charter:framing'),carries,priorIndex),...atoms.filter(a=>a.kind==='directive'),...atoms.filter(a=>a.kind==='volatile')];
 if(!records && goal.trim())ordered.push({id:'goal',kind:'volatile',order:ordered.length,text:`Ongoing goal: ${goal.trim().replace(/\n[ \t]*\n+/g,'\n')}`,semanticHash:hash(goal),stableEligible:false});
 if(suffix)ordered.push({id:'files',kind:'volatile',order:ordered.length,text:suffix,semanticHash:hash(suffix),stableEligible:false});
 // Validate exact engine parts before replacing its wrapper. No guessed truncation rendering.
 if(renderSummary(outcome.renderedParts.map(p=>p.text),records ? "" : goal)!==outcome.summary)return {summary:legacy,records};
 const result=renderLayout(ordered,previous,{...limits,generation:outcome.carry.generation,renderKey,promotionCycles:config.promotionCycles});
 if(!result.state) return {summary:legacy,records};
 let saved:CharterRecords|undefined;
 if(records?.version===1){
  const prefixParts=prefixIds.map(id=>{const r=result.ranges.get(id)!;return r&&ownsSeparator.has(id)?{offset:r.offset,length:r.length+1}:r;}).filter(Boolean);
  // Provenance that cannot reconstruct the exact legacy prefix never ships: legacy output instead.
  if(prefixParts.map(p=>result.summary.slice(p.offset,p.offset+p.length)).join('')!==charterPrefix)return {summary:legacy,records};
  // Every saved entry needs its laid-out range; a missing one is unprovable provenance: legacy output.
  const entries=[];
  for(const e of records.entries){const r=result.ranges.get('charter:'+e.id);if(!r)return {summary:legacy,records};entries.push({...e,offset:r.offset,length:e.length});}
  saved=saveTieredCharterRecords(result.summary,prefixParts,entries);
 }
 return {summary:result.summary,layout:result.state,records:saved};
}
