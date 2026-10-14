import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOpportunity, chooseCompaction, type ControllerPolicy } from '../src/core/cache-controller.js';
const policy:ControllerPolicy={workingWindowShare:.35,opportunityWorkingShare:.6,targetWorkingShare:.5,safetyWindowShare:.02,rearmWorkingShare:.1,horizonRequests:4,horizonMs:120000,growthSamples:8,economicMargin:.1,maxBandExcursionRequests:2,maxBandExcursionMs:120000,projectionErrorShare:.15};
const snapshot=(patch={})=>({leaf:'a',tokens:210000,prompt:210000,window:1000000,reserve:16384,maxTokens:0,now:0,bands:[],samples:[],afterTarget:500000,...patch});
const warranted:any={outcome:'warranted'};
const unknown:any={beneficial:false,rebuildingWorse:false};
test('1M policy separates 210K opportunity 175K reset 350K ceiling native reserve',()=>{
 const o=evaluateOpportunity(snapshot(),policy,{});assert.equal(o.evaluate,true);assert.equal(o.W,350000);assert.equal(o.target,175000);assert.equal(o.H,963616);assert.equal(o.T,983616);assert.equal(o.urgent,false);
 assert.equal(evaluateOpportunity(snapshot({tokens:null}),policy,{}).evaluate,false);
 assert.equal(evaluateOpportunity(snapshot({reserve:700000}),policy,{}).evaluate,false);
});
test('projected urgency overrides unknown costs but never unsafe warrant',()=>{
 const o=evaluateOpportunity(snapshot({tokens:340000,maxTokens:10000}),policy,{});
 assert.equal(o.urgent,true);assert.equal(chooseCompaction(o,warranted,unknown).request,true);
 assert.equal(chooseCompaction(o,{outcome:'defer'} as any,{beneficial:true} as any).request,false);
 assert.equal(chooseCompaction(evaluateOpportunity(snapshot(),policy,{}),warranted,unknown).request,false);
});
test('band projection strict boundary and bounded excursion cannot renew above band',()=>{
 assert.equal(evaluateOpportunity(snapshot({tokens:200000,prompt:272000,bands:[272000]}),policy,{}).band,null);
 const projected=evaluateOpportunity(snapshot({tokens:200000,prompt:271000,maxTokens:1000,bands:[272000]}),policy,{});assert.equal(projected.evaluate,true);
 let h:any={};
 for(let n=0;n<4;n++) {const o=evaluateOpportunity(snapshot({leaf:String(n),tokens:280000,prompt:280000,bands:[272000],now:n*1000}),policy,h);const d=chooseCompaction(o,warranted,{...unknown,rebuildingWorse:true});h=d.history;assert.equal(d.request,n>=2);}
 const expired=evaluateOpportunity(snapshot({tokens:280000,prompt:280000,bands:[272000],now:120001}),policy,{excursion:{band:272000,enteredMs:0,usedRequests:1,lastLeaf:'z'}});
 assert.equal(chooseCompaction(expired,warranted,{...unknown,rebuildingWorse:true}).request,true);
});
test('horizon bounded and unknown economics grants no excursion',()=>{
 const o=evaluateOpportunity(snapshot({tokens:280000,prompt:280000,bands:[272000],maxTokens:100}),policy,{});
 const d=chooseCompaction(o,warranted,unknown);assert.equal(d.request,false);assert.equal(d.history.excursion,undefined);assert.ok(o.horizon<=4);
});

test('every settled request consumes existing excursion even when warrant defers',()=>{
 const h:any={excursion:{band:272000,enteredMs:0,usedRequests:1,lastLeaf:'a'}};
 const o=evaluateOpportunity(snapshot({leaf:'b',tokens:280000,prompt:280000,bands:[272000]}),policy,h);
 const d=chooseCompaction(o,{outcome:'defer'} as any,unknown);
 assert.equal(d.history.excursion.usedRequests,2);
});

test('unknown prompt price evidence never blocks known working urgency',()=>{
 const o=evaluateOpportunity(snapshot({tokens:360000,prompt:null}),policy,{});assert.equal(o.urgent,true);assert.equal(chooseCompaction(o,warranted,unknown).request,true);
});

test('unreachable reset requires fresh post-commit anchor and growth before repeating quality request',()=>{
 const h:any={resetPending:true,targetUnreachable:true};
 const o=evaluateOpportunity(snapshot({tokens:360000,prompt:360000,leaf:'measured'}),policy,h);
 assert.equal(o.evaluate,false);assert.equal(o.history.resetTokens,360000);
 const same=evaluateOpportunity(snapshot({tokens:360000,prompt:360000,leaf:'next'}),policy,o.history);assert.equal(same.evaluate,false);
 const grown=evaluateOpportunity(snapshot({tokens:396000,prompt:396000,leaf:'growth'}),policy,o.history);assert.equal(grown.evaluate,true);
});

