/**
 * Decision-level and value-level comparison for the equivalence study.
 *
 * The decision rule mirrors `decideCall` (src/vendor/pi-jev/compaction/decision.ts:175): a noul
 * probability at or above 0.50 keeps the segment, below it drops. Choice and score decisions
 * are the argmax label of the returned probabilities. "Bit-level" here means the strongest the
 * JSON transport permits: identical parsed doubles (Object.is, which distinguishes -0 and NaN)
 * whose canonical serializations also match — true tensor-level bits are not observable through
 * a JSON decision response, and the report says so by counting both.
 */
import type { JevAnswer } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import type { FixtureRequest } from './fixtures.js';
import type { EquivalencePredeclaration } from './predeclaration.js';

export const BOUNDARY_P = 0.5;
/** 0.5 - 0.49 is 0.010000000000000009 in binary floating point; the band comparison absorbs that. */
export const BAND_EPSILON = 1e-12;

export interface LabelComparison {
  dataset: string;
  fixture: string;
  receivedSha256: string;
  questionId: string;
  label: string;
  baseline: number;
  candidate: number;
  absDelta: number;
  /** |ln(candidate) - ln(baseline)|; null when either probability is not positive. */
  logAbsDelta: number | null;
  bitwise: boolean;
}

export interface DecisionComparison {
  dataset: string;
  fixture: string;
  receivedSha256: string;
  questionId: string;
  type: 'noul' | 'choice' | 'score';
  baselineDecision: string;
  candidateDecision: string;
  flipped: boolean;
  /** Distance to the deciding threshold: |p - 0.50| for noul, top1 - top2 for argmax. */
  baselineMargin: number | null;
  candidateMargin: number | null;
  bandBaseline: 'below' | 'above' | null;
  bandCandidate: 'below' | 'above' | null;
}

export interface AbsStats { n: number; min: number | null; median: number | null; p95: number | null; max: number | null }

