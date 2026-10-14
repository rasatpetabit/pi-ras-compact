import { loadControllerConfig, type ControllerConfig } from '../client/controller-config.js';
import { layoutFramingChars } from '../core/cache-layout.js';
import { assembleLayout, layoutRenderKey } from './layout.js';
import { admitCommit, type CommitAdmission, type RequestPolicy } from '../core/cache-controller.js';
import { saveCharterRecords, type CharterRecords } from '../core/charter-records.js';
import { sessionIdOf } from './session.js';
import { loadDetectorConfig } from '../client/detector-config.js';
import { shadowObserver, installedDetectorApi, detectorQuestionLimit, writeDetectorRow, type DetectorContext, type DetectorDeps } from './detector.js';
import { backendDescriptor, type BackendDescriptor } from '../client/backend-descriptor.js';
import { outcomeLine, MESSAGE_CONTENT_BUDGET, type RouteRecord } from './presentation.js';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  coreOptions,
  DEFAULT_TELEMETRY_DIR,
  defaultConfigPath,
  effectiveAskerModel,
  expandHome,
  loadConfig,
  type ConfigResult,
  type JevConfig,
} from '../client/config.js';
import { OpenAIDecisionsClient } from '../client/openai-decisions-client.js';
import { routePolicyRevision } from '../client/decision-routes.js';
import { createCompactionAsker } from '../client/asker.js';
import { promptReferences } from '../core/instruction.js';
import { JEV_KEY_ENV, JevError, type AskerContext } from '../client/jev-client.js';
import { appendJsonLine, flushTelemetry } from '../client/ledger.js';
import type { CoreAsker } from '../core/judge.js';
import { compactSpan, tokensForChars, type CompactOutcome, type CompactStats } from '../core/prune.js';
import { computeBudget, productionEstimator, type Budget, type Estimator } from './context-budget.js';
import { mergeFileLists, renderFileLists } from '../core/render.js';
import { CARRY_VERSION, validateCarry, type Carry } from '../core/segments.js';
import { MARKER_TYPE, MEASURED_TYPE, entryMarker, markerFor, renderCompactionPresentation, renderCompactionBox, type CompactionRenderOptions, renderMarker, type LastOutcome, type MarkerData } from './marker.js';
import { convertMessages } from '../vendor/pi-jev/compaction/convert.js';
import { boundaryCallId } from '../vendor/pi-jev/compaction/decision.js';
import { collectToolCalls, goalFromMessages } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { captureCharter, DEFAULT_PASTE_MIN_LINES, DEFAULT_TOOL_OUTPUT_MIN_CHARS, readCharterState, renderCharter, type CharterEntry, type CharterState } from '../core/charter.js';
import { branchMessages, entriesBefore } from './branch.js';
import { registerExpandTool } from './expand-tool.js';
import { renderTouched, touchedPaths } from '../core/touched.js';
import { DEFAULT_RETIRE_OPTIONS, reinstateReferenced, retireCorrected, type ChoiceAsker } from '../core/charter-judge.js';
import { readChainState, renderChain, updateChain, type ChainAsker, type ChainState } from '../core/chain.js';
import { readDirectives, renderDirectives, selectDirectives, type AgentDirective, type DirectiveAsker } from '../core/agent-directives.js';

/** Additive core event provenance; old Pi events remain unchanged. */
function compactionOrigin(event: unknown): { origin?: 'native' | 'extension'; requestId?: string } {
  if (!isRecord(event)) return {};
  return { ...(event.origin === 'native' || event.origin === 'extension' ? { origin: event.origin } : {}),
    ...(typeof event.requestId === 'string' ? { requestId: event.requestId } : {}) };
}
const detectorCompaction = (event: unknown) => compactionOrigin(event).origin === 'extension';

/** Operator messages first compacted now: at or after the previous compaction's first kept entry. */
function freshEntryIds(branchEntries: readonly unknown[], firstKeptEntryId: string): Set<string> {
  let from = 0;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i];
    if (isRecord(e) && e.type === 'compaction') {
      const kept = e.firstKeptEntryId;
      const at = typeof kept === 'string' ? branchEntries.findIndex(x => isRecord(x) && x.id === kept) : -1;
      from = at >= 0 ? at : i;
      break;
    }
  }
  const to = branchEntries.findIndex(x => isRecord(x) && x.id === firstKeptEntryId);
  const ids = new Set<string>();
  for (const e of branchEntries.slice(from, to < 0 ? branchEntries.length : to)) if (isRecord(e) && typeof e.id === 'string') ids.add(e.id);
  return ids;
}

/** Most recent fresh operator messages asked about per compaction; older ones are logged as skipped. */
const MAX_CORRECTION_ASKS = 24;

export interface HookContext {
  model?: { contextWindow?: number; provider?: string; id?: string };
  /**
   * Pi's run mode. `print` and `json` are headless; `rpc` has a dialog but no
   * operator in front of it, so it prompts with a timeout; `tui` prompts without
   * one. Undefined is treated like a TUI when a chooser is present.
   */
  mode?: string;
  /** Available host message width, when supplied by an embedding host (not guessed). */
  messageWidth?: number;
  /** True in TUI and RPC modes. False for print/json/subagent runs, which cannot prompt. */
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level: 'info' | 'warning' | 'error') => void;
    setStatus?: (key: string, text: string | undefined) => void;
    /** The chooser. Pi passes `signal`/`timeout` straight to the dialog implementation. */
    select?: (
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal; timeout?: number },
    ) => Promise<string | undefined>;
  };
}

export interface Deps {
  loadController?(): ControllerConfig;
  loadConfig(): ConfigResult;
  makeAsker(config: JevConfig, configHash: string, signal: AbortSignal | undefined, context: AskerContext): CoreAsker;
  compact: typeof compactSpan;
  /**
   * The additive prefix records writer. Injectable so a test can make it fail: the records are
   * optional metadata for the saved summary, and a failure there must never cost the charter.
   */
  saveCharterRecords?: typeof saveCharterRecords;
  /** Pi's own projection and estimate, bound to the Pi version in use. */
  estimator(): Promise<Estimator>;
  /** Tuples of backend ID (or unknown sentinel) and reason already announced in this process. */
  notified: Set<string>;
  /** Where compaction telemetry goes while the config is unusable. */
  fallbackLogDir: string;
  now(): number;
  /** Headless failure output: a session with no UI has no notification surface. */
  stderr?(message: string): void;
  /** The hook's last outcome, read by the chat marker once Pi has saved the compaction. */
  last?: LastOutcome;
  /** Pi's own estimate of the context after a compaction; undefined outside Pi. */
  contextAfter?(ctx: unknown): Promise<number | null>;
  /**
   * Runs the marker append after Pi's own compaction redraw, so the entry lands
   * directly under the box. Injectable so a test can see the append is deferred.
   */
  defer?(fn: () => void): void;
}

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface NativeCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
  usage?: PiUsage;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
    jev: {
      origin?: 'native' | 'extension';
      requestId?: string;
      version: typeof CARRY_VERSION;
      carry: Carry;
      stats: CompactStats;
      model: string;
      backend: string;
      backend_descriptor: BackendDescriptor;
      backend_requests?: Record<string, number>;
      backend_responses?: Record<string, number>;
      fallback_from?: string;
      fallback_reason?: string;
      fallback_descriptor?: BackendDescriptor;
      config_hash: string;
      route_policy_revision?: string;
      /** The event and the successful attempt, so telemetry joins the saved entry exactly. */
      hook_id: string;
      attempt_id: string;
      /** The provider-counted content outside the message list, for the next compaction. */
      overhead: { tokens: number; provider: string; model: string; provenance: Budget['provenance'] };
      /** What the box needs to render the result from the saved entry alone. */
      budget: {
        predictedAfter: number;
        trigger: number;
        target: number;
        fixedAfter: number;
        budgetTokens: number;
      };
      /** How long the whole pass took. */
      latencyMs: number;
    };
  };
}

export type HookResult = { cancel: true } | { compaction: NativeCompaction } | undefined;

/** What each failure reason means, in the words the operator sees. */
const FAILURE_TEXT: Record<string, string> = {
  config: 'configuration missing or invalid',
  auth: `Jev has no usable API key (${JEV_KEY_ENV})`,
  timeout: 'the Jev request timed out',
  network: 'the Jev request could not reach the decision service',
  http: 'Jev answered with an HTTP error',
  parse: 'Jev returned a body without answers',
  input_shape: 'Pi sent a session_before_compact event this adapter does not recognise (interface drift)',
  estimator: "Pi's context estimator failed",
  uncalibrated: 'no overhead measurement yet for this model',
  no_room: 'the kept turns and the fixed prompt leave no room under the trigger',
  no_progress: 'the result would not have freed enough context',
  pinned_over_budget: 'the pinned text does not fit the summary budget',
  empty_span: 'there was nothing to summarize',
  invalid_output: 'the result would not survive Pi saving the session',
  error: 'an unexpected error',
};

/** The three ways out of a failure, exactly as the interactive prompt names them. */
const RETRY = 'Retry Jev';
const NATIVE = "Use Pi's summary";
const CANCEL = 'Cancel compaction';
const CHOICES = [RETRY, NATIVE, CANCEL];
type FailureChoice = 'retry' | 'native' | 'cancel';

/** One-line effective route and full-context provenance, never summary-token substitution. */
export function successNote(line: Record<string, unknown>, _summaryChars: number, _latencyMs: number, width = MESSAGE_CONTENT_BUDGET): string {
  return outcomeLine(line.fallback_from ? 'hosted_success' : 'success', line as RouteRecord, width);
}

function messageWidth(ctx: HookContext): number {
  try { return typeof ctx?.messageWidth === 'number' && ctx.messageWidth > 0 ? Math.min(ctx.messageWidth, MESSAGE_CONTENT_BUDGET) : MESSAGE_CONTENT_BUDGET; }
  catch { return MESSAGE_CONTENT_BUDGET; }
}
function attemptNote(state: string, attempt: Attempt, ctx: HookContext, explanation?: string): string {
  return outcomeLine(state, { ...attempt.line, reason: attempt.reason } as RouteRecord, messageWidth(ctx), explanation);
}

