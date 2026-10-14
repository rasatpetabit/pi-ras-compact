export const TERMS = ['input','output','cacheRead','cacheWrite','cacheWrite1h'] as const;
export type Term = typeof TERMS[number];
export type Rates = Partial<Record<Term, number|null>>;
export interface Band { inputTokensAbove: number; rates?: Rates; multiplier?: number; terms?: Term[] }
export interface AccountingProfile { provider?: string; id?: string; api?: string; source: string; rates?: Rates; bands?: Band[]; workingCeiling?: number; cache?: CacheEvidence; overhead?: readonly [number,number]; assessmentOverhead?: readonly [number,number] }
export interface AccountingModel { rates: Rates; bands: Band[]; longTtlWrites?:boolean }
export type AccountingUsage = Record<Term, number|null>;
export interface CostEstimate { low: number|null; high: number|null; knownSubtotal: number; unknownTerms: string[] }
export interface CacheEvidence { warm: boolean|null; writes: boolean|null; eligible: boolean|null; validForMs: number|null; minimumTokens?: number; granularity?: number }
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const ratesOf = (raw: any): Rates => Object.fromEntries(TERMS.map(t=>[t,positive(raw?.[t]) ? raw[t] : null]));
/** Runtime ModelCost uses absolute request-wide rates; explicit profiles alone add multipliers. */
export function resolveAccounting(runtime: unknown, profile?: AccountingProfile): AccountingModel {
 const r = runtime as any;
 const rates = {...ratesOf(r),...profile?.rates};
 const bands: Band[] = Array.isArray(r?.tiers) ? r.tiers.map((t:any)=>({inputTokensAbove:t.inputTokensAbove,rates:{...ratesOf(t),...profile?.rates}})) : [];
 if(bands.some((b,i)=>!Number.isSafeInteger(b.inputTokensAbove)||b.inputTokensAbove<0||(i>0 && b.inputTokensAbove<=bands[i-1].inputTokensAbove))) return {rates:ratesOf(null),bands:[]};
 return {rates,bands:profile?.bands ?? bands};
}
export function accountRequest(usage: AccountingUsage, model: AccountingModel): CostEstimate {
 const unknownTerms: string[]=[];let knownSubtotal=0;
 const promptTerms: Term[]=['input','cacheRead','cacheWrite','cacheWrite1h'];
 const total=promptTerms.every(t=>nonnegative(usage[t])) ? promptTerms.reduce((n,t)=>n+usage[t]!,0) : null;
 let rates={...model.rates};
 if(total===null || !Number.isFinite(total)) { if(model.bands.length) unknownTerms.push('band_input_unknown'); }
 else {
  const b=[...model.bands].reverse().find(b=>total>b.inputTokensAbove);
  if(b?.rates) rates={...b.rates};
  if(b?.multiplier) for(const t of b.terms ?? []) rates[t]=positive(rates[t]) ? rates[t]! * b.multiplier : null;
 }
 for(const t of TERMS) {
  const n=usage[t]; if(n===0) continue;
  if(t==='cacheWrite1h' && !model.longTtlWrites){unknownTerms.push('cacheWrite1h_unsupported');continue;}
  const rate=rates[t]; const cost=positive(rate) && nonnegative(n) ? n * rate / 1000000 : null;
  if(cost===null || !nonnegative(cost) || !Number.isFinite(knownSubtotal+cost)) unknownTerms.push(t);
  else knownSubtotal+=cost;
 }
 return {low:unknownTerms.length ? null : knownSubtotal,high:unknownTerms.length ? null : knownSubtotal,knownSubtotal,unknownTerms};
}
export interface StrategyInput { model: AccountingModel; before: readonly [number,number]; after: readonly [number,number]; fixed: number; growth: readonly [number,number]; output: readonly [number,number]; requests: number; horizonMs: number; margin: number; cache: CacheEvidence; overhead: readonly [number,number]|null; /** Required: null (or an omitted value at runtime) is unknown, [0,0] is explicitly none. */ assessmentOverhead: readonly [number,number]|null }
export interface StrategyComparison { continue: CostEstimate; compact: CostEstimate; beneficial: boolean; rebuildingWorse: boolean; scenarios: number }
const unknown = (reason:string): CostEstimate => ({low:null,high:null,knownSubtotal:0,unknownTerms:[reason]});
/** Identical low/high growth and output scenarios, plus cold/warm expiry uncertainty.
 * First rebuilt prompt never reads preserved cache. Overhead is incremental compact work. */
