import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND_EPSILON, BOUNDARY_P, compareFixture, equivalenceReport, nearestRank, summarizeAbs,
} from '../src/shadow/equivalence.js';
import type { FixtureRequest } from '../src/shadow/fixtures.js';
import type { EquivalencePredeclaration } from '../src/shadow/predeclaration.js';
import type { JevAnswer } from '../src/vendor/pi-jev/vendor/fast-jev-compaction/index.js';

const entry = (questions: Record<string, any>, overrides: Partial<FixtureRequest> = {}): FixtureRequest => ({
  dataset: 'holdout2', fixture: 'fixture-a', receivedSha256: 'a'.repeat(64),
  state: { id: 1 }, questions, ...overrides,
});

test('summarizeAbs matches hand-computed min, median, p95 and max', () => {
  const values = [0.001, 0.01, 0.02, 0.1, 0.3];
  const stats = summarizeAbs(values);
  assert.equal(stats.n, 5);
  assert.equal(stats.min, 0.001);
  assert.equal(stats.median, 0.02);
  assert.equal(stats.p95, 0.3);            // nearest-rank: ceil(0.95*5)=5th
  assert.equal(stats.max, 0.3);
  assert.deepEqual(summarizeAbs([0.25]), { n: 1, min: 0.25, median: 0.25, p95: 0.25, max: 0.25 });
  assert.deepEqual(summarizeAbs([]), { n: 0, min: null, median: null, p95: null, max: null });
  // nearest-rank on 20 sorted values picks the 19th for p95.
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) / 100);
  assert.equal(nearestRank(twenty, 0.95), 0.19);
});

test('noul delta and flip at the p=0.50 boundary are computed as recorded', () => {
  // Hand-computed from the route-checkpoint failure: 0.5087 keeps, 0.4982 drops.
  const questions = { call_t3: { type: 'noul' as const, instructions: 'Keep the record' } };
  const baseline: Record<string, JevAnswer> = { call_t3: { type: 'noul', noul: 0.5087 } };
  const candidate: Record<string, JevAnswer> = { call_t3: { type: 'noul', noul: 0.4982 } };
  const { labels, decisions } = compareFixture(entry(questions), baseline, candidate, 0.01);
  assert.equal(labels.length, 1);
  const [label] = labels;
  assert.ok(label);
  assert.ok(Math.abs(label.absDelta - 0.0105) < 1e-12);
  assert.ok(Math.abs(label.logAbsDelta! - Math.abs(Math.log(0.4982) - Math.log(0.5087))) < 1e-15);
  assert.equal(label.bitwise, false);
  const [decision] = decisions;
  assert.ok(decision);
  assert.equal(decision.baselineDecision, 'keep');
  assert.equal(decision.candidateDecision, 'drop');
  assert.equal(decision.flipped, true);
  assert.ok(Math.abs(decision.baselineMargin! - 0.0087) < 1e-12);
  assert.ok(Math.abs(decision.candidateMargin! - 0.0018) < 1e-12);
});

test('boundary band includes exactly 0.01 on each side and excludes just beyond it', () => {
  const questions = {
    at_049: { type: 'noul' as const, instructions: 'x' }, at_051: { type: 'noul' as const, instructions: 'x' },
    just_below: { type: 'noul' as const, instructions: 'x' }, just_above: { type: 'noul' as const, instructions: 'x' },
    at_050: { type: 'noul' as const, instructions: 'x' }, far: { type: 'noul' as const, instructions: 'x' },
  };
  const answers: Record<string, JevAnswer> = {
    at_049: { type: 'noul', noul: 0.49 }, at_051: { type: 'noul', noul: 0.51 },
    just_below: { type: 'noul', noul: 0.4899 }, just_above: { type: 'noul', noul: 0.5101 },
    at_050: { type: 'noul', noul: 0.5 }, far: { type: 'noul', noul: 0.8 },
  };
  const { decisions } = compareFixture(entry(questions), answers, answers, 0.01);
  const band = (qid: string) => decisions.find(d => d.questionId === qid)!.bandBaseline;
  assert.equal(band('at_049'), 'below');          // |0.49-0.50| is 0.01 within FP epsilon
  assert.equal(band('at_051'), 'above');
  assert.equal(band('just_below'), null);          // 0.0100001 > band
  assert.equal(band('just_above'), null);
  assert.equal(band('at_050'), 'above');           // exactly on the boundary is the keep side
  assert.equal(band('far'), null);
  // The epsilon is explicit and tiny; the raw float distance of 0.49 is 0.010000000000000009.
  assert.ok(Math.abs(0.5 - 0.49) > 0.01 && Math.abs(0.5 - 0.49) <= 0.01 + BAND_EPSILON);
  assert.equal(BOUNDARY_P, 0.5);
});