interface Input {
  firstKeptEntryId: string;
  tokensBefore: number;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  previousSummary: string | undefined;
  customInstructions: string | undefined;
  reserveTokens: number;
  fileOps: { read: string[]; edited: string[]; written: string[] };
  branchEntries: unknown[];
  contextWindow: number;
  triggerReason: string | undefined;
  willRetry: boolean;
  modelProvider: string;
  modelId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!(value instanceof Set) && !Array.isArray(value)) return undefined;
  return [...value].filter((item): item is string => typeof item === 'string');
}

/** Checks the event against the shape this adapter was written for; any surprise returns undefined. */
function readInput(event: unknown, ctx: HookContext): Input | undefined {
  if (!isRecord(event) || !isRecord(event.preparation)) return undefined;
  const p = event.preparation;
  const settings = p.settings;
  const fileOps = p.fileOps;
  const contextWindow = isRecord(ctx) && isRecord(ctx.model) ? ctx.model.contextWindow : undefined;
  const modelProvider = isRecord(ctx) && isRecord(ctx.model) ? ctx.model.provider : undefined;
  const modelId = isRecord(ctx) && isRecord(ctx.model) ? ctx.model.id : undefined;
  if (typeof p.firstKeptEntryId !== 'string' || p.firstKeptEntryId.length === 0) return undefined;
  if (typeof p.tokensBefore !== 'number' || !Number.isFinite(p.tokensBefore) || p.tokensBefore < 0) return undefined;
  if (!Array.isArray(p.messagesToSummarize) || !Array.isArray(p.turnPrefixMessages)) return undefined;
  if (p.previousSummary !== undefined && typeof p.previousSummary !== 'string') return undefined;
  if (event.customInstructions !== undefined && typeof event.customInstructions !== 'string') return undefined;
  if (!isRecord(settings) || typeof settings.reserveTokens !== 'number' || !Number.isFinite(settings.reserveTokens)) {
    return undefined;
  }
  if (!isRecord(fileOps)) return undefined;
  const read = stringList(fileOps.read);
  const edited = stringList(fileOps.edited);
  const written = stringList(fileOps.written);
  if (!read || !edited || !written) return undefined;
  if (!Array.isArray(event.branchEntries)) return undefined;
  // Without a real AbortSignal the abort guarantees cannot hold: treat it as interface drift.
  if (!(event.signal instanceof AbortSignal)) return undefined;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  if (typeof modelProvider !== 'string' || modelProvider.length === 0) return undefined;
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined;
  return {
    firstKeptEntryId: p.firstKeptEntryId,
    tokensBefore: p.tokensBefore,
    messagesToSummarize: p.messagesToSummarize,
    turnPrefixMessages: p.turnPrefixMessages,
    previousSummary: p.previousSummary as string | undefined,
    customInstructions: event.customInstructions as string | undefined,
    reserveTokens: settings.reserveTokens,
    fileOps: { read, edited, written },
    branchEntries: event.branchEntries,
    contextWindow,
    triggerReason: typeof event.reason === 'string' ? event.reason : undefined,
    willRetry: event.willRetry === true,
    modelProvider,
    modelId,
  };
}

function latestCompaction(entries: readonly unknown[]): { fromHook: boolean; details: unknown; summary: string } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isRecord(entry) && entry.type === 'compaction') return { fromHook: entry.fromHook === true, details: entry.details, summary: typeof entry.summary === 'string' ? entry.summary : '' };
  }
  return undefined;
}

/**
 * The previous hook-made compaction's lists. Pi's `extractFileOperations` skips
 * `details` for `fromHook` entries, so the adapter merges them. Anything but an
 * array of strings counts as empty, and the rejected entries are counted.
 */
function priorFileLists(details: unknown): { read: string[]; modified: string[]; rejected: number } {
  if (!isRecord(details)) return { read: [], modified: [], rejected: 0 };
  let rejected = 0;
  const strings = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      rejected += 1;
      return [];
    }
    const kept = value.filter((item): item is string => typeof item === 'string');
    rejected += value.length - kept.length;
    return kept;
  };
  const read = strings(details.readFiles);
  const modified = strings(details.modifiedFiles);
  return { read, modified, rejected };
}

function structuredCarry(details: unknown): { carry: Carry; demotedUnknown: number } | undefined {
  return isRecord(details) && isRecord(details.jev) && details.jev.version === CARRY_VERSION
    ? validateCarry(details.jev.carry)
    : undefined;
}

function piUsage(stats: CompactStats): PiUsage | undefined {
  if (stats.jevRequests === 0) return undefined;
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input: stats.jevInputTokens,
    output: stats.jevOutputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: stats.jevInputTokens + stats.jevOutputTokens,
    cost: zero,
  };
}

function statsFields(stats: CompactStats): Record<string, number | Record<string, number>> {
  return {
    generation: stats.generation,
    step: stats.step,
    segments: stats.segments,
    kept: stats.kept,
    truncated: stats.truncated,
    capped: stats.capped,
    stubbed: stats.stubbed,
    unlinked: stats.unlinked,
    dropped: stats.dropped,
    pinned: stats.pinned,
    pinned_by_class: stats.pinnedByClass,
    demoted: stats.demoted,
    demoted_cap: stats.demotedCap,
    demoted_duplicate: stats.demotedDuplicate,
    backfilled: stats.backfilled,
    demoted_unknown: stats.demotedUnknown,
    asked: stats.asked,
    unasked: stats.unasked,
    unanswered: stats.unanswered,
    jev_requests: stats.jevRequests,
    jev_input_tokens: stats.jevInputTokens,
    jev_output_tokens: stats.jevOutputTokens,
  };
}

/**
 * Pi persists the entry with plain `JSON.stringify` (session-manager.js
 * `_persist`), so the result must come back from a JSON round trip unchanged,
 * and its carry must pass the check the next compaction applies.
 */
function outputValid(compaction: NativeCompaction, input: Input): boolean {
  if (compaction.summary.trim().length === 0) return false;
  if (compaction.firstKeptEntryId !== input.firstKeptEntryId || compaction.tokensBefore !== input.tokensBefore) return false;
  // A summary longer than `budgetTokens` is accepted and recorded as `over_budget`: the budget
  // guides pruning, it does not bound the result (operator decision 2026-09-25).
  let copy: NativeCompaction;
  try {
    copy = JSON.parse(JSON.stringify(compaction)) as NativeCompaction;
  } catch {
    return false;
  }
  return isDeepStrictEqual(copy, compaction) && validateCarry(copy.details?.jev?.carry) !== undefined;
}

/** One pass over the whole hook: config, budget, Jev, output check. Never throws. */
export interface CompactionPassAttempt {
  /** The compaction Jev produced, when the pass succeeded. */
  compaction?: NativeCompaction;
  /** null on success; otherwise why the pass did not produce a compaction. */
  reason: string | null;
  extra: Record<string, unknown>;
  line: Record<string, unknown>;
  logDir: string;
  started: number;
  /** This pass's id. Every row it writes carries it, success or not. */
  attemptId: string;
  /** The loaded config's backend and fallback, when it loaded (drives the hosted retry). */
  backend?: 'typesafe' | 'local';
  fallback?: 'typesafe' | 'none';
  backend_descriptor?: BackendDescriptor;
  /** Returned without writing decision telemetry from the pass. */
  decisions?: CompactOutcome['decisions'];
  /**
   * The RPC failure prompt's timeout, from config when it loaded. `undefined` means
   * either the config could not be read, or the operator has not yet added the
   * optional `compaction.prompt_timeout_ms`: RPC then does not prompt (an unattended
   * client would hang) and cancels exactly like a headless run.
   */
  promptTimeoutMs?: number;
}

type Attempt = CompactionPassAttempt;
export type CompactionPassDeps = Pick<Deps, 'loadController' | 'loadConfig' | 'makeAsker' | 'compact' | 'saveCharterRecords' | 'estimator' | 'fallbackLogDir' | 'now'>;
export type CompactionPass =
  | { ok: true; result: CompactionPassAttempt & { compaction: NativeCompaction; reason: null } }
  | { ok: false; failure: CompactionPassAttempt };

