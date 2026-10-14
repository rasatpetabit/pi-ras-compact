import { readChoiceAnswer } from '../core/choice-answer.js';
import type { JevAnswer, JevQuestions } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Observational hosted-count gate: core/judge.ts noul requires [0, 1]; vendored
 * request.ts noulAnswer and compaction/decision.ts noulOr/scoreAnswer read finite
 * noul/score. core/{chain,agent-directives,charter-judge}.ts readChoice reads
 * choice plus probabilities[choice] (charter-judge also requires it finite).
 * These readers ignore `type` and do not require the local service's confidence
 * or probability algebra. Count only nonempty requests readable by these paths.
 * Take the response itself so even access to its answers is inside the catch.
 */
export function hasHostedRequestedAnswers(response: unknown, questions: JevQuestions): boolean {
  try {
    if (!record(response) || !record(questions)) return false;
    const answers = response.answers;
    if (!record(answers)) return false;
    const ids = Object.keys(questions);
    if (ids.length === 0) return false;
    return ids.every(id => {
      const question = questions[id];
      const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
      if (!record(question) || !record(answer)) return false;
      switch (question.type) {
        case 'noul': return probability(answer.noul);
        case 'score': return typeof answer.score === 'number' && Number.isFinite(answer.score);
        case 'choice': {
          const { choice, probabilities } = answer;
          if (typeof choice !== 'string' || !record(probabilities)) return false;
          const p = probabilities[choice];
          return typeof p === 'number' && Number.isFinite(p);
        }
        default: return false;
      }
    });
  } catch {
    // Counting must never affect the hosted parser's return or failure behavior.
    return false;
  }
}

/** The local typed-answer rule, without service identity or extra-ID constraints. */
export function validatedRequestedAnswers(raw: unknown, questions: JevQuestions): Record<string, JevAnswer> | undefined {
  if (!record(raw)) return undefined;
  const ids = Object.keys(questions);
  const answers: Record<string, JevAnswer> = Object.create(null);
  for (const id of ids) {
    const question = questions[id]!;
    const answer = Object.hasOwn(raw, id) ? raw[id] : undefined;
    if (!record(answer) || answer.type !== question.type) return undefined;
    if (question.type === 'noul') {
      if (!probability(answer.noul)) return undefined;
      answers[id] = { type: 'noul', noul: answer.noul };
      continue;
    }
    if (question.type === 'choice') {
      const choice = readChoiceAnswer(answer, question.criteria);
      if (!choice) return undefined;
      answers[id] = choice;
      continue;
    }
    const labels = question.criteria.map((_, index) => String(index));
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
    const confidence = top - (values.reduce((sum, value) => sum + value, 0) - top) / (values.length - 1);
    if (Math.abs(answer.confidence - confidence) > 1e-5) return undefined;
    if (question.type === 'score') {
      const expected = labels.reduce((sum, label, index) => sum + index * probabilities[label]!, 0);
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || Math.abs(answer.score - expected) > 1e-5) return undefined;
      answers[id] = { type: 'score', score: answer.score, confidence: answer.confidence, probabilities };
    } else {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(probabilities, answer.choice) || Math.abs(probabilities[answer.choice]! - top) > 1e-5) return undefined;
      answers[id] = { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities };
    }
  }
  return answers;
}
