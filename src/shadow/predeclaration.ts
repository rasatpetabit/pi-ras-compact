/**
 * Predeclared tolerances for the openjev-27B local shadow trial.
 *
 * Both harnesses refuse to run unless a predeclaration file exists, hashes to the sha256 the
 * operator pinned at invocation, parses and satisfies this schema. The hash pin is what makes
 * the declaration pre-declared: a file edited after pinning is stale, and a file that was never
 * committed to git is not a declaration at all. Nothing in this module performs I/O beyond
 * reading the named file and, for `assertCommittedUnchanged`, asking git about it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export type PredeclarationCode = 'absent' | 'stale' | 'unparseable' | 'schema' | 'uncommitted' | 'modified';

export class PredeclarationError extends Error {
  constructor(readonly code: PredeclarationCode, message: string) { super(message); this.name = 'PredeclarationError'; }
}

export interface CorpusDeclaration {
  receipt_path: string;
  receipt_sha256: string;
  requests: number;
  questions: number;
  /** Targeted label logprobs the record declares for this corpus (924 for the 48 fixtures). */
  record_label_logprobs: number;
  /** Label values the local decision transport actually returns (795 for the same corpus). */
  transport_label_values: number;
  datasets: Record<string, number>;
}

export interface ActiveEvidence {
  dataset: string;
  fixture: string;
  received_sha256: string;
  questions: string[];
}

export interface EquivalenceTolerance {
  max_abs_probability_delta: number;
  max_abs_logprob_delta: number;
  boundary_band: number;
  nonborderline_margin: number;
  min_global_agreement: number;
  max_flips_non_active_evidence: number;
  active_evidence_flips: number;
}

export interface EquivalencePredeclaration {
  schema: 'jev-shadow-equivalence-predeclaration';
  version: 1;
  corpus: CorpusDeclaration;
  tolerances: EquivalenceTolerance;
  active_evidence: ActiveEvidence[];
  declared_by: string;
  declared_at: string;
  source_citation: string;
}

export interface ShadowThresholds {
  disagreement_rate: { warn_over: number; fail_over: number };
  active_evidence_flips: number;
  latency_p95_ratio: { warn_over: number; fail_over: number };
}

export interface ShadowPredeclaration {
  schema: 'jev-shadow-acceptance-predeclaration';
  version: 1;
  thresholds: ShadowThresholds;
  minimum_paired_samples: number;
  evidence_retention: string[];
  on_fail: string;
  cutover: { authorized: false; rule: string };
  declared_by: string;
  declared_at: string;
}

export const COMMITTED_EQUIVALENCE_PREDECLARATION_SHA256 =
  '0cec6df54085a43509a3c373c953c5c785b6b84d19b0ec8289c55377ea690f14';

export const COMMITTED_SHADOW_PREDECLARATION_SHA256 =
  'b7f53a82bc60d3e8eef9463679174d9b45933a9e616047f64ec45aa62437dcd7';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isRatio = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1;

function readDeclared(path: string, expectedSha256: string): { path: string; value: unknown } {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { throw new PredeclarationError('absent', `predeclaration is absent: ${path}`); }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) {
    throw new PredeclarationError('stale',
      `predeclaration is stale: sha256 ${actual} does not match the pinned ${expectedSha256}; refusing to run`);
  }
  try { return { path, value: JSON.parse(bytes.toString('utf8')) }; }
  catch { throw new PredeclarationError('unparseable', `predeclaration is not valid JSON: ${path}`); }
}

function validateEquivalence(value: unknown): EquivalencePredeclaration {
  const fail = (message: string): never => { throw new PredeclarationError('schema', `equivalence predeclaration: ${message}`); };
  if (!isRecord(value) || value.schema !== 'jev-shadow-equivalence-predeclaration' || value.version !== 1) fail('wrong schema or version');
  const corpus = value.corpus;
  if (!isRecord(corpus) || !isSha256(corpus.receipt_sha256) || typeof corpus.receipt_path !== 'string'
    || !Number.isInteger(corpus.requests) || corpus.requests <= 0
    || !Number.isInteger(corpus.questions) || corpus.questions <= 0
    || !Number.isInteger(corpus.record_label_logprobs) || corpus.record_label_logprobs <= 0
    || !Number.isInteger(corpus.transport_label_values) || corpus.transport_label_values <= 0
    || !isRecord(corpus.datasets) || Object.keys(corpus.datasets).length === 0
    || Object.values(corpus.datasets).some(n => !Number.isInteger(n) || n <= 0)
    || Object.values(corpus.datasets).reduce((acc: number, n: any) => acc + n, 0) !== corpus.requests) fail('corpus block is invalid');
  const t = value.tolerances;
  if (!isRecord(t) || !isPositive(t.max_abs_probability_delta) || !isPositive(t.max_abs_logprob_delta)
    || !isPositive(t.boundary_band) || !isPositive(t.nonborderline_margin)
    || !isPositive(t.min_global_agreement) || t.min_global_agreement > 1
    || !Number.isInteger(t.max_flips_non_active_evidence) || t.max_flips_non_active_evidence < 0
    || !Number.isInteger(t.active_evidence_flips) || t.active_evidence_flips !== 0) fail('tolerances are invalid');
  const active = value.active_evidence;
  if (!Array.isArray(active) || active.length === 0 || active.some(entry =>
    !isRecord(entry) || typeof entry.dataset !== 'string' || typeof entry.fixture !== 'string'
    || !isSha256(entry.received_sha256) || !Array.isArray(entry.questions) || entry.questions.length === 0
    || entry.questions.some(q => typeof q !== 'string'))) fail('active evidence list is invalid');
  if (typeof value.declared_by !== 'string' || !value.declared_by.trim() || typeof value.declared_at !== 'string'
    || !value.declared_at.trim() || typeof value.source_citation !== 'string' || !value.source_citation.trim()) {
    fail('declared_by, declared_at and source_citation are required');
  }
  return value as EquivalencePredeclaration;
}

