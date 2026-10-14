import type { CoreAsker } from '../core/judge.js';
import { readChoiceAnswer } from '../core/choice-answer.js';
import type { JevAnswer, JevQuestion, JevQuestions, JevResponse, JevState } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { estimateTokens } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { expandHome, isOpenAIDecisionsEndpoint } from './config.js';
import { appendJsonLine, isCount } from './ledger.js';
import { JevError, MAX_RESPONSE_BYTES, readCapped, type AskCall, type JevClientOptions, type JevErrorKind } from './jev-client.js';

export const OPENAI_DECISIONS_ENDPOINT = 'https://api.openai.com/v1/decisions';
export const OPENAI_DECISIONS_MODEL = 'gpt-6-luna';
export const OPENAI_DECISIONS_KEY_ENV = 'JEV_OPENAI_DECISIONS_API_KEY';
export const OPENAI_DECISIONS_TIMEOUT_MS = 120_000;

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function wireQuestion(name: string, q: JevQuestion): Record<string, unknown> {
  const base = { name, instructions: q.instructions };
  if (q.type === 'noul') {
    const instructions = q.instructions
      + (q.criteria?.true === undefined ? '' : `\nTrue: ${q.criteria.true}`)
      + (q.criteria?.false === undefined ? '' : `\nFalse: ${q.criteria.false}`);
    return { ...base, type: 'predicate', instructions };
  }
  if (q.type === 'choice') return { ...base, type: 'choice', choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description: description ?? value })) };
  return { ...base, type: 'score', levels: q.criteria.map(label => ({ label, description: label })) };
}

/** Per-question validation: ambiguity or malformed/refused answers must never become zero. */
function mappedAnswer(a: Record<string, unknown>, q: JevQuestion): JevAnswer | undefined {
  if (q.type === 'noul') return a.type === 'predicate' && probability(a.probability) ? { type: 'noul', noul: a.probability } : undefined;
  if (a.type !== q.type || !Array.isArray(a.probabilities) || !probability(a.confidence)) return undefined;
  const labels = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  if (labels.length < 2 || a.probabilities.length !== labels.length) return undefined;
  const probabilities: Record<string, number> = Object.create(null);
  for (const pair of a.probabilities) {
    if (!record(pair) || !probability(pair.probability)) return undefined;
    let label: string;
    if (q.type === 'choice') {
      if (typeof pair.value !== 'string' || !Object.hasOwn(q.criteria, pair.value)) return undefined;
      label = pair.value;
    } else {
      if (!Number.isInteger(pair.value) || (pair.value as number) < 0 || (pair.value as number) >= q.criteria.length
          || pair.label !== q.criteria[pair.value as number]) return undefined;
      label = String(pair.value);
    }
    if (Object.hasOwn(probabilities, label)) return undefined;
    probabilities[label] = pair.probability;
  }
  if (q.type === 'choice') return readChoiceAnswer({ type: 'choice', choice: a.choice, confidence: a.confidence, probabilities }, q.criteria);
  if (Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 1e-5) return undefined;
  const expected = labels.reduce((sum, label, i) => sum + i * probabilities[label]!, 0);
  if (typeof a.score !== 'number' || !Number.isFinite(a.score) || Math.abs(a.score - expected) > 1e-5) return undefined;
  return { type: 'score', score: a.score, confidence: a.confidence, probabilities };
}

/** One request, no retries: re-dispatching may double billing. Not selected by the pruning factory. */
export class OpenAIDecisionsClient implements CoreAsker {
  private requests = 0;
  private responses = 0;
  get requestCount() { return this.requests; }
  get responseCount() { return this.responses; }

  constructor(private readonly options: JevClientOptions, private readonly signal?: AbortSignal) {}

