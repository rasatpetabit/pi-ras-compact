import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until, params } from './support/controller-fixture.js';
import { loadControllerConfig } from '../src/client/controller-config.js';
import { shadowObserver } from '../src/pi/detector.js';
import { handleCompact, reconcileCompactionEntry } from '../src/pi/extension.js';
import { testDeps, piEvent, piCtx } from './support/pi-event.js';
import { readLayout } from '../src/core/cache-layout.js';
import { rebuildCharterPrefix } from '../src/core/charter-records.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expandHome } from '../src/client/config.js';
import { flushTelemetry } from '../src/client/ledger.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const enabled=(mode:'active'|'shadow'='active')=>{const c=loadControllerConfig();assert.notEqual(c.mode,'off');return {...c,mode} as any;};
function controller(mode:'active'|'shadow'='active',tokens=3600){
 const f=fixture(); f.setConfig({...params,mode:'active'});f.grow(tokens-6000);f.branch.at(-1).message.usage={input:tokens,output:0,cacheRead:0,cacheWrite:0,totalTokens:tokens};
 f.deps.loadController=()=>enabled(mode); let arms=0,rid='';f.ctx.requestNativeCompaction=({requestId})=>{arms++;rid=requestId;return {accepted:true};};
 const observer=shadowObserver(f.deps);return Object.defineProperties({...f,observer},{arms:{get:()=>arms},rid:{get:()=>rid},calls:{get:()=>f.calls}});
}
test('active quality opportunity arms native once without prices; shadow never arms',async()=>{
 for(const mode of ['active','shadow'] as const){const f=controller(mode);f.observer.settled(f.ctx);await until(()=>f.rows.length===1);assert.equal(f.rows[0].outcome,'warranted');assert.equal(f.arms,mode==='active'?1:0);assert.equal(f.rows[0].controller.reason,'quality');if(mode==='active'){const p=f.observer.requestPolicy({origin:'extension',requestId:f.rid});assert.equal(p?.target,1260);assert.equal(p?.H,9700);f.observer.settled(f.ctx);assert.equal(f.arms,1);}}
});
test('economic unknown defers at opportunity and capability absence never direct compacts',async()=>{
 const f=controller('active',2200);f.observer.settled(f.ctx);await until(()=>f.rows.length===1);assert.equal(f.arms,0);assert.equal(f.rows[0].controller.reason,'economic_unknown_or_defer');
 const g=controller();delete g.ctx.requestNativeCompaction;g.observer.settled(g.ctx);await until(()=>g.rows.length===1);assert.equal(g.rows[0].action,'unavailable');
});
test('controller config changes during assessment discard late result',async()=>{
 const f=controller();let release:any;f.setAsk(()=>new Promise(r=>release=r));f.observer.settled(f.ctx);await until(()=>f.signals.length===1);f.deps.loadController=()=>({mode:'off'});release({answers:{}});await until(()=>f.rows.length===1);assert.equal(f.arms,0);assert.deepEqual(f.rows[0].reasons,['stale_result']);
});
test('old controller terminal cannot poison reset scope; no-op backs off without chooser',async()=>{
 const f=controller();f.observer.settled(f.ctx);await until(()=>f.arms===1);const id=f.rid;
 f.observer.requestEnd({origin:'extension',requestId:id,outcome:'no_op'},f.ctx);f.grow(100);f.observer.settled(f.ctx);await until(()=>f.rows.length===3);assert.ok(f.rows[2].reasons.includes('failure_backoff'));
 const g=controller();g.observer.settled(g.ctx);await until(()=>g.arms===1);const old=g.rid;g.observer.reset(g.ctx);g.grow(100);g.observer.requestEnd({origin:'extension',requestId:old,outcome:'failed'},g.ctx);g.observer.settled(g.ctx);await until(()=>g.rows.length===3);assert.equal(g.arms,2);g.observer.requestEnd({origin:'extension',requestId:old,outcome:'failed'},g.ctx);assert.equal(g.rows.length,3);
});
test('layout compaction retains exact charter/recovery and roundtrips across three commits',async()=>{
 const config=enabled('shadow');const deps=testDeps({loadController:()=>config});deps.config.compaction.charter=true;
 let previous:any;let state:any;
 for(let i=0;i<3;i++) {
  const branch=[{type:'message',id:'u',message:{role:'user',content:'Fix the failing auth test'}},...(previous?[{type:'compaction',id:'prior',summary:previous.summary,fromHook:true,details:previous.details}]:[])];
  const result=await handleCompact(piEvent({branchEntries:branch,preparation:{previousSummary:previous?.summary}}),piCtx(),deps);
  assert.ok(result&&'compaction' in result);previous=result.compaction;
  state=readLayout(previous.details.jev.layout,previous.summary,{maxAtoms:4096,maxMetadataBytes:1048576,hash});assert.ok(state);
  assert.ok(previous.summary.includes('Fix the failing auth test'));assert.ok(previous.summary.includes('[Tool result'));
  assert.ok(rebuildCharterPrefix(previous.details.jev.charter_records,previous.summary)!==undefined);
 }
 assert.ok(state.state.atoms.some((a:any)=>a.tier==='stable'));
});
test('fresh owned target/headroom gate cancels unsafe reduction and records unreachable target',async()=>{
 const deps=testDeps();const event=piEvent({origin:'extension',requestId:'r',reason:'threshold'});
 const r=await handleCompact(event,piCtx(),deps,10,{target:1,W:350000,H:100,minimumReduction:10});assert.deepEqual(r,{cancel:true});
 const s=await handleCompact(event,piCtx(),deps,10,{target:1,W:350000,H:900000,minimumReduction:10});assert.ok(s&&'compaction'in s);assert.equal(s.compaction.details.jev.controller.targetUnreachable,true);
});
test('identical summary attribution uses current branch request and attempt not older equality',()=>{
 const old={type:'compaction',id:'old',summary:'same',details:{jev:{requestId:'a',attempt_id:'1'}}};const newest={...old,id:'new',details:{jev:{requestId:'b',attempt_id:'2'}}};
 const ctx:any={sessionManager:{getBranch:()=>[old,newest]}};
 assert.equal(reconcileCompactionEntry(old,{origin:'extension',requestId:'b'},ctx),newest);
});