/** Content pass: no notification, decision-log write, retry or fallback policy. */
export async function runCompactionPass(
  event: unknown,
  ctx: HookContext,
  deps: CompactionPassDeps,
  signal: AbortSignal | undefined,
  hookId: string,
  /** 'typesafe' re-runs the pass on the hosted service after a local service failure. */
  backendOverride?: 'typesafe',
  failed?: Attempt,
): Promise<CompactionPass> {
  // Before config, input or any request: a pass that fails at the first check still has an id.
  const attemptId = randomUUID();
  const started = deps.now();
  let logDir = deps.fallbackLogDir;
  let promptTimeoutMs: number | undefined;
  const line: Record<string, unknown> = {
    ...compactionOrigin(event),
    hook_id: hookId,
    attempt_id: attemptId,
    session_id: sessionIdOf(ctx),
    config_hash: null,
    pin_classes: null,
    tokens_before: null,
    rejected_prior_file_entries: 0,
    carry: null,
  };
  let backend: 'typesafe' | 'local' | undefined;
  let fallback: 'typesafe' | 'none' | undefined;
  let decisions: CompactOutcome['decisions'] | undefined;
  let descriptor: BackendDescriptor | undefined;
  // Track the actual clients used by charter AND pruning, including HTTP retries.
  // An injected asker without counters is unknown, never inferred from its model.
  type TrackedClient = CoreAsker & { readonly requestCount?: number; readonly responseCount?: number; readonly backend_descriptor?: BackendDescriptor };
  const clients = new Map<TrackedClient, { requests: number | undefined; responses: number | undefined; backend: string }>();
  const makeAsker = (config: JevConfig, hash: string) => {
    const client: TrackedClient = deps.makeAsker(config, hash, signal, { hookId, attemptId });
    if (!clients.has(client)) clients.set(client, { requests: client.requestCount, responses: client.responseCount, backend: config.api.backend ?? 'typesafe' });
    return client;
  };
  const refreshProvenance = () => {
    if (!backend) return;
    // No client means no measurement, not an invented zero. Keep attempts and
    // accepted responses independent; older/injected clients may lack either counter.
    for (const [field, counter, initialKey] of [
      ['backend_requests', 'requestCount', 'requests'],
      ['backend_responses', 'responseCount', 'responses'],
    ] as const) {
      const values = { ...(isRecord(failed?.line[field]) ? failed.line[field] : {}) };
      for (const id of new Set([...clients.values()].map(initial => initial.backend))) {
        const counters = [...clients].filter(([, initial]) => initial.backend === id).map(([client, initial]) => {
          const before = initial[initialKey], after = client[counter];
          return Number.isSafeInteger(before) && before! >= 0 && Number.isSafeInteger(after) && after! >= before!
            ? after! - before! : undefined;
        });
        if (counters.every(count => count !== undefined)) {
          values[id] = counters.reduce<number>((sum, count) => sum + count!, 0);
        }
      }
      if (Object.keys(values).length) line[field] = values;
    }
    for (const client of clients.keys()) if (client.backend_descriptor?.verified_revision) descriptor = client.backend_descriptor;
    if (descriptor) line.backend_descriptor = descriptor;
  };
  const fail = (reason: string, extra: Record<string, unknown> = {}): CompactionPass => {
    refreshProvenance();
    return { ok: false, failure: {
      decisions,
      reason,
      extra,
      line,
      logDir,
      started,
      attemptId,
      ...(promptTimeoutMs !== undefined ? { promptTimeoutMs } : {}),
      ...(backend ? { backend } : {}),
      ...(descriptor ? { backend_descriptor: descriptor } : {}),
      ...(fallback ? { fallback } : {}),
    } };
  };

  try {
    if (signal?.aborted) return fail('aborted');
    if (backendOverride && failed) {
      backend = backendOverride;
      line.backend = backend;
      line.fallback_from = failed.backend!;
      line.fallback_reason = failed.reason!;
      if (failed.backend_descriptor) line.fallback_descriptor = failed.backend_descriptor;
    }
    const loaded = deps.loadConfig();
    if (!loaded.ok) return fail('config', { config_errors: loaded.errors });
    const { hash } = loaded;
    backend = loaded.config.api.backend ?? 'typesafe';
    fallback = loaded.config.api.fallback ?? 'none';
    // The hosted retry asks TypeSafe with everything else unchanged: same config, same pins, same budget.
    const config: JevConfig = backendOverride
      ? { ...loaded.config, api: { ...loaded.config.api, backend: backendOverride } }
      : loaded.config;
    backend = config.api.backend ?? 'typesafe';
    descriptor = backendDescriptor(config);
    line.backend = backend;
    line.backend_descriptor = descriptor;
    const fallbackFields = backendOverride && failed ? {
      fallback_from: failed.backend!,
      fallback_reason: failed.reason!,
      ...(failed.backend_descriptor ? { fallback_descriptor: failed.backend_descriptor } : {}),
    } : {};
    Object.assign(line, fallbackFields);
    line.config_hash = hash;
    line.pin_classes = config.compaction.pins;
    logDir = dirname(expandHome(config.telemetry.path));
    promptTimeoutMs = config.compaction.promptTimeoutMs;
    if (!config.compaction.enabled) return fail('disabled');

    const input = readInput(event, ctx);
    if (!input) return fail('input_shape');
    line.tokens_before = input.tokensBefore;
    // Known from the input onwards, so a failure after the budget still records them.
    line.trigger_reason = input.triggerReason ?? null;
    line.will_retry = input.willRetry;
    line.context_window = input.contextWindow;
    line.reserve_tokens = input.reserveTokens;

    // The context-after budget is computed before any Jev request so its terms can guide pruning
    // and be recorded; being over the trigger never stops the request (operator decision 2026-09-25).
    let estimator: Estimator;
    try {
      estimator = await deps.estimator();
    } catch (error) {
      return fail('estimator', { cause: causeOf(error) });
    }
    const controllerConfig = deps.loadController?.() ?? {mode:'off'};
    const requestPolicy = isRecord(event) ? event.jevRequestPolicy as RequestPolicy | undefined : undefined;
    let budget: Budget;
    try {
      budget = computeBudget({
        branchEntries: input.branchEntries,
        firstKeptEntryId: input.firstKeptEntryId,
        tokensBefore: input.tokensBefore,
        contextWindow: input.contextWindow,
        reserveTokens: input.reserveTokens,
        ...(requestPolicy ? {targetContextTokens:requestPolicy.target} : {}),
        maxShare: config.compaction.maxShare,
        maxAfterShare: config.compaction.maxAfterShare,
        model: { provider: input.modelProvider, id: input.modelId },
        estimator,
      });
    } catch (error) {
      return fail('estimator', { cause: causeOf(error) });
    }
    const { budgetTokens, O, provenance, F, A, T, projectedTokens, overTrigger, noRoom } = budget;
    line.overhead = O;
    line.overhead_provenance = provenance;
    line.fixed_after = F;
    line.target_after = A;
    line.budget_tokens = budgetTokens;
    // The context-after budget guides pruning; it never refuses a Jev compaction (operator
    // decision 2026-09-25). Both former `no_room` conditions are telemetry now.
    line.over_trigger = overTrigger;
    line.no_room = noRoom;

    const prior = latestCompaction(input.branchEntries);
    const priorLists = prior?.fromHook ? priorFileLists(prior.details) : { read: [], modified: [], rejected: 0 };
    line.rejected_prior_file_entries = priorLists.rejected;
    const lists = mergeFileLists(
      priorLists,
      { read: input.fileOps.read, modified: [...input.fileOps.edited, ...input.fileOps.written] },
      config.render.maxFileListEntries,
    );
    let fileListText = renderFileLists(lists);
    // Touched paths: every path a tool call on the branch named (src/core/touched.ts).
    if (config.compaction.touchedPaths) {
      try {
        const touched = touchedPaths(branchMessages(entriesBefore(input.branchEntries, input.firstKeptEntryId)),
          [...lists.readFiles, ...lists.modifiedFiles], config.render.maxFileListEntries, config.compaction.touchedListings);
        fileListText += renderTouched(touched);
        line.touched_paths = touched.paths.length;
      } catch (error) {
        line.touched_error = causeOf(error);
      }
    }

    const structured = prior?.fromHook ? structuredCarry(prior.details) : undefined;
    const previous: Carry | string | undefined = structured?.carry ?? input.previousSummary;
    line.carry = structured ? 'structured' : previous === undefined ? 'none' : 'opaque';

    const span = convertMessages([...input.messagesToSummarize, ...input.turnPrefixMessages] as AgentMessage[]);
    if (span.length === 0 && previous === undefined) return fail('empty_span');
    const calls = collectToolCalls(span, 0);
    const boundaryId = boundaryCallId(span, calls);
    const boundaryToolUseId = calls.find(candidate => candidate.id === boundaryId)?.tool_use_id;
    const goal = input.customInstructions?.trim() || goalFromMessages(span);

    // The prompt's references, from the same estimator the budget used. `systemMessage` replays
    // the branch it is given and reads no session state, so a second call recomputes the same
    // message; the core receives only the absolute and `~` paths, never the prompt. A throw or
    // an absent message leaves the set empty: basename, prefix and body matching still work.
    let instructionRefs: string[] = [];
    try {
      const message = estimator.systemMessage(input.branchEntries);
      instructionRefs = promptReferences(systemMessageText(message));
    } catch {
      instructionRefs = [];
    }
    const cwd = sessionCwd(ctx);

    // The session charter (spec: pi-jev-compact-cachelane, Design > Charter): derived from the
    // branch itself, so it holds every operator message and answer before the compaction point
    // however the earlier compactions were made. Its failure never fails the compaction: the
    // pool then keeps its own copies, as before.
    let charterText = '';
    let charterRecords: CharterRecords | undefined;
    let chainText = '';
    let charterChain: ChainState | undefined;
    let charterDirectives: AgentDirective[] | undefined;
    let charterDetails: { state: CharterState; stats: Record<string, number> } | undefined;
    // What the records writer needs and the charter block does not otherwise keep: the entries it
    // was built from, and the directives text. Both survive so the writer can run after the
    // charter exists, and only then.
    let charterEntries: CharterEntry[] | undefined;
    let charterDirectivesText = '';
    const core = coreOptions(config);
    if (config.compaction.charter) {
      try {
        const before = branchMessages(entriesBefore(input.branchEntries, input.firstKeptEntryId));
        const entries = captureCharter(before, {
          decisionTools: core.decisionTools,
          hash: core.hash,
          pasteMinLines: DEFAULT_PASTE_MIN_LINES,
          toolOutputMinChars: DEFAULT_TOOL_OUTPUT_MIN_CHARS,
        });
        charterEntries = entries;
        const priorJev = prior?.fromHook && isRecord(prior.details) && isRecord(prior.details.jev) ? prior.details.jev : undefined;
        let state = readCharterState(priorJev?.charter);
        // Corrections and the chain of why (spec: Charter > How an entry leaves; Why-chain). The
        // judge only selects; every failure keeps what was there. Finished requests are shown in
        // the chain but, in this first version, not retired from the charter.
        const fresh = freshEntryIds(input.branchEntries, input.firstKeptEntryId);
        const freshSaid = entries.filter(e => e.kind === 'said' && fresh.has(e.entryId));
        const asked = new Set(freshSaid.slice(-MAX_CORRECTION_ASKS).map(e => e.id));
        const judgeAsker = makeAsker(config, hash);
        let retireOptions = DEFAULT_RETIRE_OPTIONS;
        if (config.api.charterBackend === 'openai-decisions') {
          const gateAsker = new OpenAIDecisionsClient({ config, configHash: hash, caller: 'charter-gate', context: { hookId, attemptId } }, signal);
          clients.set(gateAsker, { requests: gateAsker.requestCount, responses: gateAsker.responseCount, backend: 'openai-decisions' });
          line.route_policy_revision = routePolicyRevision(config);
          retireOptions = { ...DEFAULT_RETIRE_OPTIONS, gate: {
            asker: gateAsker as unknown as ChoiceAsker,
            replaceMin: config.api.charterReplaceMin!,
            defersMax: config.api.charterDefersMax!,
          } };
        }
        const generation = (structured?.carry.generation ?? 0) + 1;
        const back = reinstateReferenced(entries, new Set(freshSaid.map(e => e.id)), state);
        state = back.state;
        line.charter_reinstated = back.reinstated.length;
        try {
          const retired = await retireCorrected(entries, asked, state, generation, judgeAsker as unknown as ChoiceAsker, retireOptions);
          state = retired.state;
          line.charter_corrections_asked = retired.log.length;
          line.charter_retired_now = retired.log.filter(l => l.why === 'retired').length;
          line.charter_correction_skipped = freshSaid.length - asked.size;
        } catch (error) {
          line.charter_correction_error = causeOf(error);
        }
        let chain: ChainState = readChainState(priorJev?.chain);
        try {
          const spanMessages = before.filter(m => fresh.has(m.entryId));
          const updated = await updateChain(chain, entries, state, spanMessages, generation, judgeAsker as unknown as ChainAsker);
          chain = updated.state;
          line.chain_update = String(updated.log.why);
        } catch (error) {
          line.chain_error = causeOf(error);
        }
        let directives: AgentDirective[] = readDirectives(priorJev?.directives);
        try {
          const selected = await selectDirectives(directives, before, fresh, generation, judgeAsker as unknown as DirectiveAsker);
          directives = selected.directives;
          line.directives_accepted_new = selected.log.accepted_new;
          line.directives_committed_new = selected.log.committed_new;
        } catch (error) {
          line.directives_error = causeOf(error);
        }
        charterDirectives = directives;
        charterChain = chain;
        chainText = renderChain(chain, entries);
        const directivesText = renderDirectives(directives);
        charterDirectivesText = directivesText;
        charterText = renderCharter(entries, state) + (directivesText.length > 0 ? `${directivesText}\n` : '');
        const said = entries.filter(e => e.kind === 'said');
        charterDetails = {
          state,
          stats: {
            said: said.length,
            answered: entries.length - said.length,
            retired: Object.keys(state.retired).length,
            pasted: said.reduce((n, e) => n + e.pasted.length, 0),
            source_chars: entries.reduce((n, e) => n + e.sourceChars, 0),
            chars: charterText.length,
          },
        };
        line.charter_chars = charterText.length;
        line.charter_entries = entries.length;
      } catch (error) {
        charterText = '';
        charterDetails = undefined;
        line.charter_error = causeOf(error);
      }
      // The records are offsets into the prefix that was just rendered: additive provenance,
      // nothing the summary needs. They run last, in their own try, because a failure here must
      // not touch charterText, the chain, the directives or charterDetails — losing the whole
      // session charter to an optional-metadata failure is the failure this guards
      // (spec: pi-jev-compact-cachelane > Failure handling: a charter step never drops an entry on
      // an error).
      if (charterDetails !== undefined && charterEntries !== undefined) {
        try {
          charterRecords = (deps.saveCharterRecords ?? saveCharterRecords)(charterEntries, charterDetails.state, charterDirectivesText, chainText);
        } catch (error) {
          charterRecords = undefined;
          line.charter_records_error = causeOf(error);
        }
      }
    }
    const charterPrefix = (charterText.length > 0 ? `${charterText}\n` : '') + (chainText.length > 0 ? `${chainText}\n` : '');
    // Spec: Charter > Size. The charter is always carried whole; the pool below it is squeezed
    // instead. A charter past half the window is only flagged (a residual risk, never a cut).
    if (charterPrefix.length > 0) {
      line.charter_tokens = tokensForChars(charterPrefix.length);
      if (tokensForChars(charterPrefix.length) > input.contextWindow / 2) line.charter_overflow = true;
    }
    // compactSpan already charges each carry part's separator. Layout adds at most one
    // atom per charter entry plus framing, retirement notice, directives and chain; files
    // and the non-charter goal each add one more. Reserve even empty optional prefix atoms
    // conservatively, plus the complete invariant wrapper (legacy wrapper remains charged).
    const layoutSuffixAtoms = (charterPrefix ? (charterEntries?.length ?? 0) + 4 : 0)
      + (fileListText ? 1 : 0) + (!charterRecords && goal.trim() ? 1 : 0);
    const outcome = await deps.compact(
      {
        previous,
        span,
        boundaryToolUseId,
        goal,
        budgetTokens,
        suffixChars: fileListText.length + charterPrefix.length + (controllerConfig.mode !== 'off' && controllerConfig.layout ? layoutFramingChars(layoutSuffixAtoms) : 0),
        demotedUnknown: structured?.demotedUnknown ?? 0,
        instructionRefs,
        ...(cwd !== undefined ? { cwd } : {}),
      },
      { ...core, charter: charterDetails !== undefined },
      makeAsker(config, hash),
    );
    // Before any refusal: a later invalid or cancelled result still has its line.
    // The record never enters details.jev, which Pi saves verbatim in every session.
    decisions = outcome.decisions;
    Object.assign(line, statsFields(outcome.stats));

    const assembled = controllerConfig.mode !== 'off' && controllerConfig.layout
      ? assembleLayout(outcome,charterPrefix,charterRecords,fileListText,goal,prior,controllerConfig,
        layoutRenderKey([config.render,core.stubWrites,core.stubEditChars,core.maxArgChars,core.maxArgCharsPinned,core.truncateHeadChars,[...core.modifyTools]]))
      : {summary:charterPrefix + outcome.summary + fileListText,records:charterRecords};
    const summary = assembled.summary;
    charterRecords = assembled.records;
    // Pi ignores the hook's own figure; the old formula overstated what the compaction freed.
    // P is measured the way Pi measures it, and the provider's next count is the check.
    const predicted = projectedTokens(summary);
    line.predicted_after = predicted;
    // The guidance budget is not a hard cap, but a replacement must meaningfully reduce
    // context. P uses the budget's provider-token basis (r x projected estimate), matching
    // Pi's tokensBefore, not the summary's chars/4 count. JSON cannot persist NaN.
    if (!Number.isFinite(predicted)) return fail('no_progress');
    line.over_budget = tokensForChars(summary.length) > budgetTokens;
    // The result may sit past the trigger; that is recorded, not refused.
    if (predicted > T) line.over_trigger = true;
    refreshProvenance();
    const usage = piUsage(outcome.stats);
    const compaction: NativeCompaction = {
      summary,
      firstKeptEntryId: input.firstKeptEntryId,
      tokensBefore: input.tokensBefore,
      estimatedTokensAfter: predicted,
      ...(usage ? { usage } : {}),
      details: {
        readFiles: lists.readFiles,
        modifiedFiles: lists.modifiedFiles,
        jev: {
          ...compactionOrigin(event),
          version: CARRY_VERSION,
          carry: outcome.carry,
          ...('layout' in assembled && assembled.layout ? {layout:assembled.layout} : {}),
          ...(requestPolicy ? {controller:{target:requestPolicy.target,W:requestPolicy.W,H:requestPolicy.H,targetUnreachable:predicted>requestPolicy.target}} : {}),
          ...(charterDetails ? { charter: charterDetails.state, charter_stats: charterDetails.stats } : {}),
          ...(charterRecords ? { charter_records: charterRecords } : {}),
          ...(charterDetails && charterChain ? { chain: charterChain } : {}),
          ...(charterDetails && charterDirectives ? { directives: charterDirectives } : {}),
          stats: outcome.stats,
          model: effectiveAskerModel(config),
          backend,
          backend_descriptor: descriptor,
          ...(line.backend_requests ? { backend_requests: line.backend_requests as Record<string, number> } : {}),
          ...(line.backend_responses ? { backend_responses: line.backend_responses as Record<string, number> } : {}),
          ...fallbackFields,
          config_hash: hash,
          ...(line.route_policy_revision ? { route_policy_revision: line.route_policy_revision as string } : {}),
          hook_id: hookId,
          attempt_id: attemptId,
          overhead: { tokens: O, provider: input.modelProvider, model: input.modelId, provenance },
          budget: { predictedAfter: predicted, trigger: T, target: A, fixedAfter: F, budgetTokens },
          latencyMs: deps.now() - started,
        },
      },
    };
    if (!outputValid(compaction, input)) return fail('invalid_output');
    return { ok: true, result: { compaction, reason: null, extra: {}, line, logDir, started, attemptId, ...(promptTimeoutMs !== undefined ? { promptTimeoutMs } : {}), backend, backend_descriptor: descriptor, ...(fallback ? { fallback } : {}), decisions } };
  } catch (error) {
    return fail(error instanceof JevError ? error.kind : 'error', { cause: causeOf(error) });
  }
}

