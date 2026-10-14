import { setTimeout as pause } from 'node:timers/promises';
import { validatedRequestedAnswers } from './answer-validation.js';
import { localDescriptor } from './backend-descriptor.js';
import type { CoreAsker } from '../core/judge.js';
import type { JevQuestions, JevResponse, JevState } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { estimateTokens } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { effectiveAskerModel, expandHome, isLocalDecisionEndpoint, type JevConfig } from './config.js';
import { JevError, MAX_RESPONSE_BYTES, readCapped, type AskerContext, type AskCall } from './jev-client.js';
import { appendJsonLine, isCount } from './ledger.js';

/** The service refuses a work deadline above this; a longer client timeout still bounds the wait. */
export const SERVICE_DEADLINE_CAP_MS = 180_000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw new JevError('parse', 'Local decision service returned invalid or incomplete typed answers'); };

/** Validate every requested answer before returning any decision to the pruning core. */
export function validateLocalAnswers(raw: unknown, questions: JevQuestions, model: string): JevResponse {
  if (!record(raw) || raw.model !== model || !record(raw.answers)) return invalid();
  const ids = Object.keys(questions);
  if (Object.keys(raw.answers).length !== ids.length || Object.keys(raw.answers).some(id => !Object.hasOwn(questions, id))) return invalid();
  const answers = validatedRequestedAnswers(raw.answers, questions);
  if (!answers) return invalid();
  const usage = record(raw.usage) ? raw.usage : undefined;
  return { model, answers, ...(usage ? { usage: {
    input_tokens: isCount(usage.input_tokens) ? usage.input_tokens : undefined,
    output_tokens: isCount(usage.output_tokens) ? usage.output_tokens : undefined,
  } } : {}) };
}

export interface LocalClientOptions {
  config: JevConfig;
  configHash: string;
  caller: string;
  context?: AskerContext;
}

/** Dedicated unauthenticated loopback client. No environment/key access or cloud fallback. */
export class LocalDecisionClient implements CoreAsker {
  private requests = 0;
  private responses = 0;
  /** Responses accepted by this client, not merely attempted fetches or HTTP 2xx. */
  get responseCount() { return this.responses; }
  private verifiedRevision: string | undefined;
  get requestCount() { return this.requests; }
  get backend_descriptor() { return { ...localDescriptor(this.options.config),
    ...(this.verifiedRevision ? { verified_revision: this.verifiedRevision } : {}) }; }
  private readonly endpoint: string;
  private readonly model: string;
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private pending = 0;
  private burstFailed = false;
  private burstError: unknown;
  constructor(private readonly options: LocalClientOptions, private readonly signal?: AbortSignal) {
    if (options.config.api.backend !== 'local' || !isLocalDecisionEndpoint(options.config.api.localEndpoint)) {
      throw new Error('Local decision endpoint is not configured');
    }
    this.endpoint = options.config.api.localEndpoint;
    this.model = effectiveAskerModel(options.config);
    this.limit = options.config.api.localMaxInflight ?? 1;
  }
  /** FIFO slots: a released slot passes straight to the oldest waiter. */
  private acquire(): Promise<void> {
    if (this.active < this.limit) { this.active += 1; return Promise.resolve(); }
    return new Promise(resolve => this.waiters.push(resolve));
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.active -= 1;
  }
  async ask(state: JevState, questions: JevQuestions, call?: AskCall): Promise<JevResponse> {
    // Core windows may arrive concurrently. One local GPU request occupies the
    // slot through body consumption and validation; cloud scheduling is separate.
    // Snapshot before queueing so caller mutation cannot alter a delayed request.
    let snapshot: [JevState, JevQuestions, AskCall | undefined] | undefined;
    let snapshotError: JevError | undefined;
    try { snapshot = structuredClone([state, questions, call]); }
    catch { snapshotError = new JevError('parse', 'Local decision request could not be processed'); }
    const api = this.options.config.api;
    const timeoutMs = api.localTimeoutMs ?? Math.min(api.timeoutMs, api.retryBudgetMs, SERVICE_DEADLINE_CAP_MS);
    const started = Date.now();
    const deadline = started + timeoutMs;
    const retryDeadline = Math.min(deadline, started + api.retryBudgetMs);
    const queuedTimeout = AbortSignal.timeout(timeoutMs);
    this.pending += 1;
    const operation = (async () => {
      await this.acquire();
      try {
        if (this.signal?.aborted) throw new JevError('aborted', 'Local decision request aborted');
        if (queuedTimeout.aborted || deadline - Date.now() < 100) throw new JevError('timeout', 'Local decision request timed out');
        if (this.burstFailed) throw this.burstError;
        if (snapshotError) throw snapshotError;
        // Keep the FIFO slot through retries, within the original queue-inclusive deadline.
        for (let retry = 0; ; retry++) {
          try {
            return await this.dispatch(snapshot![0], snapshot![1], snapshot![2], retry === 0 ? deadline : retryDeadline, queuedTimeout, retry);
          } catch (error) {
            if (!(error instanceof JevError) || !error.transient || retry >= api.maxRetries) throw error;
            const backoff = Math.min(api.retryBackoffMaxMs, api.retryBackoffMs * 2 ** retry);
            const delay = backoff * (1 - Math.random() * api.retryJitter);
            // Leave the protocol's 100ms minimum for another dispatch. Exhaustion keeps
            // the HTTP failure, rather than masking it as a timeout without a request.
            if (Date.now() + delay + 100 >= retryDeadline) throw error;
            try {
              await pause(delay, undefined, { signal: AbortSignal.any([queuedTimeout, ...(this.signal ? [this.signal] : [])]) });
            } catch {
              throw new JevError(this.signal?.aborted ? 'aborted' : 'timeout', 'Local decision request cancelled during backoff');
            }
          }
        }
      } catch (error) {
        // Mark the burst failed before the slot passes on, so no queued sibling sends after a failure.
        if (!this.burstFailed) { this.burstFailed = true; this.burstError = error; }
        throw error;
      } finally {
        this.release();
      }
    })().catch(error => {
      if (!this.burstFailed) { this.burstFailed = true; this.burstError = error; }
      throw error;
    });
    const done = operation.finally(() => {
      this.pending -= 1;
      // Do not release a failed burst when Promise.all first rejects: queued
      // siblings must drain without sending more source content to the service.
      if (this.pending === 0) { this.burstFailed = false; this.burstError = undefined; }
    });
    return done;
  }

