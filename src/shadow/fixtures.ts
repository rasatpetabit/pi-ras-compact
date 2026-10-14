/**
 * The 48 consumed development fixtures for the openjev-27B equivalence study.
 *
 * This is the existing inventory, not a second one: the selection is a TypeScript port of
 * `requests()` in `pi-jev/eval/gptoss-qualification/h2o_fast_exact.py` (commit fc05dae8d, the
 * exactness harness whose record declared the 924 targeted label logprobs). It reads the
 * committed stage3 CPU receipt, keeps records whose dataset is one of the three development
 * panels, and dedupes by (dataset, received_sha256) keeping the first request seen — the same
 * `setdefault` the Python loader used. The record that declares this corpus is
 * the stage3 equivalence study specification.
 */
import { readFileSync } from 'node:fs';
import type { JevQuestions } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';

export const DEVELOPMENT_DATASETS = ['base', 'holdout2', 'panel'] as const;
export type DevelopmentDataset = (typeof DEVELOPMENT_DATASETS)[number];

export interface FixtureRequest {
  dataset: DevelopmentDataset;
  /** The receipt's fixture name; with dataset and request hash it identifies a flip exactly. */
  fixture: string;
  receivedSha256: string;
  state: unknown;
  questions: JevQuestions;
  /** The record's stage3 native answers for this request, when present (cross-check surface). */
  nativeAnswers?: Record<string, unknown>;
}

export interface CorpusSummary {
  requests: number;
  questions: number;
  transport_label_values: number;
  datasets: Record<string, number>;
}

export class FixtureError extends Error {
  constructor(message: string) { super(message); this.name = 'FixtureError'; }
}

/** Label values the local decision transport returns for one answer document. */
function transportValues(answer: unknown): number {
  if (answer === null || typeof answer !== 'object') return 0;
  const record = answer as Record<string, unknown>;
  let count = 0;
  if (typeof record.noul === 'number') count += 1;
  if (typeof record.score === 'number') count += 1;
  if (record.probabilities !== null && typeof record.probabilities === 'object') {
    count += Object.values(record.probabilities as Record<string, unknown>)
      .filter(v => typeof v === 'number').length;
  }
  return count;
}

/** Load and dedupe the development fixture requests from the committed stage3 receipt. */
export function loadStage3Requests(receiptPath: string): FixtureRequest[] {
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch { throw new FixtureError(`fixture receipt is unreadable: ${receiptPath}`); }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
    throw new FixtureError('fixture receipt has no records array');
  }
  const seen = new Map<string, FixtureRequest>();
  for (const record of parsed.records) {
    const dataset = record?.dataset;
    if (!DEVELOPMENT_DATASETS.includes(dataset)) {
      // The development corpus excludes sealed and holdout3 material by construction.
      throw new FixtureError(`refusing dataset outside the development corpus: ${dataset}`);
    }
    for (const meta of record.metadata ?? []) {
      if (meta?.decision_model !== 'h2o-lightning-4b' || !('request' in meta)) continue;
      const key = `${dataset}:${meta.received_sha256}`;
      if (seen.has(key)) continue;                       // first request wins, as in setdefault
      const request = meta.request ?? {};
      seen.set(key, {
        dataset,
        fixture: typeof record.fixture === 'string' ? record.fixture : `unnamed-${key}`,
        receivedSha256: meta.received_sha256,
        state: request.state,
        questions: request.questions ?? {},
        ...(meta.native_answers ? { nativeAnswers: meta.native_answers } : {}),
      });
    }
  }
  return [...seen.values()];
}

export function corpusSummary(entries: FixtureRequest[]): CorpusSummary {
  const datasets: Record<string, number> = {};
  let questions = 0, transport_label_values = 0;
  for (const entry of entries) {
    datasets[entry.dataset] = (datasets[entry.dataset] ?? 0) + 1;
    questions += Object.keys(entry.questions).length;
    if (entry.nativeAnswers) {
      for (const answer of Object.values(entry.nativeAnswers)) transport_label_values += transportValues(answer);
    } else {
      for (const q of Object.values(entry.questions) as any[]) {
        if (q.type === 'noul') transport_label_values += 1;
        else if (q.type === 'choice' && q.criteria) transport_label_values += Object.keys(q.criteria).length;
        else if (q.type === 'score') transport_label_values += 1 + (Array.isArray(q.criteria) ? q.criteria.length : 0);
      }
    }
  }
  return { requests: entries.length, questions, transport_label_values, datasets };
}
