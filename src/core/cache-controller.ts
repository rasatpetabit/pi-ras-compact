import type { ControllerPolicy } from '../client/controller-config.js';
import { compareStrategies, type AccountingModel, type CacheEvidence, type CostEstimate, type StrategyComparison } from './accounting-cost.js';
import type { WarrantResult } from './warrant.js';
export type { ControllerPolicy };
export interface ControllerSnapshot { leaf:string;tokens:number|null;prompt:number|null;window:number;reserve:number;maxTokens:number|null;now:number;bands:readonly number[];samples:readonly number[];afterTarget:number;workingCeiling?:number }
export interface ControllerHistory { excursion?: {band:number;enteredMs:number;usedRequests:number;lastLeaf:string}; resetTokens?:number; resetPending?:boolean; targetUnreachable?:boolean; economicRejection?:{tokens:number;band:number|null} }
export interface Opportunity { tokens:number|null;evaluate:boolean;urgent:boolean;reason:string;W:number;H:number;T:number;target:number;horizon:number;growth:number|null;band:number|null;projectedBand:number|null;now:number;leaf:string;policy:ControllerPolicy;history:ControllerHistory;excursionExpired:boolean }
export type RequestKind = 'quality'|'excursion'|'economic';
/** Captured atomically at the sole arm site from the inputs the passing economic screen used. */
export interface EconomicCommitInput { model:AccountingModel; cache:CacheEvidence; observedMs:number; before:readonly [number,number]; growth:readonly [number,number]; output:readonly [number,number]; requests:number; horizonMs:number; margin:number; projectionErrorShare:number; preparation:readonly [number,number]; tokens:number; band:number|null }
export interface RequestPolicy {kind?:RequestKind;target:number;W:number;H:number;minimumReduction:number;economic?:EconomicCommitInput}
export interface ControllerDecision {request:boolean;reason:string;kind:RequestKind|null;history:ControllerHistory;target:number;W:number;H:number;minimumReduction:number}
export type CommitVerdict = 'economic_committed'|'economic_rejected'|'economic_unknown';
export interface CommitAdmission {verdict:CommitVerdict;continue:CostEstimate;compact:CostEstimate;preparation:CostEstimate;afterTokens:[number,number]|null}
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export function evaluateOpportunity(s:ControllerSnapshot,p:ControllerPolicy,history:ControllerHistory):Opportunity {
 const T=s.window-s.reserve,H=T-p.safetyWindowShare*s.window,W=s.workingCeiling??p.workingWindowShare*s.window;
 const target=Math.min(s.afterTarget,p.targetWorkingShare*W);
 const deltas=s.samples.slice(-p.growthSamples).filter(count);
 const growth=count(s.maxTokens)?Math.max(s.maxTokens,...deltas,0):deltas.length?Math.max(...deltas):null;
 const horizon=growth!==null&&growth>0&&count(s.tokens)?Math.max(1,Math.min(p.horizonRequests,Math.ceil(Math.max(0,W-s.tokens)/growth))):p.horizonRequests;
 const projected=count(s.tokens)?s.tokens+(growth??0)*horizon:null;
 const band=count(s.prompt)?[...s.bands].reverse().find(b=>s.prompt!>b)??null:null;
 const projectedBand=count(s.prompt)&&growth!==null?[...s.bands].reverse().find(b=>s.prompt!+growth*horizon>b)??null:band;
 let h=structuredClone(history);
 // Context fell by another path (e.g. quality/native compaction): the rejected state is gone.
 if(h.economicRejection && count(s.tokens) && s.tokens<h.economicRejection.tokens) delete h.economicRejection;
 if(h.resetPending && count(s.tokens)){h.resetTokens=s.tokens;h.resetPending=false;}
 if(h.excursion && count(s.prompt) && s.prompt < h.excursion.band-p.rearmWorkingShare*W) delete h.excursion;
 if(h.excursion && band!==null && h.excursion.lastLeaf!==s.leaf){h.excursion.usedRequests++;h.excursion.lastLeaf=s.leaf;}
 const expired=!!h.excursion && (h.excursion.usedRequests>=p.maxBandExcursionRequests||s.now-h.excursion.enteredMs>=p.maxBandExcursionMs);
 const valid=count(s.tokens)&&count(s.now)&&count(s.window)&&s.window>0&&count(s.reserve)&&W>0&&W<H&&H<T&&target>0;
 const urgent=valid&&projected!==null&&(projected>=W||projected>=H);
 const rearmed=h.resetTokens===undefined||!count(s.tokens)||s.tokens-h.resetTokens>=p.rearmWorkingShare*W;
 const hardUrgency=valid && projected!==null && projected>=H;
 const repeatAllowed=!h.targetUnreachable || rearmed || hardUrgency;
 // A commit-time economic rejection closes economic evaluation (and its assessment cost) until
 // settled growth by the rearm share of W or a band change; urgency and excursion expiry bypass it.
 const rejection=h.economicRejection;
 // Missing usage is neither growth nor a band change: unknown keeps the screen closed.
 const closed=!!rejection&&(!count(s.tokens)||!count(s.prompt)||(rejection.band===band&&s.tokens<rejection.tokens+p.rearmWorkingShare*W));
 if(rejection&&!closed) delete h.economicRejection;
 const evaluate=valid&&repeatAllowed&&(urgent||expired||(!closed&&(((rearmed||band!==null||projectedBand!==null)&&projected!>=p.opportunityWorkingShare*W)||projectedBand!==band)));
 return {tokens:count(s.tokens)?s.tokens:null,evaluate,urgent,reason:!valid?'limits_or_usage_unknown':urgent?'working_or_headroom':expired?'excursion_expired':evaluate?'opportunity':closed?'economic_rejected_backoff':'below_opportunity',W,H,T,target,horizon,growth,band,projectedBand,now:s.now,leaf:s.leaf,policy:p,history:h,excursionExpired:expired};
}
/** Quality wins over economics, never over the semantic/structural warrant. */
export function chooseCompaction(o:Opportunity,w:WarrantResult,c:StrategyComparison):ControllerDecision {
 let history=structuredClone(o.history);let request=false,reason=o.reason,kind:RequestKind|null=null;
 // Defense in depth for evaluateOpportunity's closure: a surviving rejection never re-arms economics.
 const screenClosed=!!history.economicRejection;
 if(o.evaluate && w.outcome==='warranted') {
  if(o.urgent||o.excursionExpired) {request=true;reason=o.urgent?'quality':'excursion_expired';kind=o.urgent?'quality':'excursion';}
  else if(c.beneficial&&screenClosed){reason='economic_rejected_backoff';}
  else if(c.beneficial){request=true;reason='economic';kind='economic';}
  else if(o.band!==null&&c.rebuildingWorse){
   if(!history.excursion) history.excursion={band:o.band,enteredMs:o.now,usedRequests:0,lastLeaf:o.leaf};
   if(history.excursion.lastLeaf!==o.leaf){history.excursion.usedRequests++;history.excursion.lastLeaf=o.leaf;}
   reason='bounded_excursion';
  }else reason='economic_unknown_or_defer';
 }else if(w.outcome!=='warranted') reason='warrant_required';
 return {request,reason,kind,history,target:o.target,W:o.W,H:o.H,minimumReduction:0};
}
const nonnegative=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const unknownCost=(reason:string):CostEstimate=>({low:null,high:null,knownSubtotal:0,unknownTerms:[reason]});
/** Stage 2: certify an economic request against the freshly rendered candidate's FULL projected
 * context. Preparation is sunk (identical in both arms) and only reported; cache evidence ages
 * from the settled observation, so expiry before commit selects the cold scenario. Pure. */