/**
 * A safe, one-line cause for a failure notice and its telemetry row: the error's
 * own message, plus the HTTP status when Jev gave one and the message does not
 * already carry it. Never a key, a request body or raw provider content: the
 * messages here are code-authored, and anything else is whitespace-collapsed and
 * capped to one short line.
 */
function causeOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  let message = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (error instanceof JevError && typeof error.status === 'number' && !/(?:HTTP|\b\d{3}\b)/.test(message)) {
    message = message.length > 0 ? `${message} (HTTP ${error.status})` : `HTTP ${error.status}`;
  }
  return message.length > 0 ? message : 'the compaction failed';
}

/**
 * A failure notice the operator sees: the UI when there is one, stderr
 * otherwise. Never throws, even when Pi's guarded ctx getters reject an
 * invalidated runner: an unreadable ctx still has stderr.
 */
function announce(ctx: HookContext, deps: Deps, message: string): void {
  let headless = true;
  try {
    if (typeof ctx?.ui?.notify === 'function') {
      ctx.ui.notify(message, 'error');
    }
    headless = ctx?.hasUI !== true;
  } catch {
    // A stale ctx: no notification surface is reachable, so fall back to stderr.
  }
  // Headless Pi (print, json, subagents) has a no-op notifier and no dialog surface.
  if (headless) {
    try {
      (deps.stderr ?? console.error)(message);
    } catch {
      // stderr can fail too; telemetry still records the outcome.
    }
  }
}

/**
 * What to do after a Jev failure. Pi's built-in summary is never automatic:
 * only an explicit "Use Pi's summary" returns 'native'. A missing UI, an absent
 * chooser, Escape (undefined), an unexpected label, a throwing prompt, the
 * timeout, or the compaction aborting all cancel, so a Jev failure can never
 * silently hand compaction to Pi. The abort signal is handed to the dialog so
 * Pi dismisses it at once, and is rechecked after the choice: a selection that
 * races the abort must not win.
 */