  async ask(state: JevState, questions: JevQuestions, call?: AskCall): Promise<JevResponse> {
    const { config, configHash, caller, context } = this.options;
    const { api } = config;
    const endpoint = api.openaiDecisionsEndpoint ?? OPENAI_DECISIONS_ENDPOINT;
    const model = api.openaiDecisionsModel ?? OPENAI_DECISIONS_MODEL;
    const keyEnv = api.openaiDecisionsKeyEnv ?? OPENAI_DECISIONS_KEY_ENV;
    const timeoutMs = api.openaiDecisionsTimeoutMs ?? OPENAI_DECISIONS_TIMEOUT_MS;
    const started = Date.now();
    let bytes = 0, input = 0, status: number | undefined;
    const finish = (outcome: string) => {
      try {
        appendJsonLine(expandHome(config.telemetry.path), {
          ts: new Date(started).toISOString(), caller, backend: 'openai-decisions', model: OPENAI_DECISIONS_MODEL,
          latency_ms: Date.now() - started, outcome, input_tokens: input, output_tokens: 0,
          request_bytes: bytes, question_count: Object.keys(questions).length, config_hash: configHash,
          hook_id: context?.hookId ?? null, attempt_id: context?.attemptId ?? null,
          round: call?.round ?? null, batch: call?.batch ?? null, retry: 0, http_status: status ?? null,
        });
      } catch { /* Telemetry must never break a call. No headers, body, key or raw errors. */ }
    };
    const fail = (kind: JevErrorKind, message: string): never => {
      finish(kind); throw new JevError(kind, message, status);
    };
    // Defend even callers constructing config directly, outside the TOML validator.
    if (!isOpenAIDecisionsEndpoint(endpoint) || model !== OPENAI_DECISIONS_MODEL
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      return fail('parse', 'Invalid OpenAI Decisions configuration');
    }
    const key = (this.options.env ?? process.env)[keyEnv] ?? '';
    if (key.trim().length === 0) return fail('auth', `${keyEnv} is not set`);
    if (this.signal?.aborted) return fail('aborted', 'OpenAI Decisions request aborted');
    const entries = Object.entries(questions);
    if (entries.length < 1 || entries.length > 255) return fail('parse', 'OpenAI Decisions requires 1 to 255 questions');
    let body: string;
    try {
      body = JSON.stringify({ model, input: typeof state === 'string' ? state : JSON.stringify(state), questions: entries.map(([name, q]) => wireQuestion(name, q)) });
    } catch { return fail('parse', 'OpenAI Decisions input is not JSON serialisable'); }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    bytes = Buffer.byteLength(body); input = estimateTokens(body);
    let response: Response, text: string | undefined;
    try {
      this.requests++;
      response = await fetch(endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body, redirect: 'manual', signal,
      });
      status = response.status;
      text = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch {
      // Never include the thrown error: transport/header errors can contain credentials.
      return this.signal?.aborted ? fail('aborted', 'OpenAI Decisions request aborted')
        : timeout.aborted ? fail('timeout', `OpenAI Decisions request timed out after ${timeoutMs} ms`)
        : fail('network', 'OpenAI Decisions request failed without a response');
    }
    if (status === 401 || status === 403) return fail('auth', `OpenAI Decisions rejected the API key (HTTP ${status})`);
    if (!response.ok) return fail('http', `OpenAI Decisions returned HTTP ${status}; redirects are refused`);
    if (text === undefined) return fail('http', `OpenAI Decisions response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return fail('parse', 'OpenAI Decisions returned invalid JSON'); }
    if (!record(raw) || raw.model !== model) return fail('parse', 'OpenAI Decisions response model does not match the pinned model');
    if (!Array.isArray(raw.answers)) return fail('parse', 'OpenAI Decisions returned a body without answers');
    const byName = new Map<string, Record<string, unknown>[]>();
    for (const a of raw.answers) {
      if (!record(a) || typeof a.name !== 'string') continue;
      const group = byName.get(a.name) ?? []; group.push(a); byName.set(a.name, group);
    }
    const answers: Record<string, JevAnswer> = Object.create(null);
    for (const [name, q] of entries) {
      const group = byName.get(name);
      if (group?.length !== 1) continue;
      const answer = mappedAnswer(group[0]!, q);
      if (answer !== undefined) answers[name] = answer;
    }
    const reported = record(raw.usage) ? raw.usage.input_tokens : undefined;
    if (isCount(reported)) input = reported;
    if (entries.every(([name]) => Object.hasOwn(answers, name))) this.responses++;
    finish('ok');
    return { model, answers, ...(isCount(reported) ? { usage: { input_tokens: reported, output_tokens: 0 } } : {}) };
  }
}
