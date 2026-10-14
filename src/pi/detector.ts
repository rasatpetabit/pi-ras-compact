import { captureAccounting } from './accounting.js';
import { compareStrategies } from '../core/accounting-cost.js';
import { evaluateOpportunity, chooseCompaction, type Opportunity, type ControllerHistory, type RequestPolicy, type EconomicCommitInput, type CommitAdmission } from '../core/cache-controller.js';
import { computeBudget, type Estimator } from './context-budget.js';
import type { ControllerConfig } from '../client/controller-config.js';
import { capturedTail, TAIL_PROFILE } from '../core/tail.js';
import { sessionIdOf } from './session.js';
import { settledProviderTokens } from '../core/provider-usage.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import type { CoreAsker } from '../core/judge.js';
import { assessWarrant, type SnapshotIdentity, type WarrantSnapshot } from '../core/warrant.js';
import type { DetectorConfig } from '../client/detector-config.js';
import { coreOptions, effectiveAskerModel, expandHome, type ConfigResult, type JevConfig } from '../client/config.js';
import { backendDescriptor, type BackendDescriptor } from '../client/backend-descriptor.js';
import { appendJsonLine } from '../client/ledger.js';
import { spanToSegments, validateCarry } from '../core/segments.js';
import { convertMessages } from '../vendor/pi-jev/compaction/convert.js';
import { collectToolCalls } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { boundaryCallId } from '../vendor/pi-jev/compaction/decision.js';
import { promptReferences } from '../core/instruction.js';
import { tokensForChars } from '../core/prune.js';

/** Only the one-shot native request capability; never compact, input sends or UI. */
export interface DetectorContext {
  cwd?: string;
  model?: { provider?: string; id?: string; contextWindow?: number; api?: string; maxTokens?: number; cost?: unknown };
  sessionManager: { getSessionId(): string; getLeafId(): string | null; getBranch(): readonly unknown[]; getEntries(): readonly unknown[] };
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  requestNativeCompaction?(options: { requestId: string; origin?: 'extension' }):
    { accepted: true } | { accepted: false; reason: 'disabled' | 'compacting' | 'invalid' };
}
export interface NativeDetectorApi {
  prepare(entries: readonly unknown[], settings: unknown): unknown;
  systemText(entries: readonly unknown[]): string;
  settings(raw: unknown, model: unknown): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}
export interface DetectorDeps {
  loadController?(): ControllerConfig;
  loadDetector(): DetectorConfig;
  loadCompaction(): ConfigResult;
  getSettings(): unknown;
  native(): Promise<NativeDetectorApi>;
  questionLimit(): number;
  inputLimit?(config: JevConfig, signal: AbortSignal): Promise<number | null>;
  makeAsker(config: JevConfig, hash: string, signal: AbortSignal, attemptId: string): CoreAsker;
  /** Pi's context estimator, the one the compaction budget uses. Absent: economic screen unknown. */
  estimator?(): Promise<Estimator>;
  now(): number;
  fallbackLogDir: string;
  write(row: Record<string, unknown>, logDir: string): void;
}
const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Pi's pi-ai/dist/types.d.ts StopReason union; never persist arbitrary message text.
const ARM_REASONS = new Set(['disabled', 'compacting', 'invalid']);
const END_REASONS = new Set(['revision_changed', 'session_changed', 'revision_changed_before_commit']);
const STOP_REASONS = new Set(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);
/** A failed metadata read affects only its field, never the settled event. */
function recordField<T>(read: () => T): NonNullable<T> | null {
  try { return read() ?? null; } catch { return null; }
}

/** Counts and identifiers only, shared by every enabled collection mode. */
function settledFields(ctx: DetectorContext) {
  const leafEntryId = recordField(() => ctx.sessionManager.getLeafId());
  const stopReason = recordField(() => {
    const leaf = leafEntryId === null ? undefined : ctx.sessionManager.getBranch().find((entry: any) => entry.id === leafEntryId);
    const message = record(leaf) && leaf.type === 'message' ? leaf.message : undefined;
    const reason = record(message) ? message.stopReason : undefined;
    return typeof reason === 'string' && STOP_REASONS.has(reason) ? reason : null;
  });
  return { sessionId: recordField(() => sessionIdOf(ctx)), leafEntryId,
    idle: recordField(() => ctx.isIdle()), pendingMessages: recordField(() => ctx.hasPendingMessages()), stopReason,
    contextTokens: recordField(() => ctx.getContextUsage()?.tokens),
    contextWindow: recordField(() => ctx.getContextUsage()?.contextWindow) ?? recordField(() => ctx.model?.contextWindow),
    model: { provider: recordField(() => ctx.model?.provider), id: recordField(() => ctx.model?.id) } };
}