test('choice and score decisions compare argmax with deterministic tie order', () => {
  const questions = {
    pick: { type: 'choice' as const, instructions: 'x', criteria: { a: 'A', b: 'B' } },
    rank: { type: 'score' as const, instructions: 'x', criteria: ['low', 'high'] },
  };
  const baseline: Record<string, JevAnswer> = {
    pick: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.7, b: 0.3 } },
    rank: { type: 'score', score: 1.5, confidence: 0.8, probabilities: { low: 0.45, high: 0.55 } },
  };
  const candidate: Record<string, JevAnswer> = {
    pick: { type: 'choice', choice: 'b', confidence: 0.9, probabilities: { a: 0.4999, b: 0.5001 } },
    rank: { type: 'score', score: 1.25, confidence: 0.8, probabilities: { low: 0.55, high: 0.45 } },
  };
  const { labels, decisions } = compareFixture(entry(questions), baseline, candidate, 0.01);
  const pick = decisions.find(d => d.questionId === 'pick')!;
  assert.equal(pick.baselineDecision, 'a'); assert.equal(pick.candidateDecision, 'b');
  assert.equal(pick.flipped, true);
  assert.ok(Math.abs(pick.candidateMargin! - 0.0002) < 1e-12);
  const rank = decisions.find(d => d.questionId === 'rank')!;
  assert.equal(rank.flipped, true);
  assert.equal(rank.baselineDecision, 'high'); assert.equal(rank.candidateDecision, 'low');
  const pickA = labels.find(l => l.questionId === 'pick' && l.label === 'a')!;
  assert.ok(Math.abs(pickA.absDelta - 0.2001) < 1e-12);
  const scoreRow = labels.find(l => l.questionId === 'rank' && l.label === 'score')!;
  assert.ok(Math.abs(scoreRow.absDelta - 0.25) < 1e-12);
  // Ties resolve by sorted label order so the decision is a total function.
  const tied = compareFixture(entry(questions), baseline, {
    pick: { type: 'choice', choice: 'b', confidence: 0.9, probabilities: { a: 0.5, b: 0.5 } },
    rank: { type: 'score', score: 1.5, confidence: 0.8, probabilities: { low: 0.5, high: 0.5 } },
  }, 0.01);
  assert.equal(tied.decisions.find(d => d.questionId === 'pick')!.candidateDecision, 'a');
});

test('bit-level comparison distinguishes equal doubles from near-equal ones', () => {
  const questions = { a: { type: 'noul' as const, instructions: 'x' }, b: { type: 'noul' as const, instructions: 'x' } };
  const baseline: Record<string, JevAnswer> = {
    a: { type: 'noul', noul: 0.1 + 0.2 }, b: { type: 'noul', noul: 0.30000000000000004 },
  };
  const candidate: Record<string, JevAnswer> = {
    a: { type: 'noul', noul: 0.3 }, b: { type: 'noul', noul: 0.30000000000000004 },
  };
  const { labels } = compareFixture(entry(questions), baseline, candidate, 0.01);
  assert.equal(labels.find(l => l.questionId === 'a')!.bitwise, false);
  assert.equal(labels.find(l => l.questionId === 'b')!.bitwise, true);
  assert.equal(labels.find(l => l.questionId === 'a')!.absDelta > 0, true);
  assert.equal(labels.find(l => l.questionId === 'a')!.absDelta < 1e-15, true);
});

