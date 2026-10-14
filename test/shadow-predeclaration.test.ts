import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PredeclarationError, alarmLevel, assertCommittedUnchanged, loadEquivalencePredeclaration,
  loadShadowPredeclaration, sha256File,
} from '../src/shadow/predeclaration.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'jev-shadow-predecl-'));

const validEquivalence = {
  schema: 'jev-shadow-equivalence-predeclaration', version: 1,
  corpus: {
    receipt_path: 'fixtures/stage3-receipt.json',
    receipt_sha256: '9f2f29949b8db6974f39d61185b23106777c920038b5bc49f7b02b5fead727d9',
    requests: 48, questions: 325, record_label_logprobs: 924, transport_label_values: 795,
    datasets: { base: 8, holdout2: 15, panel: 25 },
  },
  tolerances: {
    max_abs_probability_delta: 0.01, max_abs_logprob_delta: 0.05, boundary_band: 0.01,
    nonborderline_margin: 0.05, min_global_agreement: 0.995,
    max_flips_non_active_evidence: 1, active_evidence_flips: 0,
  },
  active_evidence: [{ dataset: 'holdout2', fixture: 'route-checkpoint',
    received_sha256: '3a5fa9259a7c4ce02fb06dd4345fb473cecb2a14da0ceca3aec3a8577b6490e4', questions: ['call_t3', 'result_t3'] }],
  declared_by: 'test', declared_at: '2026-10-11T00:00:00Z', source_citation: 'test source',
};
const validShadow = {
  schema: 'jev-shadow-acceptance-predeclaration', version: 1,
  thresholds: {
    disagreement_rate: { warn_over: 0.002, fail_over: 0.005 },
    active_evidence_flips: 0,
    latency_p95_ratio: { warn_over: 1.25, fail_over: 1.5 },
  },
  minimum_paired_samples: 200,
  evidence_retention: ['pairs.jsonl', 'health.json'],
  on_fail: 'production stays on primary host; no cutover',
  cutover: { authorized: false, rule: 'cutover is a separate operator decision outside this authorization' },
  declared_by: 'test', declared_at: '2026-10-11T00:00:00Z',
};