async function askOnFailure(
  ctx: HookContext,
  attempt: Attempt,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<FailureChoice> {
  try {
    if (signal?.aborted) return 'cancel';
    const ui = ctx?.ui;
    const select = ctx?.hasUI === true && typeof ui?.select === 'function' ? ui.select : undefined;
    if (!select) return 'cancel';
    const opts: { signal?: AbortSignal; timeout?: number } = {};
    if (signal) opts.signal = signal;
    if (timeoutMs !== undefined) opts.timeout = timeoutMs;
    const title = attemptNote('chooser', attempt, ctx);
    const choice = await select.call(ui, title, [...CHOICES], opts);
    if (signal?.aborted) return 'cancel';
    if (choice === RETRY) return 'retry';
    if (choice === NATIVE) return 'native';
    return 'cancel'; // "Cancel compaction", Escape, or any unrecognised answer
  } catch {
    return 'cancel'; // a throwing prompt never falls back to native
  }
}

/** Pi's run mode, read without letting a stale ctx getter throw. */
function safeMode(ctx: HookContext): string | undefined {
  try {
    return ctx?.mode;
  } catch {
    return undefined;
  }
}

/**
 * True only in the Pi CLI process (`pi` runs `dist/cli.js`). An SDK embedder — an
 * in-process workflow, a custom host — runs its own entry point, and its
 * `ctx.mode` defaults to "print" too, so the mode alone cannot tell them apart.
 * Setting a process-global exit code in a library host would be a side effect on
 * someone else's process.
 *
 * `pi` is normally executed through a symlink (the npm bin), and Node reports
 * `process.argv[1]` as the symlink path, so the realpath is what identifies the
 * CLI entry.
 */
export function isPiCliProcess(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return /(?:^|[\\/])dist[\\/]cli\.js$/.test(realpathSync(entry));
  } catch {
    return false;
  }
}

/**
 * A headless (print/json) Jev-failure cancel must end the run nonzero; the CLI's
 * own print-mode exit code does not, because the last assistant message is still
 * a successful stop. Pi's CLI preserves an extension-set `process.exitCode`, so
 * set it — but only in the CLI's print/json process, never in an SDK host or RPC.
 */
function markHeadlessFailure(ctx: HookContext): void {
  try {
    const mode = ctx?.mode;
    if ((mode === 'print' || mode === 'json') && isPiCliProcess()) process.exitCode = 1;
  } catch {
    // An unreadable ctx is still a cancel; it just cannot report through the exit code.
  }
}


export function reportCompactionPass(attempt: CompactionPassAttempt, engine: 'jev' | 'fallback' | 'cancelled', reason: string | null, resolution: string, deps: Deps): void {
  const compaction = engine === 'jev' ? attempt.compaction : undefined;
  const latencyMs = deps.now() - attempt.started;
  deps.last = {
    engine: compaction ? 'jev' : 'fallback',
    reason: compaction ? null : reason,
    tokensBefore: typeof attempt.line.tokens_before === 'number' ? attempt.line.tokens_before : null,
    tokensAfter: compaction ? compaction.estimatedTokensAfter : null,
    latencyMs,
    attemptId: attempt.attemptId,
  };
  try {
    appendJsonLine(join(attempt.logDir, 'compactions.jsonl'), {
      ts: new Date(deps.now()).toISOString(),
      // A marker only this code writes: the rollout's step-3 verification greps for it
      // to tell a new-code row from one an old session wrote during the reload window.
      policy: 'no-fallback',
      ...attempt.line,
      ...attempt.extra,
      engine,
      reason,
      resolution,
      tokens_after: compaction ? compaction.estimatedTokensAfter : null,
      latency_ms: latencyMs,
    });
  } catch {
    // Telemetry never changes the outcome.
  }
}

/**
 * One line in decisions.jsonl for a compactSpan that returned. A throwing or
 * failing write is swallowed, the same as every other telemetry row, and never
 * changes the compaction.
 */
function recordDecisions(
  logDir: string,
  deps: Deps,
  ids: { hookId: string; attemptId: string; sessionId: string | null; configHash: string },
  decisions: CompactOutcome['decisions'],
): void {
  try {
    appendJsonLine(
      join(logDir, 'decisions.jsonl'),
      {
        ts: new Date(deps.now()).toISOString(),
        hook_id: ids.hookId,
        attempt_id: ids.attemptId,
        session_id: ids.sessionId,
        config_hash: ids.configHash,
        ...decisions,
      },
      // Every ledger rotates by default (ledger.ts: 64 MiB, 2 GiB of gzip-compressed siblings).
    );
  } catch {
    // Telemetry never changes the outcome.
  }
}

/** The write one attempt leaves in compactions.jsonl, plus the footer's view of it. */
function report(attempt: Attempt, engine: 'jev' | 'fallback' | 'cancelled', reason: string | null, resolution: string, deps: Deps): void {
  const compaction = engine === 'jev' ? attempt.compaction : undefined;
  const latencyMs = deps.now() - attempt.started;
  deps.last = {
    engine: compaction ? 'jev' : 'fallback',
    reason: compaction ? null : reason,
    tokensBefore: typeof attempt.line.tokens_before === 'number' ? attempt.line.tokens_before : null,
    tokensAfter: compaction ? compaction.estimatedTokensAfter : null,
    latencyMs,
    attemptId: attempt.attemptId,
    resolution,
    ...(attempt.backend ? { backend: attempt.backend } : {}),
    ...(attempt.backend_descriptor ? { backend_descriptor: attempt.backend_descriptor } : {}),
    ...(attempt.line.backend_requests ? { backend_requests: attempt.line.backend_requests as Record<string, number> } : {}),
    ...(attempt.line.backend_responses ? { backend_responses: attempt.line.backend_responses as Record<string, number> } : {}),
  };
  try {
    appendJsonLine(join(attempt.logDir, 'compactions.jsonl'), {
      ts: new Date(deps.now()).toISOString(),
      // A marker only this code writes: the rollout's step-3 verification greps for it
      // to tell a new-code row from one an old session wrote during the reload window.
      policy: 'no-fallback',
      ...attempt.line,
      ...attempt.extra,
      engine,
      reason,
      resolution,
      tokens_after: compaction ? compaction.estimatedTokensAfter : null,
      latency_ms: latencyMs,
    });
  } catch {
    // Telemetry never changes the outcome.
  }
}

export async function handleCompact(event: unknown, ctx: HookContext, deps: Deps, minimumReduction?: number, requestPolicy?: RequestPolicy, onAdmission?: (admission: CommitAdmission) => void): Promise<HookResult> {
  // Before config, the event, or any request: a hook that dies on its first read still has an id.
  const hookId = randomUUID();
  if (requestPolicy && isRecord(event)) event = {...event,jevRequestPolicy:requestPolicy};
  let known: Attempt | undefined;
  try {
    return await runHook(event, ctx, deps, hookId, attempt => { known = attempt; }, minimumReduction, onAdmission);
  } catch (error) {
    // runHook catches its own failures, so this fires only when the failure
    // handling itself failed (a guarded ctx getter on a stale runner, a throwing
    // notifier, a telemetry path that cannot be expanded). Pi treats a thrown
    // handler as "no extension compaction" and would run its built-in summary
    // without consent, so the last resort still returns {cancel:true}.
    return lastResort(ctx, deps, error, hookId, known, event);
  }
}