test('input branch mutation during owned compaction cancels stale content before return',async()=>{
 const deps=testDeps();let release:any;const base=deps.compact;deps.compact=async(...args:any[])=>{await new Promise(r=>release=r);return base(...args);};
 const branch:any[]=[{type:'message',id:'a',message:{role:'user',content:'original'}}];
 const ctx:any={...piCtx(),sessionManager:{getBranch:()=>branch,getLeafId:()=>branch.at(-1).id,getEntries:()=>branch,getSessionId:()=> 's'}};
 const result=handleCompact(piEvent({branchEntries:branch,origin:'extension',requestId:'r',reason:'threshold'}),ctx,deps,10,{target:1000,W:350000,H:900000,minimumReduction:10});
 await until(()=>!!release);branch[0].message.content='changed in place';release();assert.deepEqual(await result,{cancel:true});
});

test('reordered repeated layout charter offsets preserve retired notice outside stable atoms',async()=>{
 const deps=testDeps({loadController:()=>enabled('shadow')});deps.config.compaction.charter=true;
 const b:any[]=[{type:'message',id:'u',message:{role:'user',content:'keep 😀\n[Stable retained bytes]'}},{type:'message',id:'v',message:{role:'user',content:'retired'}},{type:'compaction',id:'prior',fromHook:true,summary:'old',details:{jev:{charter:{version:1,retired:{'u:v':{reason:'done',gen:1}}}}}}];
 const r=await handleCompact(piEvent({branchEntries:b}),piCtx(),deps);assert.ok(r&&'compaction'in r);
 const l:any=r.compaction.details.jev.layout;const body=l.atoms.find((a:any)=>a.id==='charter:u:u');assert.ok(body);
 assert.ok(!r.compaction.summary.slice(body.offset,body.offset+body.length).includes('retired as'));
 assert.ok(rebuildCharterPrefix(r.compaction.details.jev.charter_records,r.compaction.summary)!.includes('retired as'));
});