const write = (dir: string, name: string, data: unknown) => {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

test('absent predeclaration is refused, not silently skipped', () => {
  assert.throws(() => loadEquivalencePredeclaration(join(scratch(), 'missing.json'), '0'.repeat(64)),
    (error: unknown) => error instanceof PredeclarationError && error.code === 'absent');
  assert.throws(() => loadShadowPredeclaration(join(scratch(), 'missing.json'), '0'.repeat(64)),
    (error: unknown) => error instanceof PredeclarationError && error.code === 'absent');
});

test('predeclaration whose bytes do not match the pinned sha256 is refused as stale', () => {
  const dir = scratch();
  const path = write(dir, 'decl.json', validEquivalence);
  const wrong = 'f'.repeat(64);
  assert.throws(() => loadEquivalencePredeclaration(path, wrong),
    (error: unknown) => error instanceof PredeclarationError && error.code === 'stale');
  // A file edited after its hash was pinned no longer matches either.
  const pinned = sha256File(path);
  writeFileSync(path, JSON.stringify({ ...validEquivalence, tolerances: { ...validEquivalence.tolerances, max_abs_probability_delta: 0.9 } }, null, 2) + '\n');
  assert.throws(() => loadEquivalencePredeclaration(path, pinned),
    (error: unknown) => error instanceof PredeclarationError && error.code === 'stale');
});

test('unparseable and off-schema predeclarations are refused', () => {
  const dir = scratch();
  const bad = write(dir, 'bad.json', '{not json');
  assert.throws(() => loadEquivalencePredeclaration(bad, sha256File(bad)),
    (error: unknown) => error instanceof PredeclarationError && error.code === 'unparseable');
  const shape = (mutate: (decl: typeof validEquivalence) => void) => {
    const copy = structuredClone(validEquivalence); mutate(copy);
    const p = write(dir, 'shape.json', copy);
    return () => loadEquivalencePredeclaration(p, sha256File(p));
  };
  assert.throws(shape(d => { d.schema = 'something-else'; }), (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
  assert.throws(shape(d => { delete d.tolerances; }), (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
  assert.throws(shape(d => { d.tolerances.max_abs_probability_delta = 0; }), (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
  assert.throws(shape(d => { d.corpus.requests = 47; }), (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
  assert.throws(shape(d => { d.active_evidence = []; }), (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
});

test('valid predeclarations load with their declared values intact', () => {
  const dir = scratch();
  const eq = loadEquivalencePredeclaration(write(dir, 'eq.json', validEquivalence), sha256File(join(dir, 'eq.json')));
  assert.equal(eq.tolerances.max_abs_probability_delta, 0.01);
  assert.equal(eq.corpus.datasets.holdout2, 15);
  const shadow = loadShadowPredeclaration(write(dir, 'shadow.json', validShadow), sha256File(join(dir, 'shadow.json')));
  assert.equal(shadow.thresholds.disagreement_rate.fail_over, 0.005);
  assert.equal(shadow.cutover.authorized, false);
});

test('shadow predeclaration rejects unordered or non-positive thresholds', () => {
  const dir = scratch();
  const shape = (mutate: (decl: typeof validShadow) => void) => {
    const copy = structuredClone(validShadow); mutate(copy);
    const p = write(dir, 's.json', copy);
    return () => loadShadowPredeclaration(p, sha256File(p));
  };
  assert.throws(shape(d => { d.thresholds.disagreement_rate.warn_over = 0.006; }),
    (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
  assert.throws(shape(d => { d.thresholds.latency_p95_ratio.fail_over = 0.5; }),
    (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
  assert.throws(shape(d => { d.cutover.authorized = true; }),
    (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
  assert.throws(shape(d => { d.evidence_retention = []; }),
    (e: unknown) => e instanceof PredeclarationError && e.code === 'schema');
});

test('committed-unchanged check refuses untracked and modified files', { skip: process.version < 'v20' }, () => {
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const dir = scratch();
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  write(dir, 'other.txt', 'unrelated\n');
  git(dir, 'add', 'other.txt');
  git(dir, 'commit', '-qm', 'init');
  const path = write(dir, 'decl.json', validEquivalence);
  assert.throws(() => assertCommittedUnchanged(path),
    (error: unknown) => error instanceof PredeclarationError && error.code === 'uncommitted');
  git(dir, 'add', 'decl.json');
  git(dir, 'commit', '-qm', 'predeclare');
  const commit = git(dir, 'log', '-1', '--format=%H', '--', 'decl.json').trim();
  assert.equal(assertCommittedUnchanged(path).commit, commit);
  writeFileSync(path, JSON.stringify({ ...validEquivalence, declared_by: 'edited' }, null, 2) + '\n');
  assert.throws(() => assertCommittedUnchanged(path),
    (error: unknown) => error instanceof PredeclarationError && error.code === 'modified');
  rmSync(dir, { recursive: true, force: true });
});

test('alarm levels are strict inequalities with pass at or below warn', () => {
  const thresholds = validShadow.thresholds;
  assert.equal(alarmLevel(0, thresholds), 'pass');
  assert.equal(alarmLevel(0.002, thresholds), 'pass');   // exactly warn_over is not over it
  assert.equal(alarmLevel(0.0020001, thresholds), 'warn');
  assert.equal(alarmLevel(0.005, thresholds), 'warn');   // exactly fail_over is not over it
  assert.equal(alarmLevel(0.0050001, thresholds), 'fail');
  assert.equal(alarmLevel(0.01, thresholds), 'fail');
});

test('tmpdir scratch cleanup helper exists', () => { mkdirSync(join(scratch(), 'nested'), { recursive: true }); });
