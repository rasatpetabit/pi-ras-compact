import { resolveAccounting, type AccountingUsage, type CacheEvidence } from '../core/accounting-cost.js';
import { selectProfile, type ControllerConfig } from '../client/controller-config.js';
import type { DetectorContext } from './detector.js';
const count=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
/** Only normalized same-model settled usage and accounting fields, never auth/account state. */
export function captureAccounting(ctx:DetectorContext,branch:readonly any[],config:ControllerConfig,now:number) {
 const m=ctx.model;const leaf=branch.find(e=>e.id===ctx.sessionManager.getLeafId());
 const message=leaf?.message;
 const u=message?.role==='assistant'&&message.stopReason==='stop'&&message.provider===m?.provider&&message.model===m?.id ? message.usage : undefined;
 const usage:AccountingUsage={input:count(u?.input),output:count(u?.output),cacheRead:count(u?.cacheRead),cacheWrite:count(u?.cacheWrite),cacheWrite1h:u?.cacheWrite1h===undefined?0:count(u.cacheWrite1h)};
 const terms=[usage.input,usage.cacheRead,usage.cacheWrite,usage.cacheWrite1h];
 const prompt=terms.every(v=>v!==null)?terms.reduce<number>((n,v)=>n+v!,0):null;
 const profile=selectProfile(config,m??{});
 const cache:CacheEvidence=profile?.cache?{...profile.cache,warm:usage.cacheRead!==null&&usage.cacheRead>0?profile.cache.warm:null}: {warm:usage.cacheRead!==null&&usage.cacheRead>0?true:null,writes:null,eligible:null,validForMs:null};
 return {usage,prompt:prompt!==null&&Number.isFinite(prompt)?prompt:null,model:resolveAccounting(m?.cost,profile),profile,cache,maxTokens:count(m?.maxTokens),observedMs:now};
}