test('no-op requires growth even after backoff while still above working ceiling',async()=>{
 const f=controller();f.observer.settled(f.ctx);await until(()=>f.arms===1);f.observer.requestEnd({origin:'extension',requestId:f.rid,outcome:'no_op'},f.ctx);f.setNow(5000);f.grow(1);f.observer.settled(f.ctx);await until(()=>f.rows.length===3);assert.equal(f.arms,1);
});

test('captured request cannot consume after controller configuration changes',async()=>{
 const f=controller();f.observer.settled(f.ctx);await until(()=>f.arms===1);f.deps.loadController=()=>({mode:'off'});assert.equal(f.observer.minimumReduction({origin:'extension',requestId:f.rid},f.ctx),undefined);
});

test('manual equal summary uses current attempt identity instead of older event attempt',()=>{
 const old={type:'compaction',id:'old',summary:'same',details:{jev:{attempt_id:'old-attempt'}}};const current={...old,id:'new',details:{jev:{attempt_id:'current-attempt'}}};
 assert.equal(reconcileCompactionEntry(old,{fromExtension:true},{sessionManager:{getBranch:()=>[old,current]}},'current-attempt'),current);
});

test('input or tree invalidation expires owned policy even away-and-back revision',async()=>{
 const f=controller();f.observer.settled(f.ctx);await until(()=>f.arms===1);f.observer.invalidate(f.ctx);assert.equal(f.observer.minimumReduction({origin:'extension',requestId:f.rid},f.ctx),undefined);
});

test('late compacted terminal after model change cannot impose old cooldown on new accounting scope',async()=>{
 const f=controller();f.observer.settled(f.ctx);await until(()=>f.arms===1);f.mutate('model');f.observer.requestEnd({origin:'extension',requestId:f.rid,outcome:'compacted'},f.ctx);f.grow(-1400);f.observer.settled(f.ctx);await until(()=>f.rows.length===3);assert.ok(!f.rows[2].reasons.includes('cooldown'));
});

test('controller configuration change during compaction cancels result at final fresh gate',async()=>{
 const deps=testDeps({loadController:()=>enabled('active')});let release:any;const base=deps.compact;deps.compact=async(...a:any[])=>{await new Promise(r=>release=r);return base(...a);};
 const ctx:any={...piCtx(),sessionManager:{getBranch:()=>[],getLeafId:()=>null,getEntries:()=>[],getSessionId:()=> 's'}};
 const result=handleCompact(piEvent({origin:'extension',requestId:'r',reason:'threshold'}),ctx,deps,10,{target:1000,W:350000,H:900000,minimumReduction:10});await until(()=>!!release);deps.loadController=()=>({mode:'off'});release();assert.deepEqual(await result,{cancel:true});
});