  private async dispatch(state: JevState, questions: JevQuestions, call: AskCall | undefined,
    deadline: number, queuedTimeout: AbortSignal, retry: number): Promise<JevResponse> {
    const { config, configHash, caller, context } = this.options;
    const started = Date.now();
    let requestBytes = 0;
    let estimatedInput = 0;
    let attempted = false;
    let httpStatus: number | null = null;
    let retryable = false;
    const finish = (outcome: string, usage?: JevResponse['usage']) => {
      if (!attempted) return;
      try {
        appendJsonLine(expandHome(config.telemetry.path), {
          ts: new Date(started).toISOString(), caller, backend: 'local', model: this.model,
          latency_ms: Date.now() - started, outcome,
          input_tokens: isCount(usage?.input_tokens) ? usage!.input_tokens : estimatedInput,
          output_tokens: isCount(usage?.output_tokens) ? usage!.output_tokens : 0,
          request_bytes: requestBytes, question_count: Object.keys(questions).length,
          config_hash: configHash, hook_id: context?.hookId ?? null, attempt_id: context?.attemptId ?? null,
          round: call?.round ?? null, batch: call?.batch ?? null, retry,
          http_status: httpStatus, retryable,
        });
      } catch { /* Telemetry must never change a decision. */ }
    };
    try {
      if (this.signal?.aborted) throw new JevError('aborted', 'Local decision request aborted');
      if (Object.keys(questions).length === 0 || Object.values(questions).some(question =>
        !question || !['noul', 'score', 'choice'].includes(question.type) || typeof question.instructions !== 'string'
        || question.instructions.trim().length === 0
        || (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2))
        || (question.type === 'choice' && (!record(question.criteria) || Object.keys(question.criteria).length < 2)))) {
        throw new JevError('parse', 'Local decision questions are invalid');
      }
      const body = JSON.stringify({ model: this.model, state, questions });
      estimatedInput = estimateTokens(body);
      requestBytes = Buffer.byteLength(body);
      const timeoutMs = deadline - Date.now();
      if (timeoutMs < 100) throw new JevError('timeout', 'Local decision request timed out');
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([queuedTimeout, timeout, ...(this.signal ? [this.signal] : [])]);
      let response: Response;
      let text: string | undefined;
      try {
        attempted = true;
        this.requests += 1;
        response = await fetch(this.endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-request-timeout-ms': String(Math.min(timeoutMs, SERVICE_DEADLINE_CAP_MS)) }, body,
          redirect: 'error', signal,
        });
        httpStatus = response.status;
        text = await readCapped(response, MAX_RESPONSE_BYTES);
      } catch {
        if (this.signal?.aborted) throw new JevError('aborted', 'Local decision request aborted');
        if (timeout.aborted || queuedTimeout.aborted) throw new JevError('timeout', 'Local decision request timed out');
        throw new JevError('network', 'Local decision service unavailable or redirect refused');
      }
      // readCapped can reject declared length before acquiring a reader.
      if (text === undefined && response.body && !response.body.locked) {
        try { await response.body.cancel(); } catch { /* The request still fails closed. */ }
      }
      if (!response.ok) {
        // ssh_exec_relay.py distinguishes admission saturation from transport failures.
        // Only its exact busy response is retryable; 429 yield and other 503s stay one-shot.
        let busy = false;
        if (response.status === 503 && text !== undefined) {
          try { const raw: unknown = JSON.parse(text); busy = record(raw) && raw.error === 'decision relay busy'; } catch { /* not a busy response */ }
        }
        retryable = busy;
        throw new JevError('http', 'Local decision service returned HTTP ' + response.status, response.status, undefined, busy);
      }
      if (text === undefined) throw new JevError('http', 'Local decision response exceeds the size cap');
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new JevError('parse', 'Local decision service returned invalid JSON'); }
      // A different model or revision behind the endpoint is the wrong service, not a bad answer:
      // a service failure, so the configured TypeSafe fallback applies. The revision is the
      // service's launch label; it guards against a mistaken relaunch, not a deliberate swap.
      if (record(raw) && (raw.model !== this.model || (config.api.localRevision !== undefined && raw.revision !== config.api.localRevision))) {
        throw new JevError('http', 'Local decision service is not the configured model and revision');
      }
      const parsed = validateLocalAnswers(raw, questions, this.model);
      // Only a fully validated response verifies the configured service identity.
      if (record(raw) && typeof raw.revision === 'string' && raw.revision.trim() &&
          !/[\x00-\x20\x7f-\x9f\x1b]/.test(raw.revision)) this.verifiedRevision = raw.revision;
      this.responses += 1;
      finish('ok', parsed.usage);
      return parsed;
    } catch (error) {
      finish(error instanceof JevError ? error.kind : 'parse');
      if (error instanceof JevError) throw error;
      throw new JevError('parse', 'Local decision request or response could not be processed');
    }
  }
}