export function admitCommit(policy:RequestPolicy,candidate:{estimatedTokensAfter:number},now:number):CommitAdmission {
 const e=policy.economic;
 const preparation:CostEstimate=e && e.preparation.length===2 && e.preparation.every(nonnegative) && e.preparation[0]<=e.preparation[1]
  ? {low:e.preparation[0],high:e.preparation[1],knownSubtotal:e.preparation[0],unknownTerms:[]} : unknownCost('preparation_unknown');
 const P=candidate.estimatedTokensAfter, age=e ? now-e.observedMs : NaN;
 if(!e || !nonnegative(P) || !nonnegative(age) || !nonnegative(e.projectionErrorShare) || e.projectionErrorShare>=1)
  return {verdict:'economic_unknown',continue:unknownCost('economic_input_unknown'),compact:unknownCost('economic_input_unknown'),preparation,afterTokens:null};
 const afterTokens:[number,number]=[P,Math.ceil(P*(1+e.projectionErrorShare))];
 const remaining=e.cache.validForMs===null ? null : Math.max(0,e.cache.validForMs-age);
 const cache:CacheEvidence={...e.cache,validForMs:remaining,...(e.cache.validForMs!==null && age>=e.cache.validForMs ? {warm:false} : {})};
 const c=compareStrategies({model:e.model,before:e.before,after:afterTokens,fixed:0,growth:e.growth,output:e.output,requests:e.requests,horizonMs:e.horizonMs,margin:e.margin,cache,overhead:[0,0],assessmentOverhead:[0,0]});
 const verdict:CommitVerdict=c.beneficial ? 'economic_committed' : c.continue.low===null || c.compact.high===null ? 'economic_unknown' : 'economic_rejected';
 return {verdict,continue:c.continue,compact:c.compact,preparation,afterTokens};
}