/** Nearest-rank percentile (the definition eval/rtx4000/bench.mts uses), on any order. */
export function nearestRank(values: number[], q: number): number {
  if (!values.length) throw new Error('nearestRank of an empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

export function summarizeAbs(values: number[]): AbsStats {
  if (!values.length) return { n: 0, min: null, median: null, p95: null, max: null };
  return {
    n: values.length,
    min: Math.min(...values),
    median: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: Math.max(...values),
  };
}

const numbers = (record: Record<string, unknown>): Array<[string, number]> =>
  Object.entries(record).filter(([, v]): v is number => typeof v === 'number');
const bitwiseEqual = (a: number, b: number): boolean => Object.is(a, b) && JSON.stringify(a) === JSON.stringify(b);
const logDelta = (a: number, b: number): number | null =>
  a > 0 && a < 1 && b > 0 && b < 1 ? Math.abs(Math.log(b) - Math.log(a)) : null;

/** Argmax label with ties resolved by sorted label order, so the decision is a total function. */
function argmax(probabilities: Record<string, number>): { label: string; margin: number } {
  const sorted = numbers(probabilities).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let best: [string, number] | undefined;
  let runnerUp = -Infinity;
  for (const [label, value] of sorted) {
    if (best === undefined || value > best[1]) { if (best !== undefined) runnerUp = best[1]; best = [label, value]; }
    else if (value > runnerUp) runnerUp = value;
  }
  if (best === undefined) throw new Error('argmax of an empty label set');
  return { label: best[0], margin: best[1] - (runnerUp === -Infinity ? best[1] : runnerUp) };
}

const bandSide = (p: number, band: number): 'below' | 'above' | null => {
  const distance = Math.abs(p - BOUNDARY_P);
  if (distance > band + BAND_EPSILON) return null;
  return p < BOUNDARY_P ? 'below' : 'above';
};

export function compareFixture(entry: FixtureRequest, baseline: Record<string, JevAnswer>,
  candidate: Record<string, JevAnswer>, band: number): { labels: LabelComparison[]; decisions: DecisionComparison[] } {
  const labels: LabelComparison[] = [];
  const decisions: DecisionComparison[] = [];
  for (const [questionId, question] of Object.entries(entry.questions)) {
    const a = baseline[questionId];
    const b = candidate[questionId];
    if (!a || !b) throw new Error(`missing answer for question ${questionId}`);
    const row = (label: string, baselineValue: number, candidateValue: number) => labels.push({
      dataset: entry.dataset, fixture: entry.fixture, receivedSha256: entry.receivedSha256,
      questionId, label, baseline: baselineValue, candidate: candidateValue,
      absDelta: Math.abs(candidateValue - baselineValue),
      logAbsDelta: logDelta(baselineValue, candidateValue),
      bitwise: bitwiseEqual(baselineValue, candidateValue),
    });
    if (question.type === 'noul' && typeof a.noul === 'number' && typeof b.noul === 'number') {
      row('noul', a.noul, b.noul);
      decisions.push({
        dataset: entry.dataset, fixture: entry.fixture, receivedSha256: entry.receivedSha256,
        questionId, type: 'noul',
        baselineDecision: a.noul >= BOUNDARY_P ? 'keep' : 'drop',
        candidateDecision: b.noul >= BOUNDARY_P ? 'keep' : 'drop',
        flipped: (a.noul >= BOUNDARY_P) !== (b.noul >= BOUNDARY_P),
        baselineMargin: Math.abs(a.noul - BOUNDARY_P), candidateMargin: Math.abs(b.noul - BOUNDARY_P),
        bandBaseline: bandSide(a.noul, band), bandCandidate: bandSide(b.noul, band),
      });
    } else if (question.type === 'choice' || question.type === 'score') {
      const probabilitiesA = (a.probabilities ?? {}) as Record<string, number>;
      const probabilitiesB = (b.probabilities ?? {}) as Record<string, number>;
      const keys = [...new Set([...Object.keys(probabilitiesA), ...Object.keys(probabilitiesB)])].sort();
      for (const key of keys) {
        if (typeof probabilitiesA[key] === 'number' && typeof probabilitiesB[key] === 'number') {
          row(key, probabilitiesA[key]!, probabilitiesB[key]!);
        }
      }
      if (question.type === 'score' && typeof a.score === 'number' && typeof b.score === 'number') {
        row('score', a.score, b.score);
      }
      const decisionA = argmax(probabilitiesA), decisionB = argmax(probabilitiesB);
      decisions.push({
        dataset: entry.dataset, fixture: entry.fixture, receivedSha256: entry.receivedSha256,
        questionId, type: question.type,
        baselineDecision: decisionA.label, candidateDecision: decisionB.label,
        flipped: decisionA.label !== decisionB.label,
        baselineMargin: decisionA.margin, candidateMargin: decisionB.margin,
        bandBaseline: null, bandCandidate: null,
      });
    } else {
      throw new Error(`unsupported question type for ${questionId}`);
    }
  }
  return { labels, decisions };
}

export interface EquivalenceReport {
  corpus: { requests: number; questions: number; transport_label_values: number; datasets: Record<string, number> };
  label_stats: { overall: AbsStats & { over_tolerance: number; not_bitwise: number }; by_dataset: Record<string, AbsStats & { over_tolerance: number; not_bitwise: number }> };
  log_stats: { overall: AbsStats & { skipped: number } };
  decisions: {
    total: number;
    flips: DecisionComparison[];
    agreement_rate: number;
    band: { baseline: { below: number; above: number }; candidate: { below: number; above: number } };
  };
  criteria: Array<{ name: string; declared: unknown; observed: unknown; pass: boolean; detail?: unknown }>;
  verdict: 'pass' | 'fail';
}

export function equivalenceReport(pairs: Array<{ entry: FixtureRequest; baseline: Record<string, JevAnswer>; candidate: Record<string, JevAnswer> }>,
  declaration: EquivalencePredeclaration): EquivalenceReport {
  const tolerances = declaration.tolerances;
  const allLabels: LabelComparison[] = [];
  const allDecisions: DecisionComparison[] = [];
  const datasets = new Map<string, { labels: LabelComparison[]; decisions: DecisionComparison[] }>();
  for (const { entry, baseline, candidate } of pairs) {
    const compared = compareFixture(entry, baseline, candidate, tolerances.boundary_band);
    allLabels.push(...compared.labels);
    allDecisions.push(...compared.decisions);
    const bucket = datasets.get(entry.dataset) ?? { labels: [], decisions: [] };
    bucket.labels.push(...compared.labels);
    bucket.decisions.push(...compared.decisions);
    datasets.set(entry.dataset, bucket);
  }
  const statsOf = (labels: LabelComparison[]) => {
    const deltas = labels.map(l => l.absDelta);
    return {
      ...summarizeAbs(deltas),
      over_tolerance: labels.filter(l => l.absDelta > tolerances.max_abs_probability_delta).length,
      not_bitwise: labels.filter(l => !l.bitwise).length,
    };
  };
  const logValues = allLabels.flatMap(l => (l.logAbsDelta === null ? [] : [l.logAbsDelta]));
  const flips = allDecisions.filter(d => d.flipped);
  const activeKeys = new Set(declaration.active_evidence
    .flatMap(e => e.questions.map(q => `${e.dataset} ${e.received_sha256} ${q}`)));
  const activeFlips = flips.filter(f => activeKeys.has(`${f.dataset} ${f.receivedSha256} ${f.questionId}`));
  const nonActiveFlips = flips.length - activeFlips.length;
  const nonborderlineFlips = flips.filter(f =>
    f.type === 'noul' && f.baselineMargin !== null && f.baselineMargin > tolerances.nonborderline_margin);
  const agreementRate = allDecisions.length ? (allDecisions.length - flips.length) / allDecisions.length : 0;
  const bandOf = (pick: (d: DecisionComparison) => 'below' | 'above' | null) => ({
    below: allDecisions.filter(d => pick(d) === 'below').length,
    above: allDecisions.filter(d => pick(d) === 'above').length,
  });
  const maxAbs = allLabels.length ? Math.max(...allLabels.map(l => l.absDelta)) : 0;
  const maxLog = logValues.length ? Math.max(...logValues) : 0;
  const criteria: EquivalenceReport['criteria'] = [
    { name: 'max_abs_probability_delta', declared: tolerances.max_abs_probability_delta,
      observed: maxAbs, pass: maxAbs <= tolerances.max_abs_probability_delta },
    { name: 'max_abs_logprob_delta', declared: tolerances.max_abs_logprob_delta,
      observed: maxLog, pass: maxLog <= tolerances.max_abs_logprob_delta,
      detail: { skipped_non_positive: allLabels.length - logValues.length } },
    { name: 'nonborderline_agreement', declared: 'no flips where |p-0.50| > nonborderline_margin',
      observed: nonborderlineFlips.length, pass: nonborderlineFlips.length === 0 },
    { name: 'min_global_agreement', declared: tolerances.min_global_agreement,
      observed: agreementRate, pass: allDecisions.length > 0 && agreementRate >= tolerances.min_global_agreement },
    { name: 'max_flips_non_active_evidence', declared: tolerances.max_flips_non_active_evidence,
      observed: nonActiveFlips, pass: nonActiveFlips <= tolerances.max_flips_non_active_evidence },
    { name: 'active_evidence_flips', declared: tolerances.active_evidence_flips,
      observed: activeFlips.length, pass: activeFlips.length <= tolerances.active_evidence_flips },
  ];
  return {
    corpus: {
      requests: pairs.length,
      questions: allDecisions.length,
      transport_label_values: allLabels.length,
      datasets: [...datasets.entries()].reduce<Record<string, number>>((acc, [name, bucket]) => {
        acc[name] = bucket.decisions.length; return acc;
      }, {}),
    },
    label_stats: {
      overall: statsOf(allLabels),
      by_dataset: [...datasets.entries()].reduce<Record<string, ReturnType<typeof statsOf>>>((acc, [name, bucket]) => {
        acc[name] = statsOf(bucket.labels); return acc;
      }, {}),
    },
    log_stats: { overall: { ...summarizeAbs(logValues), skipped: allLabels.length - logValues.length } },
    decisions: {
      total: allDecisions.length,
      flips,
      agreement_rate: agreementRate,
      band: { baseline: bandOf(d => d.bandBaseline), candidate: bandOf(d => d.bandCandidate) },
    },
    criteria,
    verdict: criteria.every(c => c.pass) ? 'pass' : 'fail',
  };
}
