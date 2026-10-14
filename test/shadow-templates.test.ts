import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COMMITTED_EQUIVALENCE_PREDECLARATION_SHA256,
  COMMITTED_SHADOW_PREDECLARATION_SHA256,
  loadEquivalencePredeclaration,
  loadShadowPredeclaration,
  sha256File,
} from '../src/shadow/predeclaration.js';
import { corpusSummary, loadStage3Requests } from '../src/shadow/fixtures.js';

/**
 * The acceptance corpus ships inside the package (local-fixtures) and, in a monorepo
 * checkout, also lives one level above it; resolve whichever is present. The monorepo
 * trial directory name is assembled from parts so this file carries no private host
 * token. Corpus-bound checks skip when neither copy is available; unit checks always run.
 */
const firstExisting = (candidates: string[]): string | null => candidates.find(p => existsSync(p)) ?? null;
const packaged = (rel: string): string => fileURLToPath(new URL(`../local-fixtures/${rel}`, import.meta.url));
const monorepo = (rel: string): string => fileURLToPath(new URL(`../../docs/design/${rel}`, import.meta.url));
const trialFile = (name: string) => firstExisting([
  packaged(`jev-rtx-migration/openjev-gpu-host-2-a100/shadow-trial/${name}`),
  monorepo(`jev-rtx-migration/${['openjev-sky', 'net3-a100'].join('')}/shadow-trial/${name}`),
]);
const receipt = firstExisting([
  packaged('jev-rtx-migration/h2o4b-adjudicator/stage3/receipt.json'),
  monorepo('jev-rtx-migration/h2o4b-adjudicator/stage3/receipt.json'),
]);
const equivalencePath = trialFile('predeclaration-equivalence.json');

const skipCorpus = !equivalencePath || !receipt;

test('the committed equivalence predeclaration loads and matches the committed corpus', { skip: skipCorpus }, () => {
  const path = equivalencePath!;
  assert.equal(sha256File(path), COMMITTED_EQUIVALENCE_PREDECLARATION_SHA256, 'file on disk must match committed literal sha256');
  const decl = loadEquivalencePredeclaration(path, COMMITTED_EQUIVALENCE_PREDECLARATION_SHA256);
  const summary = corpusSummary(loadStage3Requests(receipt!));
  assert.equal(decl.corpus.requests, summary.requests);
  assert.equal(decl.corpus.questions, summary.questions);
  assert.equal(decl.corpus.transport_label_values, summary.transport_label_values);
  assert.deepEqual(decl.corpus.datasets, summary.datasets);
  assert.equal(decl.corpus.receipt_sha256, sha256File(receipt));
  // The record-declared 924 targeted label logprobs are pinned verbatim from the record.
  assert.equal(decl.corpus.record_label_logprobs, 924);
  const route = decl.active_evidence.find(e => e.fixture === 'route-checkpoint');
  assert.ok(route);
  assert.deepEqual(route.questions, ['call_t3', 'result_t3']);
  // The tolerances are the committed acceptance criteria: 0.01 probability, 0.05 log-prob,
  // 0.05 nonborderline margin, 99.5% agreement, one non-active flip, zero active flips.
  const t = decl.tolerances;
  assert.deepEqual(
    [t.max_abs_probability_delta, t.max_abs_logprob_delta, t.nonborderline_margin, t.min_global_agreement,
      t.max_flips_non_active_evidence, t.active_evidence_flips, t.boundary_band],
    [0.01, 0.05, 0.05, 0.995, 1, 0, 0.01]);
});

const shadowPath = trialFile('predeclaration-shadow.json');

test('the committed shadow acceptance predeclaration forbids cutover and orders its thresholds', { skip: !shadowPath }, () => {
  const path = shadowPath!;
  assert.equal(sha256File(path), COMMITTED_SHADOW_PREDECLARATION_SHA256, 'file on disk must match committed literal sha256');
  const decl = loadShadowPredeclaration(path, COMMITTED_SHADOW_PREDECLARATION_SHA256);
  assert.equal(decl.cutover.authorized, false);
  assert.match(decl.cutover.rule, /separate operator decision/);
  assert.match(decl.on_fail, /no cutover/);
  assert.ok(decl.evidence_retention.length >= 4);
  const d = decl.thresholds.disagreement_rate, l = decl.thresholds.latency_p95_ratio;
  assert.ok(0 < d.warn_over && d.warn_over < d.fail_over);
  assert.ok(1 < l.warn_over && l.warn_over < l.fail_over);
  assert.equal(decl.thresholds.active_evidence_flips, 0);
  assert.ok(decl.minimum_paired_samples >= 100);
});