async function runHook(event: unknown, ctx: HookContext, deps: Deps, hookId: string, remember: (attempt: Attempt) => void, minimumReduction?: number, onAdmission?: (admission: CommitAdmission) => void): Promise<HookResult> {
  const signal = isRecord(event) && event.signal instanceof AbortSignal ? event.signal : undefined;
  const detector = detectorCompaction(event);
  const branchFingerprint = () => {
    try { return JSON.stringify([(ctx as any)?.sessionManager?.getBranch?.(),(ctx as any)?.sessionManager?.getSessionId?.(),(ctx as any)?.sessionManager?.getLeafId?.(),ctx.model,(ctx as any)?.hasPendingMessages?.(),deps.loadConfig(),deps.loadController?.()]); } catch { return undefined; }
  };
  const ownedBranch = detector ? branchFingerprint() : undefined;
  // A detector request whose ownership snapshot cannot be taken has no freshness proof.
  const ownershipUnknown = detector && ownedBranch === undefined;

  /** Record one outcome and, for a final one, update the footer. */
  const settle = (
    attempt: Attempt,
    engine: 'jev' | 'fallback' | 'cancelled',
    reason: string | null,
    resolution: string,
    out: HookResult,
  ): HookResult => {
    report(attempt, engine, reason, resolution, deps);
    // Pi emits no session_compact for a cancelled compaction, so its outcome is not
    // cleared by the marker: drop it here or a later compaction borrows the reason.
    if (resolution === 'cancelled') {
      try {
        deps.last = undefined;
      } catch {
        // Clearing the footer cache never changes the outcome.
      }
    }
    if (resolution === 'jev' && !detector) {
      try {
        const compaction = attempt.compaction!;
        ctx?.ui?.notify?.(successNote(attempt.line, compaction.summary.length, deps.now() - attempt.started, messageWidth(ctx)), 'info');
      } catch {
        // A notification never changes the outcome.
      }
    }
    try {
      // Interactive Pi clears the chat when a compaction ends, which wipes a notification.
      // The footer status survives that redraw, so the last outcome stays visible.
      if (resolution === 'jev') {
        const compaction = attempt.compaction!;
        ctx?.ui?.setStatus?.('jev-compaction', successNote(attempt.line, compaction.summary.length, deps.now() - attempt.started, messageWidth(ctx)));
      } else if (resolution === 'disabled') {
        ctx?.ui?.setStatus?.('jev-compaction', undefined);
      } else if (resolution === 'hosted_retry') {
        ctx?.ui?.setStatus?.('jev-compaction', attemptNote('hosted_retry', attempt, ctx));
      } else if (resolution === 'retry') {
        ctx?.ui?.setStatus?.('jev-compaction', attemptNote('retry', attempt, ctx));
      } else if (resolution === 'native') {
        ctx?.ui?.setStatus?.('jev-compaction', attemptNote('native', attempt, ctx));
      } else if (!detector) {
        ctx?.ui?.setStatus?.('jev-compaction', attemptNote(reason === 'aborted' ? 'abort' : 'cancel', attempt, ctx));
      }
    } catch {
      // A status line never changes the outcome.
    }
    return out;
  };

  let hosted = false;
  let failed: Attempt | undefined;
  for (;;) {
    const pass = await runCompactionPass(event, ctx, deps, signal, hookId, hosted ? 'typesafe' : undefined, failed);
    const attempt = pass.ok ? pass.result : pass.failure;
    if (attempt.decisions) recordDecisions(attempt.logDir, deps, {
      hookId, attemptId: attempt.attemptId, sessionId: sessionIdOf(ctx), configHash: attempt.line.config_hash as string,
    }, attempt.decisions);
    remember(attempt);

    // A user abort always wins: cancel, never prompt, never native.
    if (signal?.aborted === true || attempt.reason === 'aborted') {
      if (!detector) announce(ctx, deps, attemptNote('abort', attempt, ctx));
      return settle(attempt, 'cancelled', 'aborted', 'cancelled', { cancel: true });
    }
    if (attempt.reason === null) {
      if (detector && (ownershipUnknown || branchFingerprint() !== ownedBranch)) return settle(attempt, 'cancelled', 'no_progress', 'cancelled', {cancel:true});
      if (detector && ((minimumReduction !== undefined &&
          attempt.compaction!.tokensBefore - attempt.compaction!.estimatedTokensAfter < minimumReduction) ||
          (isRecord(event) && event.jevRequestPolicy && attempt.compaction!.estimatedTokensAfter > (event.jevRequestPolicy as RequestPolicy).H))) {
        return settle(attempt, 'cancelled', 'no_progress', 'cancelled', { cancel: true });
      }
      // Stage 2: an economic-only request commits only when the rendered candidate's full
      // projected context robustly beats continuing. Quality/excursion/native/manual skip this.
      const policy = detector && isRecord(event) ? event.jevRequestPolicy as RequestPolicy | undefined : undefined;
      if (policy?.kind === 'economic') {
        const admission = admitCommit(policy, { estimatedTokensAfter: attempt.compaction!.estimatedTokensAfter }, deps.now());
        attempt.line.admission = { verdict: admission.verdict, continue: admission.continue, compact: admission.compact, preparation: admission.preparation, afterTokens: admission.afterTokens };
        try { onAdmission?.(admission); } catch { /* Telemetry never changes the outcome. */ }
        if (admission.verdict !== 'economic_committed') return settle(attempt, 'cancelled', 'economic_rejected', 'cancelled', { cancel: true });
      }
      return settle(attempt, 'jev', null, 'jev', { compaction: attempt.compaction! });
    }
    if (attempt.reason === 'disabled') {
      return settle(attempt, 'fallback', 'disabled', 'disabled', undefined);
    }

    // Detector requests are unattended: no chooser, retries, native fallback or CLI exit changes.
    if (detector) return settle(attempt, 'cancelled', attempt.reason, 'cancelled', { cancel: true });

    // A local service failure with the hosted fallback configured: retry once on TypeSafe, first.
    if (!hosted && isLocalServiceFailure(attempt)) {
      hosted = true;
      failed = attempt;
      announce(ctx, deps, attemptNote('hosted_retry', attempt, ctx));
      settle(attempt, 'fallback', attempt.reason, 'hosted_retry', undefined);
      continue;
    }

    // A Jev failure. Pi's built-in summary is never automatic; only an explicit choice runs it.
    const reason = attempt.reason;
    const noticeKey = JSON.stringify([attempt.backend ?? 'unknown', reason]);
    if (!deps.notified.has(noticeKey)) {
      announce(
        ctx,
        deps,
        attemptNote('failure', attempt, ctx, FAILURE_TEXT[reason] ?? 'the compaction failed'),
      );
      deps.notified.add(noticeKey); // tuple of recorded backend ID and reason, process-wide
    }
    // RPC has a dialog but no operator in front of it: prompt with a timeout, taken from
    // config when it loaded. TUI (and an injected test ctx) prompt with no timeout.
    const mode = safeMode(ctx);
    if (mode === 'rpc' && attempt.promptTimeoutMs === undefined) {
      // An unattended client must not hang on a prompt nobody can answer. Without the
      // optional timeout, RPC cancels like a headless run and says why. It never touches
      // process.exitCode: that channel belongs to the CLI's print/json modes alone.
      announce(
        ctx,
        deps,
        attemptNote('rpc', attempt, ctx),
      );
      return settle(attempt, 'cancelled', reason, 'cancelled', { cancel: true });
    }
    const choice = await askOnFailure(ctx, attempt, signal, mode === 'rpc' ? attempt.promptTimeoutMs : undefined);
    if (choice === 'retry') {
      announce(ctx, deps, attemptNote('retry', attempt, ctx));
      settle(attempt, 'fallback', reason, 'retry', undefined);
      continue;
    }
    if (choice === 'native') {
      announce(ctx, deps, attemptNote('native', attempt, ctx));
      return settle(attempt, 'fallback', reason, 'native', undefined);
    }
    let hasChooser = false;
    try { hasChooser = ctx?.hasUI === true && typeof ctx?.ui?.select === 'function'; } catch { /* unavailable */ }
    announce(ctx, deps, attemptNote(signal?.aborted ? 'abort' : hasChooser ? 'cancel' : 'headless', attempt, ctx));
    markHeadlessFailure(ctx);
    return settle(attempt, 'cancelled', signal?.aborted ? 'aborted' : reason, 'cancelled', { cancel: true });
  }
}

/** The local service failed to serve the pass (not a bad answer): the hosted retry applies. */
const LOCAL_SERVICE_FAILURES = new Set(['network', 'timeout', 'http']);
export function isLocalServiceFailure(attempt: Pick<Attempt, 'reason' | 'backend' | 'fallback'>): boolean {
  return attempt.backend === 'local' && attempt.fallback === 'typesafe' && attempt.reason !== null
    && LOCAL_SERVICE_FAILURES.has(attempt.reason);
}

/**
 * The hook's true last resort. Everything it touches is separately guarded, so a
 * failure of the failure handling (Pi's guarded ctx getters, a throwing
 * notifier, an unexpandable telemetry path) still ends as {cancel:true} instead
 * of a throw Pi would read as "let the built-in summary run".
 */
function lastResort(ctx: HookContext, deps: Deps, error: unknown, hookId: string, known?: Attempt, event?: unknown): HookResult {
  const cause = causeOf(error);
  // Its own id: this row is not one of the attempt's, and the attempt may not have started.
  const attemptId = randomUUID();
  try {
    deps.last = undefined;
  } catch {
    // Nothing cached to clear.
  }
  const note = outcomeLine('last_resort', (known?.line ?? {}) as RouteRecord, messageWidth(ctx));
  if (!detectorCompaction(event)) {
    announce(ctx, deps, note);
    try { ctx?.ui?.setStatus?.('jev-compaction', note); } catch { /* unreachable UI */ }
    markHeadlessFailure(ctx);
  }
  try {
    appendJsonLine(join(deps.fallbackLogDir, 'compactions.jsonl'), {
      ts: new Date(deps.now()).toISOString(),
      policy: 'no-fallback',
      ...compactionOrigin(event),
      hook_id: hookId,
      attempt_id: attemptId,
      session_id: sessionIdOf(ctx),
      engine: 'cancelled',
      reason: 'error',
      resolution: 'cancelled',
      cause,
      ...(known?.backend ? { backend: known.backend } : {}),
      ...(known?.backend_descriptor ? { backend_descriptor: known.backend_descriptor } : {}),
    });
  } catch {
    // Telemetry never changes the outcome.
  }
  return { cancel: true };
}

/**
 * The rendered system message, the way Pi renders it: `content` joined, then each `sections`
 * value that is not null. Anything else renders as nothing, so a missing message yields no refs.
 */
function systemMessageText(message: unknown): string {
  if (!isRecord(message)) return '';
  const parts: string[] = [];
  const content = message.content;
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  if (isRecord(message.sections)) {
    for (const value of Object.values(message.sections)) if (typeof value === 'string') parts.push(value);
  }
  return parts.filter(part => part.length > 0).join('\n\n');
}

/** The session cwd, when the hook context exposes one. Omitted rather than guessed otherwise. */
function sessionCwd(ctx: HookContext): string | undefined {
  const cwd = (ctx as { cwd?: unknown }).cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

/** The parts of Pi's extension API the marker uses. */
interface PiMarkerApi {
  on: ExtensionAPI['on'];
  appendEntry: ExtensionAPI['appendEntry'];
  registerEntryRenderer: ExtensionAPI['registerEntryRenderer'];
  /** Present only in a Pi that draws an extension component inside the compaction box. */
  registerCompactionRenderer?: (renderer: unknown) => void;
}

/** The `id` of a compaction or custom entry, when it has one. */
function entryId(entry: unknown): string | null {
  return isRecord(entry) && typeof entry.id === 'string' ? entry.id : null;
}

/** The compaction whose context the next valid assistant response in its session measures. */
interface PendingMeasure {
  compactionId: string;
  /** The commit's own ordering key in epoch ms, or null when Pi did not stamp a parsable one. */
  committedAt: number | null;
  engine: MarkerData['engine'];
  tokensBefore: number | null;
  predictedAfter: number | null;
  hookId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  logDir: string;
}

/** Session-local marker caches and the pending provider measurement. */
interface MarkerState {
  knownMarkers: Map<string, MarkerData>;
  knownMeasured: Map<string, number>;
  pendingMeasure: PendingMeasure | null;
}

/** The marker data with its measured context after, once one is known in this session. */
function withMeasured(data: MarkerData, state: MarkerState | undefined): MarkerData {
  const measured = data.compactionId !== null ? state?.knownMeasured.get(data.compactionId) : undefined;
  return measured === undefined ? data : { ...data, measuredAfter: measured };
}

/**
 * The context a response was sent with, as the provider counted it: `input + cacheRead +
 * cacheWrite`, output excluded. Undefined for an aborted or errored response or no usage.
 */
function promptTokens(message: unknown): number | undefined {
  if (!isRecord(message) || message.role !== 'assistant') return undefined;
  if (message.stopReason === 'aborted' || message.stopReason === 'error') return undefined;
  const usage = message.usage;
  if (!isRecord(usage)) return undefined;
  const part = (key: string): number => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) && (usage[key] as number) > 0 ? (usage[key] as number) : 0);
  const total = part('input') + part('cacheRead') + part('cacheWrite');
  return total > 0 ? total : undefined;
}

/**
 * The count a response measures a compaction committed at `committedAt` with: a response stamped
 * at or before the commit was built from the pre-compaction context, however late it finishes, and
 * measures nothing. A missing or non-finite timestamp on either side keeps the older behaviour: the
 * first valid response measures. One gate for message_end and for session_start's re-derivation.
 */
