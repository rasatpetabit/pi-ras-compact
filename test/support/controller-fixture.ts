import assert from 'node:assert/strict';
import { shadowObserver, detectorQuestionLimit, type DetectorDeps, type DetectorContext } from '../../src/pi/detector.js';
import { loadConfig } from '../../src/client/config.js';
import type { WarrantParams } from '../../src/core/warrant.js';
import { fakeEstimator } from './estimator.js';
// Synthetic parameters, never production calibration/defaults.
export const params: WarrantParams = { mode: 'shadow', pressureFloor: .5, minCandidateTokens: 10,
  maxSampleTokens: 5000, minReclaimTokens: 10, minSafeBoundary: .8, minNetReductionTokens: 10,
  rearmGrowthTokens: 100, cooldownMs: 100, failureBackoffMs: 200, requestTimeoutMs: 2000, calibration: 'test-only' };
const tick = () => new Promise<void>(r => setImmediate(r));
export async function until(check: () => boolean) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } throw new Error('test wait expired'); }
function gate() { let release!: (value?: any) => void; const promise = new Promise<any>(r => { release = r; }); return { promise, release }; }
export function fixture() {
  const loaded = loadConfig(undefined, { backend: false }); assert.ok(loaded.ok);
  let config: any = { ...params }, compaction: any = structuredClone(loaded), now = 1000, calls = 0, adapters = 0, pending = false, idle = true;
  const result = { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'obsolete output '.repeat(100) }], isError: false, timestamp: 1 };
  const span = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'file.txt' } }], timestamp: 1 }, result,
    { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 1 }];
  const branch: any[] = [{ type: 'message', id: 'operator', message: { role: 'user', content: 'Finish the inspection.' } }, ...span.map((message, i) => ({ type: 'message', id: `e${i}`, message })), { type: 'message', id: 'tail', message: { role: 'assistant', content: 'completed', stopReason: 'stop', provider: 'p', model: 'm', usage: { totalTokens: 6000 } } }];
  let session = 's', leaf = 'tail', model = { provider: 'p', id: 'm', contextWindow: 10000 }, tokens: number | null = 6000;
  let settings: any = { compaction: { keepRecentTokens: 100, reserveTokens: 100, enabled: true } };
  const rows: any[] = [], signals: AbortSignal[] = [], asked: any[] = [];
  let ask: (state: any, questions: any) => Promise<any> = async (_s, questions) => ({ answers: Object.fromEntries(Object.entries(questions).map(([id, q]: any) => [id, q.type === 'choice' ? { type: 'choice', choice: 'safe', probabilities: { safe: .9, live: .05, uncertain: .05 }, confidence: .2 } : { type: 'noul', noul: 0 }])) });
  const ctx: DetectorContext = { cwd: '/test', get model() { return model; }, sessionManager: { getSessionId: () => session, getLeafId: () => leaf, getBranch: () => branch, getEntries: () => branch },
    getContextUsage: () => ({ tokens, contextWindow: model.contextWindow }), isIdle: () => idle, hasPendingMessages: () => pending };
  Object.defineProperty(ctx, 'compact', { get() { throw new Error('NO compaction ever'); } });
  Object.defineProperty(ctx, 'ui', { get() { throw new Error('NO chat notifications'); } });
  const deps: DetectorDeps = { loadDetector: () => structuredClone(config), loadCompaction: () => structuredClone(compaction), getSettings: () => structuredClone(settings),
    native: async () => { adapters++; return { prepare: () => ({ firstKeptEntryId: 'tail', messagesToSummarize: span, turnPrefixMessages: [] }), systemText: () => '', settings: () => settings.compaction }; },
    // Production register() always supplies Pi's estimator; tests that need it absent delete it.
    estimator: async () => fakeEstimator(),
    inputLimit: async () => null, questionLimit: detectorQuestionLimit, now: () => now, fallbackLogDir: '/fallback/telemetry', write: row => rows.push(row),
    makeAsker: (_config, _hash, signal) => { signals.push(signal); return { ask: async (state, questions) => { calls++; asked.push({ state, questions }); return ask(state, questions); }, backend_descriptor: { id: 'test', model: 'fixture' } } as any; } };
  const observer = shadowObserver(deps);
  return { observer, ctx, deps, rows, signals, asked, branch, get calls() { return calls; }, get adapters() { return adapters; },
    setConfig(v: any) { config = v; }, setLoaded(v: any) { compaction = v; }, setAsk(fn: typeof ask) { ask = fn; }, setNow(n: number) { now = n; },
    grow(n = 100) { tokens = tokens! + n; leaf += 'x'; branch.push({ type: 'message', id: leaf, message: { ...branch.find(e => e.id === 'tail').message, usage: { input:tokens,output:0,cacheRead:0,cacheWrite:0,totalTokens: tokens } } }); },
    mutate(kind: string) { if (kind === 'session') session += 'x'; else if (kind === 'model') model.id += 'x'; else if (kind === 'config') config.pressureFloor = .1;
      else if (kind === 'compaction_config') compaction.hash += 'x'; else if (kind === 'settings') settings.compaction.keepRecentTokens++;
      else if (kind === 'tree') branch[1].message.content[0].name = 'edited'; else if (kind === 'usage') { tokens = null; branch.find(e => e.id === leaf).message.usage = undefined; } else if (kind === 'pending') pending = true; else if (kind === 'busy') idle = false; },
  };
}
