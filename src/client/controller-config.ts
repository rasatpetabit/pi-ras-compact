import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { defaultConfigPath } from './config.js';
import { TERMS, type AccountingProfile, type Band, type Rates } from '../core/accounting-cost.js';
export interface ControllerPolicy {
 workingWindowShare:number; opportunityWorkingShare:number; targetWorkingShare:number; safetyWindowShare:number; rearmWorkingShare:number;
 horizonRequests:number; horizonMs:number; growthSamples:number; economicMargin:number; maxBandExcursionRequests:number; maxBandExcursionMs:number;
 /** Provisional upper uncertainty on a rendered candidate's projected tokens; policy, not a measured bound. */
 projectionErrorShare:number;
}
export type ControllerConfig = {mode:'off'} | {mode:'shadow'|'active';layout:boolean;evidence:string;maxAtoms:number;maxMetadataBytes:number;promotionCycles:number;policy:ControllerPolicy;profiles:AccountingProfile[]};
const record=(v:any):v is Record<string,any>=>v!==null && typeof v==='object' && !Array.isArray(v);
const positive=(v:any)=>typeof v==='number' && Number.isFinite(v) && v>0;
const text=(v:any)=>typeof v==='string' && !!v.trim() && !/[\0*]/.test(v);
const integer=(v:any,max:number)=>Number.isSafeInteger(v)&&v>0&&v<=max;
const costPair=(v:any)=>Array.isArray(v)&&v.length===2&&!v.some((x:any)=>typeof x!=='number'||!Number.isFinite(x)||x<0)&&!(v[0]>v[1]);
const keys=(r:any,allowed:string[])=>record(r)&&Object.keys(r).every(k=>allowed.includes(k));
const policyFields:Record<string,keyof ControllerPolicy>={working_window_share:'workingWindowShare',opportunity_working_share:'opportunityWorkingShare',target_working_share:'targetWorkingShare',safety_window_share:'safetyWindowShare',rearm_working_share:'rearmWorkingShare',horizon_requests:'horizonRequests',horizon_ms:'horizonMs',growth_samples:'growthSamples',economic_margin:'economicMargin',max_band_excursion_requests:'maxBandExcursionRequests',max_band_excursion_ms:'maxBandExcursionMs',projection_error_share:'projectionErrorShare'};
export function validateControllerConfig(raw:unknown):{config?:ControllerConfig;errors:string[]} {
 const bad=()=>({errors:['controller_invalid']});const r=raw as any;
 if(!keys(r,['mode','layout','evidence','max_atoms','max_metadata_bytes','promotion_cycles','policy','profiles'])) return bad();
 if(r.mode==='off') return {config:{mode:'off'},errors:[]};
 if(!['shadow','active'].includes(r.mode)||typeof r.layout!=='boolean'||!text(r.evidence)||!integer(r.max_atoms,4096)||!integer(r.max_metadata_bytes,1048576)||!integer(r.promotion_cycles,32)||r.promotion_cycles<3||!keys(r.policy,Object.keys(policyFields))) return bad();
 const p:any=Object.fromEntries(Object.entries(policyFields).map(([k,v])=>[v,r.policy[k]]));
 if(Object.entries(p).some(([k,v])=>k==='projectionErrorShare' ? typeof v!=='number'||!Number.isFinite(v)||v<0||v>=1 : !positive(v))) return bad();
 if(['workingWindowShare','opportunityWorkingShare','targetWorkingShare','safetyWindowShare','rearmWorkingShare'].some(k=>p[k]>=1) || p.targetWorkingShare>=p.opportunityWorkingShare || p.workingWindowShare+p.safetyWindowShare>=1 || p.rearmWorkingShare>p.opportunityWorkingShare-p.targetWorkingShare+Number.EPSILON || !integer(p.horizonRequests,4)||!integer(p.horizonMs,120000)||!integer(p.growthSamples,64)||!integer(p.maxBandExcursionRequests,2)||!integer(p.maxBandExcursionMs,120000)||p.economicMargin>1) return bad();
 const profiles:AccountingProfile[]=[];const routes=new Set<string>();
 if(r.profiles!==undefined && !Array.isArray(r.profiles)) return bad();
 for(const q of r.profiles ?? []) {
  if(!keys(q,['provider','id','api','source','units','rates','bands','working_ceiling','cache','overhead','assessment_overhead'])||![q.provider,q.id,q.api,q.source].every(text)) return bad();
  const route=JSON.stringify([q.provider,q.id,q.api]);if(routes.has(route)) return bad();routes.add(route);
  const rates=(v:any):v is Rates=>keys(v,[...TERMS]) && Object.values(v).every(positive);
  if(q.rates!==undefined && (q.units!=='USD_per_million_tokens'||!rates(q.rates))) return bad();
  if(q.working_ceiling!==undefined && !integer(q.working_ceiling,Number.MAX_SAFE_INTEGER)) return bad();
  const bands:Band[]=[];
  if(q.bands!==undefined && !Array.isArray(q.bands)) return bad();
  for(const b of q.bands ?? []) {
   if(!keys(b,['input_tokens_above','rates','multiplier','terms'])||!Number.isSafeInteger(b.input_tokens_above)||b.input_tokens_above<0||(bands.length && b.input_tokens_above<=bands.at(-1)!.inputTokensAbove)) return bad();
   if(b.rates) {if(q.units!=='USD_per_million_tokens'||!rates(b.rates)||TERMS.slice(0,4).some(t=>!positive(b.rates[t]))||b.multiplier!==undefined||b.terms!==undefined) return bad();}
   else if(!positive(b.multiplier)||!Array.isArray(b.terms)||!b.terms.length||new Set(b.terms).size!==b.terms.length||b.terms.some((t:any)=>!TERMS.includes(t))) return bad();
   bands.push({inputTokensAbove:b.input_tokens_above,...(b.rates?{rates:b.rates}:{multiplier:b.multiplier,terms:b.terms})});
  }
  if(q.cache!==undefined && (!keys(q.cache,['warm','writes','eligible','validForMs','minimumTokens','granularity'])||['warm','writes','eligible'].some(k=>typeof q.cache[k]!=='boolean')||!integer(q.cache.validForMs,Number.MAX_SAFE_INTEGER)||(q.cache.minimumTokens!==undefined&&!integer(q.cache.minimumTokens,Number.MAX_SAFE_INTEGER))||(q.cache.granularity!==undefined&&!integer(q.cache.granularity,Number.MAX_SAFE_INTEGER)))) return bad();
  if(q.assessment_overhead!==undefined && !costPair(q.assessment_overhead)) return bad();
  if(q.overhead!==undefined && !costPair(q.overhead)) return bad();
  profiles.push({provider:q.provider,id:q.id,api:q.api,source:q.source,...(q.rates?{rates:q.rates}:{}),...(bands.length?{bands}:{}),...(q.working_ceiling?{workingCeiling:q.working_ceiling}:{}),...(q.cache?{cache:q.cache}:{}),...(q.overhead?{overhead:q.overhead}:{}),...(q.assessment_overhead?{assessmentOverhead:q.assessment_overhead}:{})});
 }
 return {config:{mode:r.mode,layout:r.layout,evidence:r.evidence,maxAtoms:r.max_atoms,maxMetadataBytes:r.max_metadata_bytes,promotionCycles:r.promotion_cycles,policy:p,profiles},errors:[]};
}
export const controllerPath=(path:string)=>path.replace(/\.toml$/,'')+'.controller.toml';
export function selectProfile(config:ControllerConfig,route:{provider?:string;id?:string;api?:string}):AccountingProfile|undefined {
 return config.mode==='off'?undefined:config.profiles.find(p=>p.provider===route.provider&&p.id===route.id&&p.api===route.api);
}
let cache:{path:string;text:string;config:ControllerConfig}|undefined;const noted=new Set<string>();
export function loadControllerConfig(path=defaultConfigPath()):ControllerConfig {
 const sibling=controllerPath(path);try {
  const text=readFileSync(sibling,'utf8');if(cache?.path===sibling&&cache.text===text)return structuredClone(cache.config);
  const checked=validateControllerConfig(parse(text));if(!checked.config)throw new Error('invalid');
  cache={path:sibling,text,config:checked.config};return structuredClone(checked.config);
 }catch(e){cache=undefined;if((e as NodeJS.ErrnoException).code!=='ENOENT'&&!noted.has(sibling)){noted.add(sibling);process.stderr.write('[pi-jev] controller config unreadable or malformed; controller off\n');}return {mode:'off'};}
}