export function loadEquivalencePredeclaration(
  path: string,
  expectedSha256: string = COMMITTED_EQUIVALENCE_PREDECLARATION_SHA256,
): EquivalencePredeclaration {
  return validateEquivalence(readDeclared(path, expectedSha256).value);
}

function validateShadow(value: unknown): ShadowPredeclaration {
  const fail = (message: string): never => { throw new PredeclarationError('schema', `shadow predeclaration: ${message}`); };
  if (!isRecord(value) || value.schema !== 'jev-shadow-acceptance-predeclaration' || value.version !== 1) fail('wrong schema or version');
  const t = value.thresholds;
  if (!isRecord(t) || !isRecord(t.disagreement_rate) || !isRecord(t.latency_p95_ratio)
    || !isRatio(t.latency_p95_ratio.warn_over) || !isRatio(t.latency_p95_ratio.fail_over)
    || !(t.latency_p95_ratio.warn_over < t.latency_p95_ratio.fail_over)
    || !isNonNegative(t.disagreement_rate.warn_over) || !isPositive(t.disagreement_rate.fail_over)
    || !(t.disagreement_rate.warn_over < t.disagreement_rate.fail_over)
    || !Number.isInteger(t.active_evidence_flips) || t.active_evidence_flips !== 0) fail('thresholds are invalid or unordered');
  if (!Number.isInteger(value.minimum_paired_samples) || value.minimum_paired_samples < 100) fail('minimum_paired_samples must be at least 100');
  if (!Array.isArray(value.evidence_retention) || value.evidence_retention.length === 0
    || value.evidence_retention.some(e => typeof e !== 'string' || !e.trim())) fail('evidence_retention is required');
  if (typeof value.on_fail !== 'string' || !value.on_fail.trim()) fail('on_fail is required');
  if (!isRecord(value.cutover) || value.cutover.authorized !== false || typeof value.cutover.rule !== 'string' || !value.cutover.rule.trim()) {
    fail('cutover.authorized must be false with a rule');
  }
  if (typeof value.declared_by !== 'string' || !value.declared_by.trim() || typeof value.declared_at !== 'string' || !value.declared_at.trim()) {
    fail('declared_by and declared_at are required');
  }
  return value as ShadowPredeclaration;
}

export function loadShadowPredeclaration(
  path: string,
  expectedSha256: string = COMMITTED_SHADOW_PREDECLARATION_SHA256,
): ShadowPredeclaration {
  return validateShadow(readDeclared(path, expectedSha256).value);
}

/**
 * Refuse a predeclaration that is not committed to git at its pinned bytes. The shadow trial's
 * declarations exist to be auditable before any live run; an untracked or edited file is not the
 * declared artifact. Returns the commit that last touched the file.
 */
export function assertCommittedUnchanged(path: string): { commit: string } {
  const absolute = resolve(path);
  const dir = dirname(absolute);
  const run = (args: string[]): string => {
    try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new PredeclarationError('uncommitted', `predeclaration is not committed to git: ${path}`); }
  };
  let root: string, relative: string;
  try {
    root = run(['rev-parse', '--show-toplevel']).trimEnd();
    relative = absolute.slice(root.length + 1).split('\\').join('/');
  } catch { throw new PredeclarationError('uncommitted', `predeclaration is not committed to git: ${path}`); }
  if (!root || !relative) throw new PredeclarationError('uncommitted', `predeclaration is not inside a git work tree: ${path}`);
  let committed: string;
  try { committed = run(['-C', root, 'rev-parse', `HEAD:${relative}`]).trim(); }
  catch { throw new PredeclarationError('uncommitted', `predeclaration is not committed to git: ${path}`); }
  const working = run(['-C', root, 'hash-object', absolute]).trim();
  if (committed !== working) {
    throw new PredeclarationError('modified', `predeclaration differs from its committed bytes: ${path}`);
  }
  return { commit: run(['-C', root, 'log', '-1', '--format=%H', '--', relative]).trim() };
}

/** Strict-threshold alarm: exactly at a threshold is not over it. */
export function alarmLevel(rate: number, thresholds: ShadowThresholds): 'pass' | 'warn' | 'fail' {
  if (rate > thresholds.disagreement_rate.fail_over) return 'fail';
  if (rate > thresholds.disagreement_rate.warn_over) return 'warn';
  return 'pass';
}