export function compareStrategies(i: StrategyInput): StrategyComparison {
 const invalid = [i.before,i.after,i.growth,i.output].some(r=>r.length!==2 || !r.every(nonnegative) || r[0]>r[1]) || !nonnegative(i.fixed) || !Number.isSafeInteger(i.requests) || i.requests<1 || i.requests>64 || !nonnegative(i.horizonMs) || !nonnegative(i.margin);
 if(invalid) return {continue:unknown('scenario_invalid'),compact:unknown('scenario_invalid'),beneficial:false,rebuildingWorse:false,scenarios:0};
 // Endpoint interval evaluation is valid only for nondecreasing rate schedules.
 // Unsupported discount/reversal profiles fail economic comparison, not quality policy.
 let previousRates = {...i.model.rates};
 for(const band of i.model.bands) {
  const nextRates = band.rates ? {...band.rates} : {...i.model.rates};
  if(band.multiplier) for(const term of band.terms ?? []) nextRates[term] = positive(nextRates[term]) ? nextRates[term]! * band.multiplier : null;
  if(TERMS.some(term=>positive(previousRates[term]) && positive(nextRates[term]) && nextRates[term]! < previousRates[term]!)) return {continue:unknown('nonmonotone_bands'),compact:unknown('nonmonotone_bands'),beneficial:false,rebuildingWorse:false,scenarios:0};
  previousRates=nextRates;
 }
 if(i.cache.minimumTokens!==undefined && [i.before,i.after].some(r=>r[0]<i.cache.minimumTokens! && r[1]>=i.cache.minimumTokens!)) return {continue:unknown('cache_threshold_uncertain'),compact:unknown('cache_threshold_uncertain'),beneficial:false,rebuildingWorse:false,scenarios:0};
 if((i.cache.granularity??1)>1 && [i.before,i.after].some(r=>Math.floor(r[0]/i.cache.granularity!)!==Math.floor(r[1]/i.cache.granularity!))) return {continue:unknown('cache_granularity_uncertain'),compact:unknown('cache_granularity_uncertain'),beneficial:false,rebuildingWorse:false,scenarios:0};
 const totals: {continue: CostEstimate[];compact: CostEstimate[]}={continue:[],compact:[]};
 const warmKnown=i.cache.warm===true && i.cache.eligible===true && i.cache.validForMs!==null && i.cache.validForMs>=i.horizonMs;
 const warms=warmKnown ? [true] : i.cache.warm===false || i.cache.eligible===false ? [false] : [false,true];
 for(const high of [0,1]) for(const warm of warms) for(const arm of ['continue','compact'] as const) {
  let sum=0;const reasons=new Set<string>();
  if(i.cache.eligible===null || (i.cache.eligible!==false && i.cache.writes===null)) reasons.add('cache_capability_unknown');
  for(let n=0;n<i.requests;n++) {
   const prefix=(arm==='continue'?i.before:i.after)[high];
   const eligible=i.cache.eligible===true && prefix >= (i.cache.minimumTokens ?? 0);
   const granularity=i.cache.granularity ?? 1;
   const cached=eligible ? Math.floor(prefix/granularity)*granularity : 0;
   const rebuilt=arm==='compact' && n===0;
   const read=warm && eligible && !rebuilt ? cached : 0;
   const write=read===0 && eligible && i.cache.writes===true ? cached : 0;
   const u: AccountingUsage={input:i.fixed+prefix-read-write+n*i.growth[high],cacheRead:read,cacheWrite:write,cacheWrite1h:0,output:i.output[high]};
   const c=accountRequest(u,i.model);c.unknownTerms.forEach(t=>reasons.add(t));sum+=c.knownSubtotal;
  }
  // Omitted (undefined) is unknown like null: shared assessment work is never free.
  if(i.assessmentOverhead===null || i.assessmentOverhead===undefined) reasons.add('assessment_overhead_unknown');
  else if(i.assessmentOverhead) {if(i.assessmentOverhead.every(nonnegative)&&i.assessmentOverhead[0]<=i.assessmentOverhead[1])sum+=i.assessmentOverhead[high];else reasons.add('assessment_overhead_invalid');}
  if(arm==='compact') { if(i.overhead && i.overhead.every(nonnegative) && i.overhead[0]<=i.overhead[1]) sum+=i.overhead[high];else reasons.add('decision_overhead_unknown'); }
  if(!Number.isFinite(sum)) reasons.add('overflow');
  totals[arm].push({low:reasons.size?null:sum,high:reasons.size?null:sum,knownSubtotal:Number.isFinite(sum)?sum:0,unknownTerms:[...reasons]});
 }
 const aggregate=(xs:CostEstimate[]):CostEstimate=>({low:xs.some(x=>x.low===null)?null:Math.min(...xs.map(x=>x.low!)),high:xs.some(x=>x.high===null)?null:Math.max(...xs.map(x=>x.high!)),knownSubtotal:Math.min(...xs.map(x=>x.knownSubtotal)),unknownTerms:[...new Set(xs.flatMap(x=>x.unknownTerms))]});
 const c=aggregate(totals.continue),k=aggregate(totals.compact);
 return {continue:c,compact:k,beneficial:k.high!==null && c.low!==null && k.high*(1+i.margin)<c.low,rebuildingWorse:k.low!==null && c.high!==null && k.low>c.high*(1+i.margin),scenarios:totals.continue.length};
}
