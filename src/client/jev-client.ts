import { hasHostedRequestedAnswers } from './answer-validation.js';
import { hostedDescriptor } from './backend-descriptor.js';
import {
  estimateTokens,
  parseJevResponse,
  type JevQuestions,
  type JevResponse,
  type JevState,
} from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import type { CoreAsker } from '../core/judge.js';
import { expandHome, type JevConfig } from './config.js';
import { appendJsonLine, isCount } from './ledger.js';

/**
 * Security invariants (spec: Shared client). They are constants, not config,
 * so no config edit can send the key or conversation content anywhere else.
 * Changing them takes a reviewed code change.
 */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_KEY_ENV = 'TYPESAFE_API_KEY';
/** Sanity bound, not a tunable: a batch of Jev answers is a few kilobytes. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function isLoopback(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    // Literal addresses only: a name such as localhost resolves through the hosts file or DNS.
    return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === '[::1]');
  } catch {
    return false;
  }
}

/** The body as text, or `undefined` once it exceeds `limit` bytes. */
export async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type JevErrorKind = 'auth' | 'timeout' | 'http' | 'network' | 'parse' | 'aborted';

export class JevError extends Error {
  constructor(
    readonly kind: JevErrorKind,
    message: string,
    /** The HTTP status, when Jev answered with one. */
    readonly status?: number,
    /** The server's requested delay (`retry-after-ms` or `Retry-After`), when it gave one. */
    readonly retryAfterMs?: number,
    /** Set where the failure is raised: a later attempt may succeed. */
    readonly transient: boolean = false,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

/** TypeSafe's documented retryable statuses: 408, 429 and every 5xx (529 is "system_overloaded"). */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** The delay a response asks for: `retry-after-ms`, else `Retry-After` in seconds or as an HTTP date. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const after = headers.get('retry-after');
  if (after === null) return undefined;
  const seconds = Number(after);
  if (after.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Waits `ms`; false when `signal` aborts first. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const done = (completed: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = (): void => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The attempt these calls belong to. Fixed for the client's life; absent in a bare test client. */
export interface AskerContext {
  hookId: string;
  attemptId: string;
}

/** Which batch of which judge round one `ask` serves. Captured per call, never on the client. */
export interface AskCall {
  round: 'span' | 'carry';
  batch: number;
}

export interface JevClientOptions {
  config: JevConfig;
  configHash: string;
  /** Names the consumer in telemetry, e.g. `pi-compaction`. */
  caller: string;
  /** Tests only: a local stub. Production code never passes it, so the endpoint stays the constant. */
  endpoint?: string;
  /** Tests only: the environment the key is read from. */
  env?: Record<string, string | undefined>;
  /** The attempt's correlation ids, written on every calls.jsonl row. */
  context?: AskerContext;
}

interface Sent {
  bytes: number;
  input: number;
  output: number;
}
const UNSENT: Sent = { bytes: 0, input: 0, output: 0 };

export class JevHttpClient implements CoreAsker {
  private requests = 0;
  private responses = 0;
  /** Responses accepted by this client, not merely attempted fetches or HTTP 2xx. */
  get responseCount() { return this.responses; }
  get requestCount() { return this.requests; }
  get backend_descriptor() { return hostedDescriptor(this.options.config); }
  private readonly endpoint: string;

  constructor(
    private readonly options: JevClientOptions,
    private readonly signal?: AbortSignal,
  ) {
    if (options.endpoint !== undefined && !isLoopback(options.endpoint)) {
      throw new Error('JevHttpClient: an endpoint override must be a loopback test stub');
    }
    this.endpoint = options.endpoint ?? JEV_ENDPOINT;
  }

  /**
   * One Jev call, retried on TypeSafe's documented retryable failures with
   * doubling, jittered backoff (or the server's requested delay), within
   * `retry_budget_ms` for the whole call. Each attempt is logged on its own.
   * A retry whose delay would reach the budget is not made.
   */
  async ask(state: JevState, questions: JevQuestions, call?: AskCall): Promise<JevResponse> {
    const { api } = this.options.config;
    const deadline = Date.now() + api.retryBudgetMs;
    for (let retry = 0; ; retry++) {
      try {
        return await this.attempt(state, questions, deadline, retry, call);
      } catch (error) {
        if (!(error instanceof JevError) || !error.transient || retry >= api.maxRetries) throw error;
        const backoff = Math.min(api.retryBackoffMaxMs, api.retryBackoffMs * 2 ** retry);
        const delay = error.retryAfterMs ?? backoff * (1 - Math.random() * api.retryJitter);
        if (Date.now() + delay >= deadline) throw error;
        if (!(await pause(delay, this.signal))) throw new JevError('aborted', 'Jev request aborted');
      }
    }
  }

  private async attempt(
    state: JevState,
    questions: JevQuestions,
    deadline: number,
    retry: number,
    call: AskCall | undefined,
  ): Promise<JevResponse> {
    const { config, configHash, caller, context } = this.options;
    const ledger = expandHome(config.telemetry.path);
    const body = JSON.stringify({ model: config.api.model, state, questions });
    const estimate = estimateTokens(body);
    const started = Date.now();

    // One telemetry line per attempt. The line carries counts only: no message
    // content, no question text, no key. A write failure is swallowed: a bad
    // telemetry path must neither fail nor block the call, nor look like a Jev
    // error, so the ledger row is never read back to gate anything.
    const finish = (outcome: string, sent: Sent): void => {
      try {
        appendJsonLine(ledger, {
          ts: new Date(started).toISOString(),
          caller,
          backend: 'typesafe',
          model: config.api.model,
          latency_ms: Date.now() - started,
          outcome,
          input_tokens: sent.input,
          output_tokens: sent.output,
          request_bytes: sent.bytes,
          question_count: Object.keys(questions).length,
          config_hash: configHash,
          hook_id: context?.hookId ?? null,
          attempt_id: context?.attemptId ?? null,
          round: call?.round ?? null,
          batch: call?.batch ?? null,
          retry,
        });
      } catch {
        // Telemetry never breaks a call.
      }
    };
    const fail = (kind: JevErrorKind, message: string, sent: Sent = UNSENT, status?: number, after?: number, transient = false): never => {
      finish(kind, sent);
      throw new JevError(kind, message, status, after, transient);
    };

    const key = (this.options.env ?? process.env)[JEV_KEY_ENV] ?? '';
    if (key.length === 0) fail('auth', `${JEV_KEY_ENV} is not set`);
    if (this.signal?.aborted) fail('aborted', 'Jev request aborted');

    // An attempt never outlives the call's retry budget.
    const timeoutMs = Math.max(1, Math.min(config.api.timeoutMs, deadline - Date.now()));
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    const sent: Sent = { bytes: Buffer.byteLength(body), input: estimate, output: 0 };
    let response: Response;
    let text: string | undefined;
    try {
      this.requests += 1;
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        // Not followed: a 3xx is refused below, so the key never reaches another host.
        redirect: 'manual',
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        return fail('network', `Jev answered with a redirect (HTTP ${response.status}); refused`, sent, response.status);
      }
      text = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof JevError) throw error;
      const kind: JevErrorKind = this.signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'network';
      const message =
        kind === 'network'
          ? 'Jev request failed without a response (network, TLS or a refused redirect)'
          : kind === 'timeout'
            ? `Jev request timed out after ${timeoutMs} ms`
            : 'Jev request aborted';
      // A transport failure or a timeout may pass; a caller abort does not.
      return fail(kind, message, sent, undefined, undefined, kind !== 'aborted');
    }
    if (text === undefined) fail('http', `Jev response exceeds ${MAX_RESPONSE_BYTES} bytes`, sent);
    if (response.status === 401 || response.status === 403) {
      fail('auth', `Jev rejected the API key (HTTP ${response.status})`, sent);
    }
    if (!response.ok) {
      fail('http', `Jev returned HTTP ${response.status}`, sent, response.status, retryAfterMs(response.headers), retryableStatus(response.status));
    }
    let parsed: JevResponse;
    try {
      parsed = parseJevResponse(response.status, true, text!);
    } catch {
      return fail('parse', 'Jev returned a body without answers', sent);
    }
    // Require reader-usable requested answers for counting only, never for returning.
    if (hasHostedRequestedAnswers(parsed, questions)) this.responses += 1;
    const reported = parsed.usage?.input_tokens;
    finish('ok', {
      bytes: sent.bytes,
      // An odd usage field falls back to the estimate, so the row still carries counts.
      input: isCount(reported) ? reported : estimate,
      output: isCount(parsed.usage?.output_tokens) ? parsed.usage.output_tokens : 0,
    });
    return parsed;
  }
}