function measuredBy(committedAt: number | null, message: unknown): number | undefined {
  const answeredAt = isRecord(message) ? message.timestamp : undefined;
  if (committedAt !== null && typeof answeredAt === 'number' && Number.isFinite(answeredAt) && answeredAt <= committedAt) return undefined;
  return promptTokens(message);
}

/**
 * The commit's own ordering key in epoch ms: Pi stamps the compaction entry with `Date.now()`, and
 * the same clock orders a response against it (`assistant.timestamp <= Date.parse(compactionEntry
 * .timestamp)` in Pi core means the response was built from the pre-compaction context). Null when
 * the entry carries no parsable timestamp, which keeps the pre-ordering-key behaviour.
 */
function committedAtOf(entry: unknown): number | null {
  const timestamp = isRecord(entry) && typeof entry.timestamp === 'string' ? entry.timestamp : null;
  if (timestamp === null) return null;
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? at : null;
}

/** Fills the known-marker map from the entries a resumed session already holds. */
function learnMarkers(ctx: unknown, state: MarkerState, remember: (entry: unknown) => void): void {
  try {
    const manager = isRecord(ctx) ? (ctx as { sessionManager?: { getEntries?: unknown } }).sessionManager : undefined;
    if (!manager || typeof manager.getEntries !== 'function') return;
    for (const entry of (manager as { getEntries(): unknown[] }).getEntries()) {
      remember(entry);
      if (isRecord(entry) && entry.type === 'custom' && entry.customType === MEASURED_TYPE && isRecord(entry.data)) {
        const { compactionId, measuredAfter } = entry.data;
        if (typeof compactionId === 'string' && typeof measuredAfter === 'number' && Number.isFinite(measuredAfter)) {
          state.knownMeasured.set(compactionId, measuredAfter);
        }
        continue;
      }
      if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== MARKER_TYPE) continue;
      const data = entry.data as MarkerData | undefined;
      const id = data && typeof data.compactionId === 'string' ? data.compactionId : null;
      if (id !== null && !state.knownMarkers.has(id)) state.knownMarkers.set(id, data);
    }
  } catch {
    // An unreadable session manager leaves the map empty: the box then draws only Jev entries.
  }
}

/**
 * How long `session_shutdown` waits for pending telemetry. Pi's RPC, print and json
 * modes await the shutdown handlers and then call `process.exit()`, which abandons
 * appends still on the worker pool; the bound keeps a stalled filesystem from
 * holding the exit.
 */
export const SHUTDOWN_FLUSH_MS = 2000;

const committedRecorders = new WeakMap<object, (entry: unknown, ctx: unknown) => Promise<void>>();
/** Reuse this registration's session-owned marker/measurement path; no synthetic event. */
export async function recordCommittedCompaction(pi: Pick<ExtensionAPI, 'appendEntry'>, entry: unknown, ctx: unknown, _deps: Deps): Promise<void> {
  await committedRecorders.get(pi)?.(entry, ctx);
}

/** Pi entry point. Keep this package last in `packages[]`: Pi takes the last non-undefined hook result. */
/**
 * Registers the hook, and the chat marker that records which engine produced
 * each saved compaction. The marker never changes a compaction.
 */
