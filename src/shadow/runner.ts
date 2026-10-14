/**
 * Equivalence study runner.
 *
 * Executes the committed 48-fixture development corpus against a baseline endpoint and a
 * candidate endpoint, under a strict predeclaration-hash gate. Refuses to make any network call
 * if the predeclaration is missing, stale, or fails schema validation, or if the corpus does
 * not match the declared counts.
 */
import { writeFileSync } from 'node:fs';
import type { JevAnswer } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { corpusSummary, loadStage3Requests, type FixtureRequest } from './fixtures.js';
import {
  COMMITTED_EQUIVALENCE_PREDECLARATION_SHA256,
  loadEquivalencePredeclaration,
  type EquivalencePredeclaration,
} from './predeclaration.js';
import { equivalenceReport, type EquivalenceReport } from './equivalence.js';

export const DEFAULT_EQUIVALENCE_TIMEOUT_MS = 30_000;

export interface EquivalenceEndpointConfig {
  endpoint: string;
  model: string;
  revision: string;
}

export interface EquivalenceStudyOptions {
  receipt: string;
  predeclaration: string;
  predeclaration_sha256?: string;
  baseline: EquivalenceEndpointConfig;
  candidate: EquivalenceEndpointConfig;
  output: string;
  fetcher?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
}

export interface EquivalenceStudyResult {
  report: EquivalenceReport;
  identity: {
    baseline: EquivalenceEndpointConfig;
    candidate: EquivalenceEndpointConfig;
  };
  concurrency: {
    configured: number;
    observed: number;
  };
}

async function callEndpoint(
  customFetch: typeof fetch,
  config: EquivalenceEndpointConfig,
  requestPayload: { state: unknown; questions: unknown },
  timeoutMs: number,
): Promise<{ answers: Record<string, JevAnswer>; latency_ms?: number; model?: string; revision?: string }> {
  const res = await customFetch(config.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestPayload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`endpoint ${config.endpoint} responded with status ${res.status}`);
  }
  const json: any = await res.json();
  if (!json || typeof json !== 'object' || !json.answers) {
    throw new Error(`endpoint ${config.endpoint} returned invalid response shape`);
  }
  return json;
}

export async function runEquivalenceStudy(options: EquivalenceStudyOptions): Promise<{ report: EquivalenceReport }> {
  // 1. Predeclaration gate: loads and verifies hash BEFORE any transport call
  const expectedSha = options.predeclaration_sha256 ?? COMMITTED_EQUIVALENCE_PREDECLARATION_SHA256;
  const decl: EquivalencePredeclaration = loadEquivalencePredeclaration(
    options.predeclaration,
    expectedSha,
  );

  // 2. Load corpus requests
  const entries: FixtureRequest[] = loadStage3Requests(options.receipt);
  const summary = corpusSummary(entries);

  // 3. Verify corpus matches declared counts
  if (
    summary.requests !== decl.corpus.requests ||
    summary.questions !== decl.corpus.questions ||
    summary.transport_label_values !== decl.corpus.transport_label_values
  ) {
    throw new Error(
      `corpus (${summary.requests} reqs, ${summary.questions} qs, ${summary.transport_label_values} labels) ` +
        `does not match predeclaration (${decl.corpus.requests} reqs, ${decl.corpus.questions} qs, ${decl.corpus.transport_label_values} labels)`,
    );
  }

  const customFetch = options.fetcher ?? globalThis.fetch;
  const configuredConcurrency = options.concurrency ?? 1;
  const timeoutMs = (options.timeoutMs !== undefined && options.timeoutMs > 0)
    ? options.timeoutMs
    : DEFAULT_EQUIVALENCE_TIMEOUT_MS;
  let activeInflight = 0;
  let maxObservedInflight = 0;

  // 4. Replay requests against baseline and candidate
  const pairs: Array<{
    entry: FixtureRequest;
    baseline: Record<string, JevAnswer>;
    candidate: Record<string, JevAnswer>;
  }> = [];

  for (const entry of entries) {
    activeInflight++;
    if (activeInflight > maxObservedInflight) maxObservedInflight = activeInflight;

    const payload = { state: entry.state, questions: entry.questions };
    const [baseRes, candRes] = await Promise.all([
      callEndpoint(customFetch, options.baseline, payload, timeoutMs),
      callEndpoint(customFetch, options.candidate, payload, timeoutMs),
    ]);

    activeInflight--;
    pairs.push({
      entry,
      baseline: baseRes.answers,
      candidate: candRes.answers,
    });

    // Disqualify immediately if an active-evidence question flips
    const tempReport = equivalenceReport(pairs, decl);
    const activeFlips = tempReport.criteria.find(c => c.name === 'active_evidence_flips');
    if (activeFlips && !activeFlips.pass) {
      break;
    }
  }

  // 5. Compute equivalence report
  const report = equivalenceReport(pairs, decl);

  // 6. Write output
  const outputPayload = {
    verdict: report.verdict,
    identity: {
      baseline: options.baseline,
      candidate: options.candidate,
    },
    concurrency: {
      configured: configuredConcurrency,
      observed: maxObservedInflight,
    },
    report,
    corpus: report.corpus,
    decisions: report.decisions,
    criteria: report.criteria,
  };

  writeFileSync(options.output, JSON.stringify(outputPayload, null, 2) + '\n');

  return { report };
}