// Amendment 1/1a: two-stage economic admission through the production detector and consumption hook.
import { admitCommit, type RequestPolicy } from '../src/core/cache-controller.js';
import { compareStrategies, resolveAccounting } from '../src/core/accounting-cost.js';
const fixtureRates = { input: 4, output: 15, cacheRead: .2, cacheWrite: 5 }; // explicit fixture USD/M, not runtime defaults
function economicFixture(o: { warm?: boolean; overhead?: [number, number] | null; usage?: any; tokens?: number } = {}) {
 const f = fixture(); f.setConfig({ ...params, mode: 'active' });
 Object.assign(f.ctx.model!, { api: 'fixture-api', contextWindow: 1_000_000, maxTokens: 1000, cost: fixtureRates });
 const tokens = o.tokens ?? 250000;
 f.grow(tokens - 6000);
 f.branch.at(-1).message.usage = o.usage ?? { input: 1000, cacheRead: 248000, cacheWrite: 0, output: 1000, totalTokens: tokens };
 const config = enabled();
 config.profiles = [{ provider: 'p', id: 'm', api: 'fixture-api', source: 'explicit fixture prices', cache: { warm: o.warm ?? false, eligible: true, writes: true, validForMs: 300000 },
  ...(o.overhead === null ? {} : { overhead: o.overhead ?? [.001, .002] }), assessmentOverhead: [.001, .001] }];
 f.deps.loadController = () => config;
 let arms = 0, rid = ''; f.ctx.requestNativeCompaction = ({ requestId }) => { arms++; rid = requestId; return { accepted: true }; };
 const observer = shadowObserver(f.deps);
 return Object.defineProperties({ ...f, observer, config }, { arms: { get: () => arms }, rid: { get: () => rid }, calls: { get: () => f.calls } }) as any;
}
const settle = async (f: any, rows: number) => { f.observer.settled(f.ctx); await until(() => f.rows.length === rows); return f.rows[rows - 1]; };
const regrow = (f: any, tokens: number) => { f.grow(0); f.branch.at(-1).message.usage = { input: 1000, cacheRead: tokens - 2000, cacheWrite: 0, output: 1000, totalTokens: tokens }; };
test('ordinary_input_not_treated_fixed', async () => {
 // Substantial ordinary (uncached) observed input: it is not immutable, so both arms apply cache eligibility.
 const f = economicFixture({ usage: { input: 120000, cacheRead: 129000, cacheWrite: 0, output: 1000, totalTokens: 250000 } });
 const row = await settle(f, 1);
 assert.equal(f.arms, 1); assert.equal(row.controller.kind, 'economic');
 const direct = compareStrategies({ model: resolveAccounting(fixtureRates), before: [249000, 249000], after: row.controller.screenAfter, fixed: 0, growth: [0, 1000], output: [1000, 1000], requests: 4, horizonMs: 120000, margin: .1,
  cache: { warm: false, eligible: true, writes: true, validForMs: 300000 }, overhead: [.001, .002], assessmentOverhead: [.001, .001] });
 assert.deepEqual([row.controller.continue, row.controller.compact], [direct.continue, direct.compact]);
 const asFixed = compareStrategies({ model: resolveAccounting(fixtureRates), before: [129000, 129000], after: [0, 129000], fixed: 120000, growth: [0, 1000], output: [1000, 1000], requests: 4, horizonMs: 120000, margin: .1,
  cache: { warm: false, eligible: true, writes: true, validForMs: 300000 }, overhead: [.001, .002], assessmentOverhead: [.001, .001] });
 assert.notDeepEqual(row.controller.continue, asFixed.continue, 'observed ordinary input is not charged as certified non-cacheable');
});
test('screen_requires_estimator_and_overhead_else_defers', async () => {
 const f = economicFixture(); delete f.deps.estimator; const row = await settle(f, 1);
 assert.equal(f.arms, 0); assert.deepEqual(row.controller.compact.unknownTerms, ['screen_unavailable']); assert.equal(row.controller.screenAfter, null);
 const g = economicFixture(); g.deps.estimator = async () => { throw new Error('estimator unavailable'); }; const failed = await settle(g, 1);
 assert.equal(g.arms, 0); assert.equal(failed.outcome, 'warranted', 'estimator failure is economic unknown, not an assessment failure'); assert.deepEqual(failed.controller.compact.unknownTerms, ['estimator_unavailable']);
 const h = economicFixture({ overhead: null }); const none = await settle(h, 1);
 assert.equal(h.arms, 0); assert.ok(none.controller.compact.unknownTerms.includes('decision_overhead_unknown'));
});
test('screen_target_unreachable_defers_economics', async () => {
 const f = economicFixture(); f.branch.find((e: any) => e.id === 'tail').tokens = 100000;
 const row = await settle(f, 1);
 assert.equal(f.arms, 0); assert.deepEqual(row.controller.compact.unknownTerms, ['target_unreachable']); assert.equal(row.controller.reason, 'economic_unknown_or_defer');
});
test('economic_arm_records_stage_screen_unverified', async () => {
 const f = economicFixture(); const row = await settle(f, 1);
 assert.equal(f.arms, 1); assert.equal(row.controller.stage, 'screen'); assert.equal(row.controller.savings, 'unverified');
 const p = f.observer.requestPolicy({ origin: 'extension', requestId: f.rid })!;
 assert.equal(p.kind, 'economic'); assert.equal(p.target, 87500);
 assert.deepEqual({ tokens: p.economic!.tokens, band: p.economic!.band, observedMs: p.economic!.observedMs, preparation: p.economic!.preparation, before: p.economic!.before, share: p.economic!.projectionErrorShare },
  { tokens: 250000, band: null, observedMs: 1000, preparation: [.001, .002], before: [249000, 249000], share: .15 });
 p.economic!.tokens = 1; assert.equal(f.observer.requestPolicy({ origin: 'extension', requestId: f.rid })!.economic!.tokens, 250000, 'owned policy cannot be mutated by a consumer');
 const warm = economicFixture({ warm: true }); await settle(warm, 1); assert.equal(warm.arms, 0);
});
const economicPolicy = (warm: boolean, before = 249000): RequestPolicy => ({ kind: 'economic', target: 87500, W: 350000, H: 979900, minimumReduction: 10,
 economic: { model: resolveAccounting(fixtureRates), cache: { warm, eligible: true, writes: true, validForMs: 300000 }, observedMs: Date.now(), before: [before, before], growth: [0, 1000], output: [1000, 1000], requests: 4, horizonMs: 120000, margin: .1, projectionErrorShare: .15, preparation: [.001, .002], tokens: 250000, band: null } });
