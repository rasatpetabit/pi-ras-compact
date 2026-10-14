import type { ChoiceAnswer, ChoiceQuestion } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Shared service choice validation, extracted from validateLocalAnswers. */
export function readChoiceAnswer(answer: unknown, criteria: ChoiceQuestion['criteria']): ChoiceAnswer | undefined {
  if (!record(answer) || (answer.type !== undefined && answer.type !== 'choice')) return undefined;
  const labels = Object.keys(criteria);
  if (labels.length < 2 || !record(answer.probabilities) || Object.keys(answer.probabilities).length !== labels.length) return undefined;
  const probabilities: Record<string, number> = Object.create(null);
  for (const label of labels) {
    const value = Object.hasOwn(answer.probabilities, label) ? answer.probabilities[label] : undefined;
    if (!probability(value)) return undefined;
    probabilities[label] = value;
  }
  const values = Object.values(probabilities);
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-5 || !probability(answer.confidence)) return undefined;
  const top = Math.max(...values);
  if (typeof answer.choice !== 'string' || !Object.hasOwn(probabilities, answer.choice) || Math.abs(probabilities[answer.choice]! - top) > 1e-5) return undefined;
  // Confidence is a bounded service field; the choice contract specifies no formula.
  return { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities };
}