/** Native preparation and model-specific settings come from the running Pi install. */
export async function installedDetectorApi(): Promise<NativeDetectorApi> {
  const cli = realpathSync(process.argv[1]!);
  if (!/[\\/]dist[\\/]cli\.js$/.test(cli)) throw new Error('Pi installation unavailable');
  const entry = join(dirname(cli), 'index.js');
  const sdk = await import(pathToFileURL(entry).href);
  const compaction = await import(pathToFileURL(join(dirname(entry), 'core/compaction/compaction.js')).href);
  if (typeof compaction.prepareCompaction !== 'function' || typeof sdk.SettingsManager?.inMemory !== 'function') throw new Error('Native adapter unavailable');
  return {
    prepare: compaction.prepareCompaction,
    systemText: entries => sdk.buildSessionProjection(entries).messages.filter((m: any) => m.role === 'system').map((m: any) =>
      typeof m.content === 'string' ? m.content : m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')).join('\n'),
    settings: (raw, model) => sdk.SettingsManager.inMemory(raw).getCompactionSettings(model),
  };
}

/** Protocol bound is read from its owning service source, never a copied tuned default. */
export function detectorQuestionLimit(): number {
  const source = readFileSync(new URL('../../decision-service/server.py', import.meta.url), 'utf8');
  const match = source.match(/not isinstance\(questions, dict\) or not 1 <= len\(questions\) <= (\d+):/);
  const limit = Number(match?.[1]);
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error('Service question bound unavailable');
  return limit;
}
/** Discovery is optional metadata, bounded by both its own timeout and assessment deadline. */
export async function detectorInputLimit(config: JevConfig, signal: AbortSignal): Promise<number | null> {
  if (config.api.backend !== 'local' || !config.api.localEndpoint) return null;
  try {
    signal.throwIfAborted();
    const url = new URL('/health', config.api.localEndpoint);
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(2000, config.api.localTimeoutMs ?? config.api.timeoutMs))]) });
    if (!response.ok) return null;
    const body = await response.json();
    signal.throwIfAborted();
    if (!record(body) || body.backend !== effectiveAskerModel(config) ||
        (config.api.localRevision && body.revision !== config.api.localRevision) ||
        !Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0) return null;
    return body.max_tokens;
  } catch (error) { if (signal.aborted) throw error; return null; }
}

export function writeDetectorRow(row: Record<string, unknown>, logDir: string): void {
  appendJsonLine(join(logDir, 'detector.jsonl'), row);
}