const extensionEvent = () => piEvent({ origin: 'extension', requestId: 'r', reason: 'threshold' });
test('consumption_rejects_economic_candidate_cancelled_no_chooser', async () => {
 const verdicts: any[] = []; const deps = testDeps();
 const ctx: any = piCtx([], 1_048_576, new Map(), { mode: 'rpc', hasUI: true, select: async () => { throw new Error('no chooser for detector requests'); } });
 // Warm cache over a context barely above the rendered candidate: rebuilding is not robustly cheaper.
 const r = await handleCompact(extensionEvent(), ctx, deps, 10, economicPolicy(true, 40000), v => verdicts.push(v));
 assert.deepEqual(r, { cancel: true }); assert.equal(verdicts.length, 1); assert.equal(verdicts[0].verdict, 'economic_rejected');
 assert.ok(verdicts[0].afterTokens[0] > 0 && verdicts[0].afterTokens[0] < 40000, 'candidate reduced context, yet economics rejects');
 await flushTelemetry(); const rows = readFileSync(join(dirname(expandHome(deps.config.telemetry.path)), 'compactions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
 const line = rows.at(-1); assert.equal(line.reason, 'economic_rejected'); assert.equal(line.engine, 'cancelled'); assert.equal(line.admission.verdict, 'economic_rejected');
 assert.equal(deps.last, undefined, 'cancelled outcome leaves no footer result');
});
test('committed_economic_reports_admission_intervals', async () => {
 const verdicts: any[] = [];
 const r = await handleCompact(extensionEvent(), piCtx(), testDeps(), 10, economicPolicy(false), v => verdicts.push(v));
 assert.ok(r && 'compaction' in r); const P = r.compaction.estimatedTokensAfter;
 assert.equal(verdicts[0].verdict, 'economic_committed'); assert.deepEqual(verdicts[0].afterTokens, [P, Math.ceil(P * 1.15)]);
 const pure = admitCommit(economicPolicy(false), { estimatedTokensAfter: P }, Date.now());
 assert.deepEqual([verdicts[0].continue, verdicts[0].compact, verdicts[0].preparation], [pure.continue, pure.compact, pure.preparation]);
});
test('rejected_candidate_counts_overhead_and_suppresses_repeat', async () => {
 const f = economicFixture(); await settle(f, 1); assert.equal(f.arms, 1);
 const event = { origin: 'extension', requestId: f.rid };
 const rejected = admitCommit(f.observer.requestPolicy(event)!, { estimatedTokensAfter: 240000 }, 1000);
 assert.equal(rejected.verdict, 'economic_rejected');
 f.observer.admission(event, rejected); f.observer.requestEnd({ ...event, outcome: 'cancelled' }, f.ctx);
 const end = f.rows[1]; assert.equal(end.kind, 'request'); assert.equal(end.requestKind, 'economic');
 assert.deepEqual(end.admission.preparation, { low: .001, high: .002, knownSubtotal: .001, unknownTerms: [] });
 assert.equal(end.admission.verdict, 'economic_rejected'); assert.ok(!JSON.stringify(end).includes('Finish the inspection'), 'no transcript text');
 regrow(f, 251000);
 const closed = await settle(f, 3);
 assert.equal(f.arms, 1); assert.equal(f.calls, 1, 'closed screen pays no further warrant assessment');
 assert.ok(closed.reasons.includes('below_opportunity')); assert.ok(!closed.reasons.includes('failure_backoff'), 'rejection is not failure backoff');
});
test('stale_pending_disabled_busy_request_cancels_before_preparation', async () => {
 for (const kind of ['pending', 'model', 'config', 'compaction_config', 'settings', 'session']) {
  const f = economicFixture(); await settle(f, 1); assert.equal(f.arms, 1);
  f.mutate(kind);
  assert.equal(f.observer.minimumReduction({ origin: 'extension', requestId: f.rid }, f.ctx), undefined, kind);
 }
 const g = economicFixture(); await settle(g, 1); g.grow(10);
 assert.equal(g.observer.minimumReduction({ origin: 'extension', requestId: g.rid }, g.ctx), undefined, 'new input after arming');
 // Candidate staleness: branch mutated while the economic candidate renders cancels before admission.
 const deps = testDeps(); let release: any; const base = deps.compact; deps.compact = async (...a: any[]) => { await new Promise(r => release = r); return (base as any)(...a); };
 const branch: any[] = [{ type: 'message', id: 'a', message: { role: 'user', content: 'original' } }]; const verdicts: any[] = [];
 const ctx: any = { ...piCtx(), sessionManager: { getBranch: () => branch, getLeafId: () => branch.at(-1).id, getEntries: () => branch, getSessionId: () => 's' } };
 const result = handleCompact(piEvent({ branchEntries: branch, origin: 'extension', requestId: 'r', reason: 'threshold' }), ctx, deps, 10, economicPolicy(false), v => verdicts.push(v));
 await until(() => !!release); branch[0].message.content = 'changed'; release();
 assert.deepEqual(await result, { cancel: true }); assert.equal(verdicts.length, 0);
});
test('quality_request_skips_admit_commit', async () => {
 const verdicts: any[] = [];
 const quality = { ...economicPolicy(true), kind: 'quality' as const };
 const r = await handleCompact(extensionEvent(), piCtx(), testDeps(), 10, quality, v => verdicts.push(v));
 assert.ok(r && 'compaction' in r); assert.equal(verdicts.length, 0);
 const legacy: RequestPolicy = { target: 87500, W: 350000, H: 979900, minimumReduction: 10 };
 assert.ok((await handleCompact(extensionEvent(), piCtx(), testDeps(), 10, legacy, v => verdicts.push(v)) as any).compaction); assert.equal(verdicts.length, 0);
});
test('native_threshold_emergency_skips_admit_commit', async () => {
 const f = economicFixture(); await settle(f, 1);
 const native = { reason: 'threshold', requestId: f.rid };
 assert.equal(f.observer.requestPolicy(native), undefined, 'non-extension origin has no request policy');
 const verdicts: any[] = [];
 const r = await handleCompact(piEvent({ reason: 'threshold' }), piCtx(), testDeps(), undefined, f.observer.requestPolicy(native), v => verdicts.push(v));
 assert.ok(r && 'compaction' in r); assert.equal(verdicts.length, 0);
});
test('economic_no_op_keeps_failure_backoff_not_rejection', async () => {
 const f = economicFixture(); await settle(f, 1);
 f.observer.requestEnd({ origin: 'extension', requestId: f.rid, outcome: 'no_op' }, f.ctx);
 regrow(f, 290000); const next = await settle(f, 3);
 assert.ok(next.reasons.includes('failure_backoff')); assert.equal(f.arms, 1);
});
test('economic_rejection_never_blocks_urgent_quality_through_detector', async () => {
 const f = economicFixture(); await settle(f, 1);
 const event = { origin: 'extension', requestId: f.rid };
 f.observer.admission(event, admitCommit(f.observer.requestPolicy(event)!, { estimatedTokensAfter: 240000 }, 1000));
 f.observer.requestEnd({ ...event, outcome: 'cancelled' }, f.ctx);
 regrow(f, 349000); const urgent = await settle(f, 3);
 assert.equal(urgent.controller.kind, 'quality'); assert.equal(f.arms, 2);
});
test('native_manual_unchanged', async () => {
 const verdicts: any[] = [];
 const r = await handleCompact(piEvent(), piCtx(), testDeps({ loadController: () => enabled('active') }), undefined, undefined, v => verdicts.push(v));
 assert.ok(r && 'compaction' in r); assert.equal(verdicts.length, 0); assert.equal(r.compaction.details.jev.controller, undefined);
});
test('owned freshness capture failure cancels a detector request instead of disabling the gate', async () => {
 const branch: any[] = [{ type: 'message', id: 'a', message: { role: 'user', content: 'original' } }]; let reads = 0;
 const ctx: any = { ...piCtx(), sessionManager: { getBranch: () => { if (reads++ === 0) throw new Error('stale runner'); return branch; }, getLeafId: () => 'a', getEntries: () => branch, getSessionId: () => 's' } };
 const r = await handleCompact(piEvent({ branchEntries: branch, origin: 'extension', requestId: 'r', reason: 'threshold' }), ctx, testDeps(), 10, { target: 1000, W: 350000, H: 900000, minimumReduction: 10 });
 assert.deepEqual(r, { cancel: true });
});
test('deadline telemetry failure never escapes the timer into the host', async () => {
 const f = economicFixture(); f.setAsk(() => new Promise(() => {}));
 f.setConfig({ ...params, mode: 'active', requestTimeoutMs: 20 });
 const errors: unknown[] = []; const onError = (e: unknown) => errors.push(e); process.on('uncaughtException', onError);
 let writes = 0; f.deps.write = () => { writes++; throw new Error('telemetry sink unavailable'); };
 try { f.observer.settled(f.ctx); await until(() => writes >= 1); await new Promise(r => setTimeout(r, 30)); }
 finally { process.off('uncaughtException', onError); }
 assert.deepEqual(errors, []);
});
test('pre-admission cancellation of an economic request backs off boundedly and never blocks later urgency', async () => {
 const f = economicFixture(); await settle(f, 1); assert.equal(f.arms, 1);
 // Stale-fence/no-progress cancel before admission: existing failure backoff + growth suppression, not a permanent block.
 f.observer.requestEnd({ origin: 'extension', requestId: f.rid, outcome: 'cancelled' }, f.ctx);
 f.setNow(1000 + params.failureBackoffMs + 1); regrow(f, 349000);
 const urgent = await settle(f, 3);
 assert.equal(urgent.controller.kind, 'quality'); assert.equal(f.arms, 2);
});
test('revision-change expiry of an economic request imposes neither rejection nor failure backoff', async () => {
 const f = economicFixture(); await settle(f, 1);
 f.observer.requestEnd({ origin: 'extension', requestId: f.rid, outcome: 'expired', reason: 'revision_changed' }, f.ctx);
 regrow(f, 252000); const next = await settle(f, 3);
 assert.ok(!next.reasons.includes('failure_backoff'), JSON.stringify([next.reasons, next.controller])); assert.equal(next.outcome, 'warranted', 'assessed again, not suppressed'); assert.notEqual(next.controller.reason, 'economic_rejected_backoff');
});

test('layout suffix budget conservatively covers charter separators and the full assembled summary', async () => {
 const deps = testDeps({ loadController: () => enabled('shadow') }); deps.config.compaction.charter = true;
 const base = deps.compact; let charged = 0; let engineChars = 0;
 deps.compact = async (input, options, asker) => {
  const outcome = await base(input, options, asker);
  charged = input.suffixChars; engineChars = outcome.summary.length;
  return outcome;
 };
 // Many short charter entries expose separator overhead that a fixed three-heading allowance hid.
 const branch = Array.from({ length: 500 }, (_, i) => ({ type: 'message', id: `u${i}`, message: { role: 'user', content: `Keep requirement ${i}.` } }));
 const result = await handleCompact(piEvent({ branchEntries: branch }), piCtx(), deps);
 assert.ok(result && 'compaction' in result); assert.ok(result.compaction.details.jev.layout);
 assert.ok(result.compaction.summary.length <= engineChars + charged, `full render ${result.compaction.summary.length} exceeds charged budget ${engineChars + charged}`);
});