test('log-prob deltas are null when either probability is not positive', () => {
  const questions = { zero: { type: 'noul' as const, instructions: 'x' }, one: { type: 'noul' as const, instructions: 'x' } };
  const { labels } = compareFixture(entry(questions), {
    zero: { type: 'noul', noul: 0 }, one: { type: 'noul', noul: 1 },
  }, {
    zero: { type: 'noul', noul: 0.5 }, one: { type: 'noul', noul: 0.999 },
  }, 0.01);
  assert.equal(labels.find(l => l.questionId === 'zero')!.logAbsDelta, null);
  assert.equal(labels.find(l => l.questionId === 'one')!.logAbsDelta, null);
});

const decl: EquivalencePredeclaration = {
  schema: 'jev-shadow-equivalence-predeclaration', version: 1,
  corpus: {
    receipt_path: 'unused', receipt_sha256: '0'.repeat(64), requests: 2, questions: 4,
    record_label_logprobs: 8, transport_label_values: 8, datasets: { holdout2: 2 },
  },
  tolerances: {
    max_abs_probability_delta: 0.01, max_abs_logprob_delta: 0.05, boundary_band: 0.01,
    nonborderline_margin: 0.05, min_global_agreement: 0.995, max_flips_non_active_evidence: 1,
    active_evidence_flips: 0,
  },
  active_evidence: [{ dataset: 'holdout2', fixture: 'route-checkpoint', received_sha256: 'a'.repeat(64), questions: ['call_t3'] }],
  declared_by: 'test', declared_at: '2026-10-11T00:00:00Z', source_citation: 'test',
};

const corpusQuestions = {
  call_t3: { type: 'noul' as const, instructions: 'x' },
  result_t3: { type: 'noul' as const, instructions: 'x' },
  steady: { type: 'noul' as const, instructions: 'x' },
  pick: { type: 'choice' as const, instructions: 'x', criteria: { a: 'A', b: 'B' } },
};
const answers = (noul: number, choiceA: number): Record<string, JevAnswer> => ({
  call_t3: { type: 'noul', noul }, result_t3: { type: 'noul', noul: 0.9 },
  steady: { type: 'noul', noul: 0.9 },
  pick: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: choiceA, b: 1 - choiceA } },
});
const pairs = (baselineNoul: number, candidateNoul: number) => [
  { entry: entry(corpusQuestions, { fixture: 'route-checkpoint', receivedSha256: 'a'.repeat(64) }),
    baseline: answers(baselineNoul, 0.7), candidate: answers(candidateNoul, 0.7) },
  { entry: entry(corpusQuestions, { fixture: 'other', receivedSha256: 'b'.repeat(64) }),
    baseline: answers(0.9, 0.7), candidate: answers(0.9, 0.7) },
];

/** A second fixture with `many` extra steady noul questions plus one boundary question. */
const wideEntry = (many: number, boundary: { baseline: number; candidate: number }) => {
  const questions: Record<string, any> = { ...corpusQuestions };
  const baseline: Record<string, JevAnswer> = answers(0.9, 0.7);
  const candidate: Record<string, JevAnswer> = answers(0.9, 0.7);
  for (let i = 0; i < many; i++) {
    const qid = `steady_${i}`;
    questions[qid] = { type: 'noul', instructions: 'x' };
    baseline[qid] = { type: 'noul', noul: 0.9 };
    candidate[qid] = { type: 'noul', noul: 0.9 };
  }
  questions.boundary = { type: 'noul', instructions: 'x' };
  baseline.boundary = { type: 'noul', noul: boundary.baseline };
  candidate.boundary = { type: 'noul', noul: boundary.candidate };
  return { entry: entry(questions, { fixture: 'other', receivedSha256: 'b'.repeat(64) }), baseline, candidate };
};

