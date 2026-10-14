import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccounting, accountRequest, compareStrategies } from '../src/core/accounting-cost.js';
const runtime={input:4,output:8,cacheRead:0.2,cacheWrite:5};
const usage=(patch={})=>({input:0,output:0,cacheRead:0,cacheWrite:0,cacheWrite1h:0,...patch});
test('request wide tiers use strict boundary and disjoint inputs',()=>{
 const m=resolveAccounting({...runtime,tiers:[{inputTokensAbove:272000,input:8,output:16,cacheRead:0.4,cacheWrite:10}]});
 assert.ok(Math.abs(accountRequest(usage({cacheRead:272000}),m).high!-.0544)<1e-12);
 assert.ok(Math.abs(accountRequest(usage({input:1,cacheRead:272000}),m).high!-.108808)<1e-12);
});
test('explicit selected-term bands never infer auth or model name',()=>{
 const m=resolveAccounting(runtime,{source:'fixture',bands:[{inputTokensAbove:272000,multiplier:2,terms:['input']}]});
 assert.equal(accountRequest(usage({input:300000,cacheRead:100000}),m).high,2.42);
});
test('unknown zero partial nonfinite overflow and unsupported long TTL are not free',()=>{
 for(const input of [0,null,Infinity,undefined]) assert.equal(accountRequest(usage({input:1}),resolveAccounting({...runtime,input})).high,null);
 assert.equal(accountRequest(usage({input:0}),resolveAccounting({})).high,0);
 assert.equal(accountRequest(usage({input:null}),resolveAccounting(runtime)).high,null);
 assert.equal(accountRequest(usage({cacheWrite1h:1}),resolveAccounting(runtime)).high,null);
 assert.equal(accountRequest(usage({input:Number.MAX_VALUE}),resolveAccounting({input:Number.MAX_VALUE})).high,null);
});
test('cold rebuilt first request write-only, then reads: 23/24/25 fixture crossover',()=>{
 for(const [n,c,k] of [[23,.92,.94],[24,.96,.96],[25,1,.98]]) {
 const r=compareStrategies({model:resolveAccounting(runtime),before:[200000,200000],after:[100000,100000],fixed:0,growth:[0,0],output:[0,0],requests:n,margin:0,cache:{warm:true,writes:true,eligible:true,validForMs:1000000},horizonMs:1000,overhead:[0,0],assessmentOverhead:[0,0]});
 assert.ok(Math.abs(r.continue.high!-c)<1e-12);assert.ok(Math.abs(r.compact.high!-k)<1e-12);
 assert.equal(r.beneficial,n===25);
 }
});
test('unknown expiry widens cold/warm interval and missing overhead defers',()=>{
 const args={model:resolveAccounting(runtime),before:[200000,200000] as const,after:[100000,200000] as const,fixed:100,growth:[0,100] as const,output:[10,20] as const,requests:4,margin:.1,cache:{warm:true,writes:true,eligible:true,validForMs:null},horizonMs:1000,overhead:null,assessmentOverhead:[0,0] as const};
 const r=compareStrategies(args); assert.equal(r.compact.high,null);assert.equal(r.beneficial,false);assert.ok(r.continue.high!>r.continue.low!);
});

test('unknown cache eligibility or write capability cannot collapse cost interval to ordinary input',()=>{
 const r=compareStrategies({model:resolveAccounting(runtime),before:[200000,200000],after:[100000,100000],fixed:0,growth:[0,0],output:[0,0],requests:4,horizonMs:1000,margin:0,cache:{warm:true,writes:null,eligible:null,validForMs:null},overhead:[0,0],assessmentOverhead:[0,0]});assert.equal(r.compact.high,null);assert.ok(r.compact.unknownTerms.includes('cache_capability_unknown'));
});

test('explicit overrides apply to runtime tier missing rates and long TTL still needs capability',()=>{
 const model=resolveAccounting({...runtime,tiers:[{inputTokensAbove:100,input:null,output:null,cacheRead:null,cacheWrite:null}]},{source:'override',rates:{input:4,cacheWrite1h:6}});
 assert.equal(accountRequest(usage({input:200}),model).high,.0008);
 assert.equal(accountRequest(usage({cacheWrite1h:1}),model).high,null);
});