// Amendment 1/1a: economic admission-to-prepare (screen) is separate from admission-to-commit.
import { admitCommit, type EconomicCommitInput, type RequestPolicy } from '../src/core/cache-controller.js';
import { compareStrategies, resolveAccounting } from '../src/core/accounting-cost.js';
// Explicit fixture prices (USD per million), not runtime defaults: the documented illustrative 4/.2/5 plus explicit output 15.
const fixtureModel = resolveAccounting({ input: 4, output: 15, cacheRead: .2, cacheWrite: 5 });
const economic = (patch: Partial<EconomicCommitInput> = {}): EconomicCommitInput => ({ model: fixtureModel, cache: { warm: false, eligible: true, writes: true, validForMs: 300000 },
 observedMs: 1000, before: [249000, 249000], growth: [0, 1000], output: [1000, 1000], requests: 4, horizonMs: 120000, margin: .1, projectionErrorShare: .15,
 preparation: [.001, .002], tokens: 250000, band: null, ...patch });
const economicPolicy = (patch: Partial<EconomicCommitInput> = {}): RequestPolicy => ({ kind: 'economic', target: 87500, W: 350000, H: 979900, minimumReduction: 10, economic: economic(patch) });
const round = (v: number | null) => v === null ? null : Math.round(v * 1000) / 1000;
test('admit_commit_certifies_reachable_candidate', () => {
 const ok = admitCommit(economicPolicy(), { estimatedTokensAfter: 150000 }, 1000);
 assert.equal(ok.verdict, 'economic_committed');
 assert.deepEqual([round(ok.continue.low), round(ok.continue.high)], [5.04, 5.064]);
 assert.deepEqual([round(ok.compact.low), round(ok.compact.high)], [3.06, 3.534]);
 assert.deepEqual(ok.afterTokens, [150000, 172500]);
 assert.equal(admitCommit(economicPolicy(), { estimatedTokensAfter: 190000 }, 1000).verdict, 'economic_committed');
 const weak = admitCommit(economicPolicy(), { estimatedTokensAfter: 200000 }, 1000);
 assert.equal(weak.verdict, 'economic_rejected'); assert.deepEqual([round(weak.compact.low), round(weak.compact.high)], [4.06, 4.684]);
 const warm = admitCommit(economicPolicy({ cache: { warm: true, eligible: true, writes: true, validForMs: 300000 } }), { estimatedTokensAfter: 87500 }, 1000);
 assert.equal(warm.verdict, 'economic_rejected'); assert.deepEqual([round(warm.continue.low), round(warm.continue.high)], [.259, .283]);
});
test('admit_commit_missing_economic_input_unknown', () => {
 const { economic: _drop, ...plain } = economicPolicy();
 assert.equal(admitCommit(plain as RequestPolicy, { estimatedTokensAfter: 1000 }, 1000).verdict, 'economic_unknown');
 for (const bad of [NaN, -1, Infinity]) assert.equal(admitCommit(economicPolicy(), { estimatedTokensAfter: bad }, 1000).verdict, 'economic_unknown');
 assert.equal(admitCommit(economicPolicy(), { estimatedTokensAfter: 1000 }, 999).verdict, 'economic_unknown', 'clock before observation is not evidence');
});
test('admit_commit_rejects_when_candidate_not_robustly_cheaper', () => {
 // A near-tie inside the margin rejects; the projection error widens the candidate upward only.
 const near = admitCommit(economicPolicy({ projectionErrorShare: 0 }), { estimatedTokensAfter: 228000 }, 1000);
 assert.equal(near.verdict, 'economic_rejected');
 assert.ok(near.compact.high! < near.continue.low!, 'cheaper but not by the configured margin');
});
test('admit_commit_excludes_sunk_preparation_but_reports_it', () => {
 const cheap = admitCommit(economicPolicy({ preparation: [0, 0] }), { estimatedTokensAfter: 150000 }, 1000);
 const costly = admitCommit(economicPolicy({ preparation: [5, 9] }), { estimatedTokensAfter: 150000 }, 1000);
 assert.equal(costly.verdict, 'economic_committed', 'sunk preparation is identical in both arms');
 assert.deepEqual(costly.compact, cheap.compact);
 assert.deepEqual(costly.preparation, { low: 5, high: 9, knownSubtotal: 5, unknownTerms: [] });
});
test('admit_commit_ages_cache_past_valid_ms_to_cold', () => {
 const warm = { warm: true, eligible: true, writes: true, validForMs: 300000 };
 assert.equal(admitCommit(economicPolicy({ cache: warm }), { estimatedTokensAfter: 150000 }, 1000).verdict, 'economic_rejected');
 // Remaining validity below the horizon: warm is no longer known, both scenarios count.
 const partial = admitCommit(economicPolicy({ cache: warm }), { estimatedTokensAfter: 150000 }, 1000 + 250000);
 assert.equal(partial.verdict, 'economic_rejected');
 assert.ok(partial.continue.high! > 5, 'aged validity exposes the cold scenario');
 const expired = admitCommit(economicPolicy({ cache: warm }), { estimatedTokensAfter: 150000 }, 1000 + 300000);
 assert.equal(expired.verdict, 'economic_committed');
 const direct = compareStrategies({ model: fixtureModel, before: [249000, 249000], after: [150000, 172500], fixed: 0, growth: [0, 1000], output: [1000, 1000], requests: 4, horizonMs: 120000, margin: .1, cache: { ...warm, warm: false }, overhead: [0, 0], assessmentOverhead: [0, 0] });
 assert.deepEqual(expired.compact, direct.compact);
});
test('admit_commit_unknown_prices_reject', () => {
 const r = admitCommit(economicPolicy({ model: resolveAccounting({ input: 4, output: 15, cacheRead: 0, cacheWrite: null }) }), { estimatedTokensAfter: 1000 }, 1000);
 assert.equal(r.verdict, 'economic_unknown'); assert.equal(r.compact.high, null);
});
const below = (tokens: number, history = {}) => evaluateOpportunity(snapshot({ tokens, prompt: tokens, maxTokens: 1000, leaf: String(tokens) }), policy, history);
const beneficial: any = { beneficial: true, rebuildingWorse: false };
test('decision_kind_recorded', () => {
 assert.equal(chooseCompaction(below(220000), warranted, beneficial).kind, 'economic');
 assert.equal(chooseCompaction(below(220000), warranted, unknown).kind, null);
 assert.equal(chooseCompaction(evaluateOpportunity(snapshot({ tokens: 340000, maxTokens: 10000 }), policy, {}), warranted, unknown).kind, 'quality');
 const expired = evaluateOpportunity(snapshot({ tokens: 280000, prompt: 280000, bands: [272000], now: 120001 }), policy, { excursion: { band: 272000, enteredMs: 0, usedRequests: 1, lastLeaf: 'z' } });
 assert.equal(chooseCompaction(expired, warranted, unknown).kind, 'excursion');
 assert.equal(below(220000).tokens, 220000);
});
test('economic_rejection_closes_screen_until_growth_or_band_change', () => {
 const h = { economicRejection: { tokens: 220000, band: null } };
 assert.equal(chooseCompaction(below(220000, h), warranted, beneficial).request, false);
 assert.equal(chooseCompaction(below(220000, h), warranted, beneficial).reason, 'economic_rejected_backoff');
 assert.equal(below(220000, h).evaluate, false, 'closed screen does not pay another warrant assessment');
 assert.equal(chooseCompaction({ ...below(255000), history: h } as any, warranted, beneficial).request, false, 'surviving record never re-arms');
 assert.equal(chooseCompaction(below(254999, h), warranted, beneficial).request, false, 'growth below rearm share of W');
 assert.equal(chooseCompaction(below(255000, h), warranted, beneficial).kind, 'economic', 'reopens at >= rearm share of W');
 const banded = evaluateOpportunity(snapshot({ tokens: 230000, prompt: 280000, bands: [272000], maxTokens: 1000 }), policy, h);
 assert.equal(chooseCompaction(banded, warranted, beneficial).kind, 'economic', 'band change reopens');
});
test('economic_rejection_cleared_on_token_decrease', () => {
 const o = below(215000, { economicRejection: { tokens: 220000, band: null } });
 assert.equal(o.history.economicRejection, undefined);
 assert.equal(chooseCompaction(o, warranted, beneficial).request, true);
});
test('economic_rejection_never_blocks_urgent_quality', () => {
 const o = evaluateOpportunity(snapshot({ tokens: 340000, maxTokens: 10000 }), policy, { economicRejection: { tokens: 339000, band: null } });
 const d = chooseCompaction(o, warranted, unknown); assert.equal(d.request, true); assert.equal(d.kind, 'quality');
});
test('economic_rejections_bounded_per_cycle', () => {
 // Every screen is rejected at commit; settled counts only rise within one compaction cycle.
 let h: any = {}, rejections = 0;
 for (let tokens = 200000; tokens < 350000; tokens += 1000) {
  const o = evaluateOpportunity(snapshot({ tokens, prompt: tokens, maxTokens: 0, leaf: String(tokens) }), policy, h);
  const d = chooseCompaction(o, warranted, beneficial); h = d.history;
  if (d.kind === 'economic') { rejections++; h = { ...h, economicRejection: { tokens, band: o.band } }; }
 }
 assert.equal(rejections, Math.ceil((1 - policy.opportunityWorkingShare) / policy.rearmWorkingShare));
});
test('economic_rejection_survives_unknown_usage_turn', () => {
 const h = { economicRejection: { tokens: 220000, band: 272000 } };
 const unknownTokens = evaluateOpportunity(snapshot({ tokens: null, prompt: null, bands: [272000] }), policy, h);
 assert.deepEqual(unknownTokens.history.economicRejection, h.economicRejection, 'missing usage is neither growth nor a band change');
 const unknownPrompt = evaluateOpportunity(snapshot({ tokens: 221000, prompt: null, bands: [272000] }), policy, h);
 assert.deepEqual(unknownPrompt.history.economicRejection, h.economicRejection, 'unknown prompt is not a band change');
 assert.equal(unknownPrompt.evaluate, false);
});