/** Shared read-only candidate view for the observer and offline calibration replay. */
export function warrantCandidates(branch: readonly any[], preparation: any, config: JevConfig, systemText: string, cwd?: string): WarrantSnapshot['candidates'] {
  const span = convertMessages([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);
  const core = coreOptions(config);
  const prior = [...branch].reverse().find((e: any) => e.type === 'compaction') as any;
  const carry = prior?.fromHook ? validateCarry(prior.details?.jev?.carry)?.carry : undefined;
  const calls = collectToolCalls(span, 0);
  const boundary = boundaryCallId(span, calls);
  const segments = spanToSegments(span, { pins: core.pins, modifyTools: core.modifyTools, decisionTools: core.decisionTools,
    instruction: { tools: core.instructionTools, files: core.instructionFiles, paths: core.instructionPaths,
      followReferences: core.instructionFollowReferences, instructionRefs: promptReferences(systemText), cwd },
    boundaryToolUseId: calls.find(c => c.id === boundary)?.tool_use_id, maxStoredChars: core.maxArgCharsPinned,
    gen: (carry?.generation ?? 0) + 1, hash: core.hash }, carry?.segments ?? []);
  return segments.filter(s => s.kind === 'call' && s.call && s.call.tool !== 'unknown').map(s => ({
    id: s.call!.id ?? '', tool: s.call!.tool, output: s.call!.result,
    removableTokens: tokensForChars(s.call!.result.length), pinned: s.pin !== null,
  }));
}

interface History {
  lastAssessed: SnapshotIdentity | null;
  lastCompactionMs: number | null;
  lastFailureMs: number | null;
  suppressedAtTokens: number | null;
  terminalSuppression?: boolean;
}

/** Background assessment with optional one-shot native arming. One instance per registration. */
export function shadowObserver(deps: DetectorDeps) {
  interface State {
    generation: number;
    flight?: { controller: AbortController; invalid: boolean };
    history: History;
    scope?: string;
    controllerHistory?: ControllerHistory;
    samples?: number[];
    lastTokens?: number;
    lastLeaf?: string;
  }
  const sessions = new Map<string | null, State>();
  // Ownership outlives reset: core emits teardown outcomes using a possibly switched ctx.
  const requests = new Map<string, { sessionId: string | null; state: State; logDir: string; minNetReductionTokens: number; scope?: string; policy?: RequestPolicy; generation?:number; leaf?:string|null; tokens?: number; targetUnreachable?:boolean; admission?: CommitAdmission }>();
  const pending = (sessionId: string | null) => [...requests.values()].some(r => r.sessionId === sessionId);
  const stateFor = (ctx: unknown) => {
    const id = sessionIdOf(ctx);
    let state = sessions.get(id);
    if (!state) sessions.set(id, state = { generation: 0,
      history: { lastAssessed: null, lastCompactionMs: null, lastFailureMs: null, suppressedAtTokens: null } });
    return state;
  };
  function invalidate(ctx: unknown) {
    const state = sessions.get(sessionIdOf(ctx));
    if (!state) return;
    state.generation++;
    if (state.flight) { state.flight.invalid = true; state.flight.controller.abort(); }
  }
  function reset(ctx: unknown) {
    invalidate(ctx);
    sessions.delete(sessionIdOf(ctx));
  }
  function capture(ctx: DetectorContext, config: DetectorConfig, loaded: ConfigResult, settings: unknown) {
    return structuredClone({ session: sessionIdOf(ctx), leaf: ctx.sessionManager.getLeafId(),
      branch: ctx.sessionManager.getBranch(), tree: ctx.sessionManager.getEntries(), model: ctx.model, usage: ctx.getContextUsage(), cwd: ctx.cwd,
      idle: ctx.isIdle(), pending: ctx.hasPendingMessages(), config, loaded, settings, controller: deps.loadController?.() ?? {mode:'off'} });
  }
  function settled(ctx: DetectorContext): void {
    try {
      const config = deps.loadDetector();
      if (config.mode === 'record') {
        // Cancel prior shadow work in this session; never let its flight suppress a settled row.
        invalidate(ctx);
        const logDir = recordField(() => {
          const loaded = deps.loadCompaction();
          return loaded.ok ? dirname(expandHome(loaded.config.telemetry.path)) : null;
        }) ?? deps.fallbackLogDir;
        const row = { ts: recordField(() => new Date(deps.now()).toISOString()), kind: 'settled', mode: 'record',
          ...settledFields(ctx) };
        // Capture counts/identifiers now, dispatch only the write; no transcript snapshot or preparation.
        setImmediate(() => { try { deps.write(row, logDir); } catch {} });
        return;
      }
      if (config.mode !== 'shadow' && config.mode !== 'active') { invalidate(ctx); return; }
      const state = stateFor(ctx);
      if (state.flight || pending(sessionIdOf(ctx))) return; // Invalidated work owns this session only until its deadline.
      const loaded = deps.loadCompaction(), settings = deps.getSettings();
      const fields = settledFields(ctx);
      const raw = capture(ctx, config, loaded, settings), key = fingerprint(raw);
      const epoch = state.generation, started = deps.now(), id = randomUUID();
      const h = state.history;
      const logDir = loaded.ok ? dirname(expandHome(loaded.config.telemetry.path)) : deps.fallbackLogDir;
      const scope = fingerprint([raw.model, config, loaded, settings, raw.controller]);
      if (state.scope !== scope) {
        h.lastAssessed = null; h.lastFailureMs = null; h.suppressedAtTokens = null;h.terminalSuppression=false;
        state.controllerHistory = {}; state.samples = []; state.lastTokens = undefined; state.lastLeaf = undefined;
        state.scope = scope;
      }
      const owned = { controller: new AbortController(), invalid: false };
      state.flight = owned;
      // No asynchronous work is awaited by agent_settled; snapshot precedes dispatch.
      setImmediate(() => { void (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let written = false;
        let opportunity: Opportunity | undefined;
        let comparison: ReturnType<typeof compareStrategies> | undefined;
        let screen: EconomicCommitInput | undefined;
        let screenAfter: readonly [number, number] | undefined;
        let accounting: ReturnType<typeof captureAccounting> | undefined;
        let descriptor: BackendDescriptor | null = null;
        let requestTokens: number | null = null;
        let requestBuildLatencyMs: number | null = null;
        let snapshot: WarrantSnapshot = {
          leafEntryId: raw.leaf ?? '', tokens: settledProviderTokens(raw.branch, raw.leaf ?? '', raw.model), contextWindow: raw.usage?.contextWindow ?? null,
          modelKnown: !!raw.model?.id && !!raw.model?.provider, serviceModel: loaded.ok ? effectiveAskerModel(loaded.config) : '',
          compactionEnabled: loaded.ok && loaded.config.compaction.enabled, compactionConfigValid: loaded.ok,
          candidateAdapterCompatible: false, pendingInput: raw.pending, compactionRunning: !raw.idle,
          attemptInFlight: false, ...structuredClone(h), nowMs: started, candidates: [], recentTail: '', serviceQuestionLimit: 0, serviceInputTokenLimit: null, summarizedCallState: 'unknown', retainedCallState: 'unknown',
        };
        const fresh = () => {
          if (owned.invalid || state.generation !== epoch) return false;
          try { return key === fingerprint(capture(ctx, deps.loadDetector(), deps.loadCompaction(), deps.getSettings())); }
          catch { return false; }
        };
        const emit = (result: ReturnType<typeof assessWarrant>) => {
          if (written) return;
          written = true;
          let action = 'none', actionTaken = false;
          let requestId: string | undefined, actionReason: string | null | undefined;
          const decision = opportunity && comparison ? chooseCompaction(opportunity,result,comparison) : undefined;
          if (decision && fresh()) state.controllerHistory = decision.history;
          // An economic request arms only with the exact screen inputs its commit will certify against.
          const allowed = raw.controller.mode === 'off' || (raw.controller.mode === 'active' && decision?.request === true && (decision.kind !== 'economic' || screen !== undefined));
          if (allowed && config.mode === 'active' && result.outcome === 'warranted' && fresh() && !pending(raw.session)) {
            try {
              const arm = ctx.requestNativeCompaction;
              if (typeof arm !== 'function') action = 'unavailable';
              else if (result.outcome === 'warranted' && fresh() && !pending(raw.session)) {
                requestId = randomUUID();
                // No await between freshness and arming. Core records its own revision at admission.
                const armed = arm.call(ctx, { requestId, origin: 'extension' });
                if (armed.accepted) {
                  requests.set(requestId, { sessionId: raw.session, state, logDir, minNetReductionTokens: config.minNetReductionTokens, scope, generation:state.generation,leaf:raw.leaf,tokens: snapshot.tokens ?? undefined, ...(decision ? {policy:{...(decision.kind?{kind:decision.kind}:{}),target:decision.target,W:decision.W,H:decision.H,minimumReduction:config.minNetReductionTokens,...(decision.kind==='economic'?{economic:structuredClone(screen!)}:{})}} : {}) });
                  action = 'requested'; actionTaken = true;
                } else { action = 'refused'; actionReason = ARM_REASONS.has(armed.reason) ? armed.reason : null; }
              }
            } catch {
              action = 'refused'; actionReason = 'request_error';
              if (fresh()) h.lastFailureMs = deps.now();
            }
          }
          // Telemetry never escapes: emit also runs from the deadline timer, outside any catch.
          try { deps.write({ ts: new Date(deps.now()).toISOString(), mode: config.mode, ...fields, outcome: result.outcome,
            reasons: result.reasons, score: result.score, safeBoundary: result.safeBoundary,
            tokens: { before: snapshot.tokens, contextWindow: snapshot.contextWindow, request: requestTokens },
            serviceInputTokenLimit: snapshot.serviceInputTokenLimit, serviceInputLimitKnown: snapshot.serviceInputTokenLimit !== null,
            tailProfile: TAIL_PROFILE, requestBuildLatencyMs, latencyMs: Math.max(0, deps.now() - started), attemptId: id, backendDescriptor: descriptor,
            ...(decision ? {controller:{reason:decision.reason,request:decision.request,kind:decision.kind,W:decision.W,H:decision.H,target:decision.target,continue:comparison!.continue,compact:comparison!.compact,
              ...(decision.kind==='economic' ? {stage:'screen',savings:'unverified'} : {}),screenAfter:screenAfter??null}} : {}),
            action, actionTaken, ...(requestId ? { requestId } : {}), ...(actionReason !== undefined ? { actionReason } : {}) }, logDir); } catch {}
        };
        const defer = (reason: string) => emit({ outcome: 'defer', reasons: [reason], score: 0, safeBoundary: null, mode: 'shadow', actionTaken: 'none' });
        const fail = (reason: string) => { if (fresh()) h.lastFailureMs = deps.now(); defer(reason); };
        try {
          descriptor = loaded.ok ? backendDescriptor(loaded.config) : null;
          // Deadline covers adapter loading AND asking; late work never becomes an assessment result.
          timer = setTimeout(() => {
            try { if (!fresh()) defer('stale_result'); else fail('request_timeout'); }
            finally {
              owned.invalid = true;
              owned.controller.abort();
              // A transport may ignore abort forever. Its late finally cannot release a newer flight.
              if (state.flight === owned) state.flight = undefined;
            }
          }, Math.max(0, config.requestTimeoutMs - (deps.now() - started)));
          const native = await deps.native();
          if (!fresh()) { defer('stale_result'); return; }
          if (loaded.ok) {
            const nativeSettings = native.settings(raw.settings, raw.model);
            snapshot.compactionEnabled &&= nativeSettings.enabled;
            if (raw.controller.mode !== 'off') {
              accounting = captureAccounting({ ...ctx, model:raw.model, sessionManager:{...ctx.sessionManager,getLeafId:()=>raw.leaf} }, raw.branch, raw.controller, started);
              if(state.lastLeaf !== raw.leaf && snapshot.tokens !== null) {
                if(state.lastTokens !== undefined) state.samples = [...(state.samples??[]), Math.max(0,snapshot.tokens-state.lastTokens)].slice(-raw.controller.policy.growthSamples);
                state.lastTokens=snapshot.tokens;state.lastLeaf=raw.leaf??undefined;
              }
              opportunity = evaluateOpportunity({leaf:raw.leaf??'',tokens:snapshot.tokens,prompt:accounting.prompt,window:snapshot.contextWindow??0,reserve:nativeSettings.reserveTokens,maxTokens:accounting.maxTokens,now:started,bands:accounting.model.bands.map(b=>b.inputTokensAbove),samples:state.samples??[],afterTarget:(snapshot.tokens??0)*loaded.config.compaction.maxAfterShare,workingCeiling:accounting.profile?.workingCeiling},raw.controller.policy,state.controllerHistory??{});
              snapshot.opportunity=opportunity.evaluate; snapshot.urgent=opportunity.urgent;
            }
            const leafAt = raw.branch.findIndex((e: any) => e.id === raw.leaf);
            const branch = raw.branch.slice(0, leafAt + 1);
            const preparation = native.prepare(branch, nativeSettings);
            let prepared = false;
            if (record(preparation) && typeof preparation.firstKeptEntryId === 'string' && Array.isArray(preparation.messagesToSummarize) && Array.isArray(preparation.turnPrefixMessages)) {
              const at = raw.branch.findIndex((e: any) => e.id === preparation.firstKeptEntryId);
              if (at >= 0) {
                prepared = true;
                snapshot.candidates = warrantCandidates(branch, preparation, loaded.config, native.systemText(branch), raw.cwd);
                const tail = capturedTail(raw.branch, preparation, raw.leaf ?? '');
                snapshot.tailEntries = tail.entries;
                snapshot.boundaryEvidence = tail.boundaryEvidence;
                snapshot.summarizedCallState = tail.summarizedCallState;
                snapshot.retainedCallState = tail.retainedCallState;
                snapshot.serviceQuestionLimit = deps.questionLimit();
                snapshot.candidateAdapterCompatible = true;
              }
            }
            if (opportunity && accounting) {
              // Stage 1 screen (estimate, never a certificate): F = calibrated kept tail/system/tools,
              // A = the pruner's design point for this request's target. All prompt tokens follow
              // cache eligibility in both arms; ordinary input is not immutable (fixed = 0).
              const policy = raw.controller.mode !== 'off' ? raw.controller.policy : undefined;
              let after: readonly [number, number] | undefined;
              let unavailable = 'not_screened';
              if (policy && opportunity.evaluate && !opportunity.urgent) {
                unavailable = 'screen_unavailable';
                if (prepared && deps.estimator && snapshot.tokens !== null && snapshot.contextWindow) {
                  let estimator: Estimator | undefined;
                  try { estimator = await deps.estimator(); } catch { estimator = undefined; }
                  if (!fresh()) { defer('stale_result'); return; }
                  // A failed estimate leaves economics unknown; it is not an assessment failure.
                  let budget: ReturnType<typeof computeBudget> | undefined;
                  try { budget = estimator && computeBudget({ branchEntries: branch, firstKeptEntryId: (preparation as any).firstKeptEntryId, tokensBefore: snapshot.tokens,
                    contextWindow: snapshot.contextWindow, reserveTokens: nativeSettings.reserveTokens, targetContextTokens: opportunity.target,
                    maxShare: loaded.config.compaction.maxShare, maxAfterShare: loaded.config.compaction.maxAfterShare,
                    model: { provider: raw.model?.provider ?? '', id: raw.model?.id ?? '' }, estimator }); } catch { budget = undefined; }
                  if (!budget) unavailable = 'estimator_unavailable';
                  else if (budget.A <= budget.F || budget.overTrigger || budget.noRoom || !Number.isFinite(budget.F) || !Number.isFinite(budget.A)) unavailable = 'target_unreachable';
                  else { after = [budget.F, budget.A]; screenAfter = after; }
                }
              }
              const prompt = accounting.prompt ?? NaN;
              const input = { model: accounting.model, before: [prompt, prompt] as const, growth: [0, opportunity.growth ?? NaN] as const,
                output: [accounting.usage.output ?? NaN, Math.max(accounting.maxTokens ?? 0, accounting.usage.output ?? NaN)] as const,
                requests: opportunity.horizon, horizonMs: policy?.horizonMs ?? NaN, margin: policy?.economicMargin ?? NaN, cache: accounting.cache };
              const unknownCost = { low: null, high: null, knownSubtotal: 0, unknownTerms: [unavailable] };
              comparison = after && policy ? compareStrategies({ ...input, after, fixed: 0,
                overhead: accounting.profile?.overhead ?? null, assessmentOverhead: accounting.profile?.assessmentOverhead ?? null })
                : { continue: unknownCost, compact: unknownCost, beneficial: false, rebuildingWorse: false, scenarios: 0 };
              const overhead = accounting.profile?.overhead;
              if (after && policy && comparison.beneficial && overhead && snapshot.tokens !== null)
                screen = { ...input, observedMs: accounting.observedMs, projectionErrorShare: policy.projectionErrorShare, preparation: overhead, tokens: snapshot.tokens, band: opportunity.band };
            }
          }
          if (!fresh()) { defer('stale_result'); return; }
          snapshot.serviceInputTokenLimit = loaded.ok ? await (deps.inputLimit ?? detectorInputLimit)(loaded.config, owned.controller.signal) : null;
          if (!fresh()) { defer('stale_result'); return; }
          const buildStarted = performance.now();
          const gate = assessWarrant(snapshot, config);
          requestBuildLatencyMs = Math.max(0, performance.now() - buildStarted);
          if (gate.reasons[0] !== 'answers_missing') { emit(gate); return; }
          const request = gate.request!;
          requestTokens = request.tokens;
          if (!fresh()) { defer('stale_result'); return; }
          if (!loaded.ok) throw new Error('config unavailable');
          // The assessment's measured deadline owns its transport budget. The compactor's
          // historical 30s retry budget must not silently censor detector measurements.
          const assessmentConfig = structuredClone(loaded.config);
          assessmentConfig.api.retryBudgetMs = config.requestTimeoutMs;
          // Both transports, unconditionally: the static backend field must not choose which
          // per-attempt deadline applies.
          assessmentConfig.api.localTimeoutMs = config.requestTimeoutMs;
          assessmentConfig.api.timeoutMs = config.requestTimeoutMs;
          const asker = deps.makeAsker(assessmentConfig, fingerprint(assessmentConfig), owned.controller.signal, id);
          const response = await asker.ask(request.state, request.questions);
          if (deps.now() - started >= config.requestTimeoutMs && fresh()) { fail('request_timeout'); return; }
          if (!fresh()) { defer('stale_result'); return; }
          const client = asker as CoreAsker & { backend_descriptor?: BackendDescriptor };
          descriptor = client.backend_descriptor ?? descriptor;
          const result = assessWarrant({ ...snapshot, answers: response.answers }, config, request);
          if (result.reasons.some(r => r.includes('malformed') || r === 'answers_missing')) h.lastFailureMs = deps.now();
          else {
            h.lastAssessed = { leafEntryId: snapshot.leafEntryId, tokens: snapshot.tokens! };
            if (result.reasons.includes('score_below_minimum')) h.suppressedAtTokens = snapshot.tokens;
          }
          emit(result);
        } catch {
          if (!fresh()) defer('stale_result');
          else fail('assessment_error');
        } finally {
          clearTimeout(timer);
          if (state.flight === owned) state.flight = undefined;
        }
      })().catch(() => { if (state.flight === owned) state.flight = undefined; }); });
    } catch { invalidate(ctx); } // Malformed/unavailable inputs never escape into Pi.
  }
  function requestEnd(event: unknown, ctx: DetectorContext): void {
    if (!record(event) || event.origin !== 'extension' || typeof event.requestId !== 'string') return;
    const owned = requests.get(event.requestId);
    if (!owned || !['compacted', 'no_op', 'cancelled', 'failed', 'expired', 'superseded'].includes(event.outcome)) return;
    requests.delete(event.requestId); // Exactly one row, including after reset or duplicate delivery.
    let state = sessions.get(owned.sessionId);
    if (!state && !owned.policy) {
      // Reset erased assessment history, not the terminal cooldown/backoff still owed.
      state = { generation: owned.state.generation, scope: owned.state.scope,
        history: { lastAssessed: null, lastCompactionMs: null, lastFailureMs: null, suppressedAtTokens: null } };
      sessions.set(owned.sessionId, state);
    }
    try {
      const liveScope = owned.policy ? fingerprint([ctx.model,deps.loadDetector(),deps.loadCompaction(),deps.getSettings(),deps.loadController?.()??{mode:'off'}]) : undefined;
      const current = state && (!owned.policy || (state === owned.state && state.scope === owned.scope && liveScope === owned.scope && sessionIdOf(ctx) === owned.sessionId));
      if (current && event.outcome === 'compacted') {
        state!.history.lastCompactionMs = deps.now();state!.samples=[];state!.lastTokens=undefined;
        state!.controllerHistory={resetPending:true,targetUnreachable:owned.targetUnreachable};
      }
      const rejected = event.outcome === 'cancelled' && owned.policy?.kind === 'economic' && owned.policy.economic !== undefined &&
        (owned.admission?.verdict === 'economic_rejected' || owned.admission?.verdict === 'economic_unknown');
      if (current && rejected) {
        // Economic-only suppression: close the economic screen until growth or a band change.
        // No failure backoff or terminal suppression, so quality urgency is never delayed.
        state!.controllerHistory = { ...(state!.controllerHistory ?? {}), economicRejection: { tokens: owned.policy!.economic!.tokens, band: owned.policy!.economic!.band } };
      } else if (current && ['failed','cancelled',...(owned.policy?['no_op']:[])].includes(event.outcome)) {
        state!.history.lastFailureMs = deps.now();if(owned.policy){state!.history.suppressedAtTokens=owned.tokens??null;state!.history.terminalSuppression=true;}
      }
      const fields = settledFields(ctx);
      const sameSession = fields.sessionId === owned.sessionId;
      deps.write({ ts: new Date(deps.now()).toISOString(), kind: 'request', origin: 'extension', requestId: event.requestId,
        outcome: event.outcome, reason: END_REASONS.has(event.reason) ? event.reason : null,
        sessionId: owned.sessionId, leafEntryId: sameSession ? fields.leafEntryId : null,
        counts: { contextTokens: sameSession ? fields.contextTokens : null, contextWindow: sameSession ? fields.contextWindow : null,
          entries: sameSession ? recordField(() => ctx.sessionManager.getEntries().length) : null },
        ...(owned.policy?.kind ? { requestKind: owned.policy.kind } : {}),
        // Counts and nullable USD intervals only: a rejected preparation's configured cost stays visible.
        ...(owned.admission ? { admission: { verdict: owned.admission.verdict, continue: owned.admission.continue, compact: owned.admission.compact,
          preparation: owned.admission.preparation, afterTokens: owned.admission.afterTokens } } : {}) }, owned.logDir);
    } catch {} // Telemetry cannot affect core's terminal outcome.
  }
  return { settled, invalidate, reset, requestEnd,
    consuming(event: unknown, ctx: DetectorContext) {
      invalidate(ctx);
      if(record(event)&&typeof event.requestId==='string'){const owned=requests.get(event.requestId);if(owned && owned.generation!==undefined && owned.generation===owned.state.generation-1)owned.generation=owned.state.generation;}
    },
    committed(event: unknown, ctx: DetectorContext) {
      invalidate(ctx);
      if(!record(event) || typeof event.requestId !== 'string') return;
      const owned=requests.get(event.requestId);
      if(owned && record(event.compactionEntry)) owned.targetUnreachable=event.compactionEntry.details?.jev?.controller?.targetUnreachable===true;
    },
    /** Stores the commit-time economic verdict on the owned request, like `committed`. */
    admission(event: unknown, verdict: CommitAdmission) {
      if (!record(event) || event.origin !== 'extension' || typeof event.requestId !== 'string') return;
      const owned = requests.get(event.requestId);
      if (owned?.policy?.kind === 'economic') owned.admission = structuredClone(verdict);
    },
    requestPolicy(event: unknown): RequestPolicy | undefined {
      const policy = record(event) && event.origin === 'extension' && typeof event.requestId === 'string' ? requests.get(event.requestId)?.policy : undefined;
      return policy ? structuredClone(policy) : undefined;
    },
    minimumReduction(event: unknown, ctx?: DetectorContext): number | undefined {
      if(ctx && record(event) && typeof event.requestId==='string') {
        const owned=requests.get(event.requestId);
        if(owned?.policy) {
          try {
            const currentScope=fingerprint([ctx.model,deps.loadDetector(),deps.loadCompaction(),deps.getSettings(),deps.loadController?.()??{mode:'off'}]);
            if(owned.generation!==owned.state.generation || owned.leaf!==ctx.sessionManager.getLeafId() || currentScope!==owned.scope || sessions.get(owned.sessionId)!==owned.state || sessionIdOf(ctx)!==owned.sessionId || ctx.hasPendingMessages())return undefined;
          }catch{return undefined;}
        }
      }
      return record(event) && event.origin === 'extension' && typeof event.requestId === 'string'
        ? requests.get(event.requestId)?.minNetReductionTokens : undefined;
    },
    compaction(ctx: DetectorContext) { invalidate(ctx); try { stateFor(ctx).history.lastCompactionMs = deps.now(); } catch {} },
  };
}