test('non-cacheable fixed input survives both strategy arms and rebuild never charges same-request read',()=>{
 const r=compareStrategies({model:resolveAccounting(runtime),before:[200000,200000],after:[100000,100000],fixed:50000,growth:[0,0],output:[0,0],requests:1,horizonMs:1000,margin:0,cache:{warm:true,writes:true,eligible:true,validForMs:120000},overhead:[.01,.01],assessmentOverhead:[0,0]});
 assert.ok(Math.abs(r.continue.high!-.24)<1e-12);assert.ok(Math.abs(r.compact.high!-.71)<1e-12);
});

test('shared assessment overhead is charged in totals without inventing free compute',()=>{
 const r=compareStrategies({model:resolveAccounting(runtime),before:[200000,200000],after:[100000,100000],fixed:0,growth:[0,0],output:[0,0],requests:1,horizonMs:1000,margin:0,cache:{warm:true,writes:true,eligible:true,validForMs:120000},overhead:[.01,.01],assessmentOverhead:[.02,.02]});assert.ok(Math.abs(r.continue.high!-.06)<1e-12);assert.ok(Math.abs(r.compact.high!-.53)<1e-12);
});

test('nonmonotone request-wide bands cannot report endpoint-only false savings',()=>{
 const model=resolveAccounting({input:4,output:8,cacheRead:.2,cacheWrite:5,tiers:[{inputTokensAbove:120000,input:1,output:1,cacheRead:.01,cacheWrite:.1},{inputTokensAbove:180000,input:4,output:8,cacheRead:.2,cacheWrite:5}]});
 const r=compareStrategies({model,before:[100000,200000],after:[100000,200000],fixed:0,growth:[0,0],output:[0,0],requests:4,horizonMs:1000,margin:0,cache:{warm:true,writes:true,eligible:true,validForMs:120000},overhead:[0,0],assessmentOverhead:[0,0]});assert.equal(r.beneficial,false);assert.equal(r.continue.high,null);assert.ok(r.continue.unknownTerms.includes('nonmonotone_bands'));
});

test('cache eligibility threshold crossed by uncertain prefix cannot claim endpoint-only costs',()=>{
 const r=compareStrategies({model:resolveAccounting(runtime),before:[100000,200000],after:[100000,200000],fixed:0,growth:[0,0],output:[0,0],requests:4,horizonMs:1000,margin:0,cache:{warm:true,writes:true,eligible:true,minimumTokens:150000,validForMs:120000},overhead:[0,0],assessmentOverhead:[0,0]});assert.equal(r.continue.high,null);assert.ok(r.continue.unknownTerms.includes('cache_threshold_uncertain'));
});

test('uncertain granular cache boundary cannot overstate monotone endpoint savings',()=>{
 const r=compareStrategies({model:resolveAccounting(runtime),before:[999,1001],after:[999,1001],fixed:0,growth:[0,0],output:[0,0],requests:4,horizonMs:1000,margin:0,cache:{warm:true,writes:true,eligible:true,granularity:1000,validForMs:120000},overhead:[0,0],assessmentOverhead:[0,0]});assert.equal(r.continue.high,null);assert.ok(r.continue.unknownTerms.includes('cache_granularity_uncertain'));
});
test('omitted assessment overhead is unknown, never free',()=>{
 const base:any={model:resolveAccounting(runtime),before:[200000,200000],after:[1000,1000],fixed:0,growth:[0,0],output:[0,0],requests:4,horizonMs:1000,margin:0,cache:{warm:false,writes:true,eligible:true,validForMs:1000},overhead:[0,0]};
 const r=compareStrategies(base);assert.equal(r.beneficial,false);assert.equal(r.compact.high,null);assert.ok(r.compact.unknownTerms.includes('assessment_overhead_unknown'));
 assert.equal(compareStrategies({...base,assessmentOverhead:[0,0]}).beneficial,true,'explicit known zero still compares');
});

test('partial profile rate override leaves unpriced terms unknown, never free',()=>{
 const model=resolveAccounting(undefined,{source:'fixture partial override',rates:{input:4}});
 const r=accountRequest({input:1000,cacheRead:0,cacheWrite:0,cacheWrite1h:0,output:10},model);
 assert.equal(r.high,null);assert.ok(r.unknownTerms.includes('output'));
 const c=compareStrategies({model,before:[1000,1000],after:[10,10],fixed:0,growth:[0,0],output:[10,10],requests:4,horizonMs:1000,margin:0,cache:{warm:false,writes:true,eligible:true,validForMs:1000},overhead:[0,0],assessmentOverhead:[0,0]});
 assert.equal(c.beneficial,false);assert.equal(c.compact.high,null);
});