export function reconcileCompactionEntry(entry: unknown, event: unknown, ctx: unknown, currentAttemptId?: string): unknown {
  try {
    const branch = (ctx as {sessionManager:{getBranch():any[]}}).sessionManager.getBranch();
    const e = event as any;
    const requestId = e?.requestId;
    const attemptId = currentAttemptId ?? (isRecord(entry) && isRecord(entry.details) && isRecord(entry.details.jev) ? entry.details.jev.attempt_id : undefined);
    if (typeof requestId !== 'string' && typeof attemptId !== 'string') return entry;
    return [...branch].reverse().find(b=>b.type==='compaction' && b.fromHook !== false &&
      (typeof requestId === 'string' ? b.details?.jev?.requestId === requestId : b.details?.jev?.attempt_id === attemptId)) ?? entry;
  } catch { return entry; }
}
export function register(pi: Pick<ExtensionAPI, 'on' | 'appendEntry' | 'registerEntryRenderer'>, deps: Deps, detectorDeps?: DetectorDeps): void {
  const detector = shadowObserver(detectorDeps ?? {
    loadDetector: () => loadDetectorConfig(), loadController: deps.loadController, loadCompaction: deps.loadConfig,
    getSettings: () => (pi as unknown as Pick<ExtensionAPI, 'getSettings'>).getSettings(),
    native: installedDetectorApi, questionLimit: detectorQuestionLimit, now: deps.now, fallbackLogDir: deps.fallbackLogDir, write: writeDetectorRow,
    makeAsker: (config, hash, signal, attemptId) => deps.makeAsker(config, hash, signal, { hookId: attemptId, attemptId }),
    estimator: deps.estimator,
  });
  pi.on('agent_settled', (_event, ctx) => { detector.settled(ctx as DetectorContext); });
  pi.on('input', (_event, ctx) => { detector.invalidate(ctx); });
  pi.on('model_select', (_event, ctx) => { detector.invalidate(ctx); });
  pi.on('session_start', (_event, ctx) => { detector.reset(ctx); });
  pi.on('session_shutdown', (_event, ctx) => { detector.reset(ctx); });
  pi.on('session_before_switch', (_event, ctx) => { detector.invalidate(ctx); });
  pi.on('session_before_fork', (_event, ctx) => { detector.invalidate(ctx); });
  pi.on('session_before_tree', (_event, ctx) => { detector.invalidate(ctx); });
  pi.on('session_tree', (_event, ctx) => {
    try {
      detector.invalidate(ctx);
      const state = stateFor(ctx);
      // Returning to an unanswered compaction restores it even after navigating
      // to a compaction-free branch cleared the pending measurement.
      state.pendingMeasure = rederivePending(ctx, state);
    } catch {
      // Telemetry never changes tree navigation.
    }
  });
  pi.on('session_before_compact', (event, ctx) => { if (!detectorCompaction(event)) detector.compaction(ctx as DetectorContext); else detector.consuming(event,ctx as DetectorContext); });
  pi.on('session_compact', (event, ctx) => { if (!detectorCompaction(event)) detector.compaction(ctx as DetectorContext); else detector.committed({...event,compactionEntry:reconcileCompactionEntry(event.compactionEntry,event,ctx)},ctx as DetectorContext); });
  pi.on('session_compact_failed', (event, ctx) => { if (!detectorCompaction(event)) detector.compaction(ctx as DetectorContext); else detector.invalidate(ctx); });
  // Feature detection is on ctx at arming; old Pi may register this additive event harmlessly.
  (pi.on as (name: string, handler: (event: unknown, ctx: DetectorContext) => void) => void)('compaction_request_end',
    (event, ctx) => { detector.requestEnd(event, ctx); });
  const api = pi as unknown as PiMarkerApi;
  const boxed = typeof api.registerCompactionRenderer === 'function';
  // Renderer callbacks have no ctx: ownership comes from entries, never the last hook.
  const sessions = new Map<string | null, MarkerState>();
  const entryOwners = new WeakMap<object, MarkerState>();
  const compactionOwners = new Map<string, Set<MarkerState>>();
  const remember = (entry: unknown, state: MarkerState): void => {
    if (!isRecord(entry)) return;
    const custom = entry.type === 'custom' && (entry.customType === MARKER_TYPE || entry.customType === MEASURED_TYPE);
    const data = custom && isRecord(entry.data) ? entry.data : undefined;
    const id = data && typeof data.compactionId === 'string' ? data.compactionId : entry.type === 'compaction' ? entryId(entry) : null;
    if (id === null) return;
    entryOwners.set(entry, state);
    if (data) entryOwners.set(data, state);
    let owners = compactionOwners.get(id);
    if (!owners) compactionOwners.set(id, owners = new Set());
    owners.add(state);
  };
  const forget = (state: MarkerState): void => {
    for (const [id, owners] of compactionOwners) {
      owners.delete(state);
      if (owners.size === 0) compactionOwners.delete(id);
    }
  };
  const ownerOf = (entry: unknown, id: string | null): MarkerState | undefined => {
    const exact = isRecord(entry) ? entryOwners.get(entry) ?? (isRecord(entry.data) ? entryOwners.get(entry.data) : undefined) : undefined;
    if (exact) return exact;
    const owners = id === null ? undefined : compactionOwners.get(id);
    // A detached legacy entry can be resolved by id only when it is unambiguous.
    return owners?.size === 1 ? owners.values().next().value : undefined;
  };
  const stateFor = (ctx: unknown): MarkerState => {
    const id = sessionIdOf(ctx as HookContext);
    let state = sessions.get(id);
    if (!state) {
      state = { knownMarkers: new Map(), knownMeasured: new Map(), pendingMeasure: null };
      sessions.set(id, state);
    }
    return state;
  };
  const tools = pi as unknown as { registerTool?: Parameters<typeof registerExpandTool>[0]['registerTool'] };
  if (typeof tools.registerTool === 'function') registerExpandTool(tools as Parameters<typeof registerExpandTool>[0], (row, ctx) => {
    // expansions.jsonl: the regret signal. Ids, hashes and counts only; never awaited.
    try {
      let logDir = deps.fallbackLogDir;
      try {
        const loaded = deps.loadConfig();
        if (loaded.ok) logDir = dirname(expandHome(loaded.config.telemetry.path));
      } catch {
        // The fallback directory still receives the row.
      }
      appendJsonLine(join(logDir, 'expansions.jsonl'), { ts: new Date(deps.now()).toISOString(), session_id: sessionIdOf(ctx), ...row });
    } catch {
      // Telemetry never changes what jev_expand returns.
    }
  });
  pi.on('session_before_compact', async (event, ctx) => {
    try {
      const minimum = detector.minimumReduction(event,ctx as DetectorContext);
      if (detectorCompaction(event) && minimum === undefined) return { cancel: true };
      // Gate fresh preparation, never extrapolate unsampled assessment-time savings.
      return await handleCompact(event, ctx as HookContext, deps, minimum, detector.requestPolicy(event), verdict => detector.admission(event, verdict));
    } catch {
      // A throw here would be swallowed by Pi's runner and read as "no extension
      // compaction", which runs the built-in summary without consent. Fail closed.
      return { cancel: true };
    }
  });
  /** The measurement a committed compaction waits for: one construction for commit and session_start. */
  const pendingFor = (entry: unknown, id: string, data: MarkerData, ctx: unknown): PendingMeasure => {
    const jev = isRecord(entry) && isRecord(entry.details) && isRecord(entry.details.jev) ? entry.details.jev : {};
    let logDir = deps.fallbackLogDir;
    try {
      const loaded = deps.loadConfig();
      if (loaded.ok) logDir = dirname(expandHome(loaded.config.telemetry.path));
    } catch {
      // The fallback directory still receives the row.
    }
    return {
      compactionId: id,
      committedAt: committedAtOf(entry),
      engine: data.engine,
      tokensBefore: data.tokensBefore,
      predictedAfter: data.predictedAfter ?? entryMarker(entry).predictedAfter,
      hookId: typeof jev.hook_id === 'string' ? jev.hook_id : null,
      attemptId: typeof jev.attempt_id === 'string' ? jev.attempt_id : null,
      sessionId: sessionIdOf(ctx as HookContext),
      logDir,
    };
  };
  /** One root-to-leaf lookup for both restart re-derivation and tree reconciliation. */
  const newestBranchCompaction = (ctx: unknown): { entries: unknown[]; newest: number } | null => {
    try {
      const manager = isRecord(ctx) ? (ctx as { sessionManager?: { getBranch?: unknown } }).sessionManager : undefined;
      // Without getBranch, fail closed: unmeasured is safer than attributing another branch's count.
      if (!manager || typeof manager.getBranch !== 'function') return null;
      const entries = (manager as { getBranch(): unknown[] }).getBranch();
      let newest = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (isRecord(entry) && entry.type === 'compaction') { newest = i; break; }
      }
      return { entries, newest };
    } catch {
      // An unreadable branch cannot safely supply a pending measurement.
      return null;
    }
  };
  /**
   * A reload or resume restarts the extension between a compaction and its first response. The
   * newest compaction is still waiting only when no measured entry names it, no saved response
   * already passed message_end's gate for it (else the next response would be measured as if it
   * were the first: a compaction answered before pi-jev ran, or by a version that never measured),
   * and this session committed it rather than copied it from a parent at a fork or branch.
   */
  const rederivePending = (ctx: unknown, state: MarkerState): PendingMeasure | null => {
    try {
      const branch = newestBranchCompaction(ctx);
      if (!branch || branch.newest < 0) return null;
      const { entries, newest } = branch;
      const manager = (ctx as { sessionManager: { getHeader?: unknown } }).sessionManager;
      const entry = entries[newest];
      const id = entryId(entry);
      if (id === null || state.knownMeasured.has(id)) return null;
      const committedAt = committedAtOf(entry);
      for (const later of entries.slice(newest + 1)) {
        if (isRecord(later) && later.type === 'custom' && later.customType === MEASURED_TYPE
          && isRecord(later.data) && later.data.compactionId === id) return null;
        if (isRecord(later) && later.type === 'message' && measuredBy(committedAt, later.message) !== undefined) return null;
      }
      // A forked or branched session file starts with copies of its parent's entries, stamped before
      // the header; a compaction that cannot be placed after the header is treated as copied.
      const header = typeof (manager as { getHeader?: unknown }).getHeader === 'function'
        ? (manager as { getHeader(): unknown }).getHeader()
        : null;
      if (isRecord(header) && typeof header.parentSession === 'string') {
        const forkedAt = typeof header.timestamp === 'string' ? Date.parse(header.timestamp) : NaN;
        if (committedAt === null || !Number.isFinite(forkedAt) || committedAt <= forkedAt) return null;
      }
      return pendingFor(entry, id, state.knownMarkers.get(id) ?? entryMarker(entry), ctx);
    } catch {
      // An unreadable session manager leaves nothing pending, as before.
      return null;
    }
  };
  pi.on('session_start', (event, ctx) => {
    // Refresh only this session: another live session may still be awaiting a response.
    const state = stateFor(ctx);
    forget(state);
    state.knownMarkers.clear();
    state.knownMeasured.clear();
    state.pendingMeasure = null;
    learnMarkers(ctx, state, entry => remember(entry, state));
    // A fork copies the parent's entries; re-deriving there would measure the parent's compaction
    // a second time, from the fork's response, so a fork starts with nothing pending (and a later
    // resume of the fork skips the copies by the header check in rederivePending).
    if (!(isRecord(event) && event.reason === 'fork')) state.pendingMeasure = rederivePending(ctx, state);
  });
  const recordCommit = async (entry: unknown, ctx: unknown) => {
    try {
      const state = stateFor(ctx);
      let after: number | null = null;
      try {
        after = (await deps.contextAfter?.(ctx)) ?? null;
      } catch {
        // The estimate is optional: the marker still says which engine ran.
      }
      const last = deps.last;
      deps.last = undefined;
      const data = markerFor(entry, last, after);
      remember(entry, state);
      remember({ type: 'custom', customType: MARKER_TYPE, data }, state);
      const id = data.compactionId ?? entryId(entry);
      if (id !== null) state.knownMarkers.set(id, data);
      if (id !== null) state.pendingMeasure = pendingFor(entry, id, data, ctx);
      // Deferred when Pi has no box hook: the entry is appended after Pi's own
      // compaction redraw, so it lands directly under the box instead of above it.
      const write = () => {
        try {
          pi.appendEntry(MARKER_TYPE, data);
        } catch {
          // A closed or switched session can refuse the entry. The append runs outside Pi's
          // handler when deferred, so a throw here would be an uncaught exception.
        }
      };
      if (boxed) write();
      else (deps.defer ?? setImmediate)(write);
    } catch {
      // The marker never changes the compaction.
    }
  };
  committedRecorders.set(pi, recordCommit);
  pi.on('session_compact', (event, ctx) => recordCommit(reconcileCompactionEntry(event.compactionEntry,event,ctx,deps.last?.attemptId), ctx));
  pi.on('message_end', (event, ctx) => {
    try {
      const state = stateFor(ctx);
      const pending = state.pendingMeasure;
      if (!pending) return;
      const message = isRecord(event) ? event.message : undefined;
      // A response the gate rejects leaves the measurement pending for the first response the
      // commit's own context produced.
      const measured = measuredBy(pending.committedAt, message);
      if (measured === undefined) return;
      state.pendingMeasure = null;
      state.knownMeasured.set(pending.compactionId, measured);
      const model = isRecord(message) && typeof message.model === 'string' ? message.model : null;
      try {
        pi.appendEntry(MEASURED_TYPE, { version: 1, compactionId: pending.compactionId, measuredAfter: measured, model });
      } catch {
        // A closed session can refuse the entry; the box still shows the figure in this process.
      }
      appendJsonLine(join(pending.logDir, 'measurements.jsonl'), {
        ts: new Date(deps.now()).toISOString(),
        hook_id: pending.hookId,
        attempt_id: pending.attemptId,
        session_id: pending.sessionId,
        compaction_id: pending.compactionId,
        engine: pending.engine,
        model,
        tokens_before: pending.tokensBefore,
        predicted_after: pending.predictedAfter,
        measured_after: measured,
      });
    } catch {
      // A measurement never changes a response.
    }
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    const id = sessionIdOf(ctx as HookContext);
    const state = sessions.get(id);
    if (state) {
      forget(state);
      state.knownMarkers.clear();
      state.knownMeasured.clear();
      state.pendingMeasure = null;
      sessions.delete(id);
    }
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>(resolve => {
      timer = setTimeout(resolve, SHUTDOWN_FLUSH_MS);
    });
    try {
      await Promise.race([flushTelemetry(), bound]);
    } catch {
      // Telemetry never fails a shutdown.
    } finally {
      clearTimeout(timer);
    }
  });
  if (boxed) {
    api.registerCompactionRenderer!((entry: unknown, options: CompactionRenderOptions, theme: Parameters<typeof renderCompactionBox>[2]) => {
      try {
        const state = ownerOf(entry, entryId(entry));
        const compaction = isRecord(entry) ? entry : {};
        const details = isRecord(compaction.details) ? compaction.details : {};
        if (isRecord(details.jev)) {
          const data = entryMarker(entry);
          return renderCompactionPresentation(() => withMeasured(data, state), options, theme);
        }
        const known = state?.knownMarkers.get(entryId(entry) ?? '');
        const data = known ?? entryMarker(entry);
        return renderCompactionPresentation(() => withMeasured(data, state), options, theme);
      } catch {
        return undefined;
      }
    });
  }
  // With the box hook the entry renderer draws nothing: the box already shows the result.
  const marker = (entry: { data?: unknown }, options: { expanded: boolean }, theme: Parameters<typeof renderMarker>[2]) => {
    const data = entry.data as MarkerData | undefined;
    const state = ownerOf(entry, data?.compactionId ?? null);
    return renderMarker(entry, options, theme, data => withMeasured(data, state));
  };
  pi.registerEntryRenderer(MARKER_TYPE, (boxed ? () => undefined : marker) as Parameters<ExtensionAPI['registerEntryRenderer']>[1]);
  pi.registerEntryRenderer(MEASURED_TYPE, (() => undefined) as Parameters<ExtensionAPI['registerEntryRenderer']>[1]);
}

export default function jevCompaction(pi: ExtensionAPI): void {
  register(pi, {
    loadConfig: () => loadConfig(),
    loadController: () => loadControllerConfig(),
    makeAsker: (config, configHash, signal, context) =>
      createCompactionAsker(config, configHash, signal, context),
    compact: compactSpan,
    // The same projection Pi builds after a compaction, so the budget is measured the way Pi measures it.
    estimator: async () => {
      const { buildSessionProjection, estimateTokens } = await import('@earendil-works/pi-coding-agent');
      // The function Pi's own `appendCompaction` uses for the system message it records.
      const { getCurrentSystemMessage } = await import('@earendil-works/pi-ai');
      return productionEstimator(buildSessionProjection as never, estimateTokens as never, getCurrentSystemMessage as never);
    },
    notified: new Set(),
    fallbackLogDir: expandHome(DEFAULT_TELEMETRY_DIR),
    now: Date.now,
    // The same figure Pi computes after it saves a compaction: estimateTokens over the new projection.
    contextAfter: async ctx => {
      const { estimateTokens } = await import('@earendil-works/pi-coding-agent');
      const manager = (ctx as { sessionManager: { buildSessionProjection(): { messages: AgentMessage[] } } }).sessionManager;
      return manager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    },
    defer: fn => void setImmediate(fn),
  });
}