test('equivalence report passes an identical replay against the declared tolerances', () => {
  const report = equivalenceReport(pairs(0.51, 0.51), decl);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.decisions.total, 8);
  assert.equal(report.decisions.flips.length, 0);
  assert.equal(report.decisions.agreement_rate, 1);
  assert.equal(report.label_stats.overall.n, 10); // noul x3 plus two choice labels per entry
  assert.equal(report.label_stats.overall.max, 0);
  assert.equal(report.label_stats.overall.not_bitwise, 0);
  assert.equal(report.criteria.every(c => c.pass), true);
  // One decision sits inside the 0.01 band on each of baseline and candidate (call_t3 at 0.51).
  assert.equal(report.decisions.band.baseline.below + report.decisions.band.baseline.above, 1);
  assert.equal(report.decisions.band.candidate.above, 1);
});

test('a flip on an active-evidence question fails regardless of size', () => {
  const report = equivalenceReport(pairs(0.5087, 0.4982), decl);
  assert.equal(report.verdict, 'fail');
  const active = report.criteria.find(c => c.name === 'active_evidence_flips')!;
  assert.equal(active.pass, false);
  assert.equal(active.observed, 1);
  const flips = report.decisions.flips;
  assert.equal(flips.length, 1);
  assert.deepEqual({ dataset: flips[0]!.dataset, fixture: flips[0]!.fixture, questionId: flips[0]!.questionId },
    { dataset: 'holdout2', fixture: 'route-checkpoint', questionId: 'call_t3' });
});

test('a flip on a non-active question passes only inside the declared budget', () => {
  const oneFlip = equivalenceReport([
    { entry: entry(corpusQuestions, { fixture: 'route-checkpoint', receivedSha256: 'a'.repeat(64) }),
      baseline: answers(0.51, 0.7), candidate: answers(0.5100001, 0.7) },
    { entry: entry(corpusQuestions, { fixture: 'other', receivedSha256: 'b'.repeat(64) }),
      baseline: answers(0.9, 0.7), candidate: answers(0.4, 0.7) },
  ], decl);
  assert.equal(oneFlip.decisions.flips.length, 1);
  assert.equal(oneFlip.decisions.flips[0]!.fixture, 'other');
  assert.equal(oneFlip.criteria.find(c => c.name === 'max_flips_non_active_evidence')!.observed, 1);
  assert.equal(oneFlip.verdict, 'fail'); // the same flip also violates the probability-delta tolerance
  const tinyFlip = equivalenceReport([
    { entry: entry(corpusQuestions, { fixture: 'route-checkpoint', receivedSha256: 'a'.repeat(64) }),
      baseline: answers(0.51, 0.7), candidate: answers(0.5100001, 0.7) },
    wideEntry(200, { baseline: 0.5000001, candidate: 0.4999999 }),
  ], decl);
  // A 2e-7 flip inside the band: within the delta tolerance, the flip budget and (at 205
  // decisions) the declared 99.5% global agreement, so the declared criteria all hold.
  assert.equal(tinyFlip.criteria.find(c => c.name === 'max_abs_probability_delta')!.pass, true);
  assert.equal(tinyFlip.criteria.find(c => c.name === 'max_flips_non_active_evidence')!.observed, 1);
  assert.equal(tinyFlip.criteria.find(c => c.name === 'min_global_agreement')!.observed >= 0.995, true);
  assert.equal(tinyFlip.verdict, 'pass');
});

test('nonborderline disagreement is reported separately from band flips', () => {
  const report = equivalenceReport([
    { entry: entry(corpusQuestions, { fixture: 'route-checkpoint', receivedSha256: 'a'.repeat(64) }),
      baseline: answers(0.9, 0.7), candidate: answers(0.9, 0.7) },
    { entry: entry(corpusQuestions, { fixture: 'other', receivedSha256: 'b'.repeat(64) }),
      baseline: answers(0.9, 0.7), candidate: answers(0.2, 0.7) },
  ], decl);
  const criterion = report.criteria.find(c => c.name === 'nonborderline_agreement')!;
  assert.equal(criterion.pass, false);
  assert.equal(report.verdict, 'fail');
});
