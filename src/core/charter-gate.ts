import type { ChoiceAsker } from './charter-judge.js';
import { readChoiceAnswer } from './choice-answer.js';

export interface CharterGate {
  asker: ChoiceAsker;
  replaceMin: number;
  defersMax: number;
}
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

export function fourWayQuestion(label: string) {
  const criteria: Record<string, string> = {
    none: 'None of the other options: new_operator_message is unrelated to earlier_entry, or answers or asks something, without changing earlier_entry or adding a like instruction.',
    [`${label}_replaces_as_whole`]: 'new_operator_message replaces earlier_entry as a whole, so that earlier_entry no longer applies.',
    [`${label}_adds_without_replacing`]: 'new_operator_message adds a further instruction of the same kind as earlier_entry, leaving earlier_entry fully in force.',
    [`${label}_announces_change_but_defers_specification`]: 'new_operator_message announces or implies that earlier_entry will change or be replaced, but withholds what takes its place: the substitute or its details are deferred, promised for later, or referenced but not yet determined, so earlier_entry still applies until that is specified.',
  };
  return {
    [`${label}_relation`]: {
      type: 'choice' as const,
      instructions: `For earlier_entry = earlier_entries.${label}: how does new_operator_message relate to earlier_entry? Choose the single best option.`,
      criteria,
    },
  };
}

/** Four-way relation gate: proposal AND P(replaces_as_whole) >= R AND P(defers) <= D.
 * The caller has already confirmed the production proposal. No target discovery or
 * recovery here. The .15 inventory exclusion margin is not an admission threshold.
 * Analytical catch: at D=1.0 the defers constraint is vacuous (all probabilities <= 1.0)
 * so it admits on replaces alone; the defers label redistributed probability mass.
 * Conservative grid points like R=.72, D=.14 use both signals genuinely.
 * Any answer validation failure, unknown label, or transport failure fails closed (keeps).
 */
export async function admitCharterProposal(
  gate: CharterGate,
  state: { new_operator_message: string },
  questions: { corrects: { type: 'choice'; instructions: string; criteria: Record<string, string> } },
  label: string,
): Promise<boolean> {
  if (![gate.replaceMin, gate.defersMax].every(probability)
      || label === 'none' || !Object.hasOwn(questions.corrects.criteria, label)) return false;
  try {
    const questionName = `${label}_relation`;
    const relationQuestions = fourWayQuestion(label);
    const askState = {
      new_operator_message: state.new_operator_message,
      earlier_entries: { [label]: questions.corrects.criteria[label] },
    };
    const result = await gate.asker.ask(askState, relationQuestions);
    const answer = result.answers[questionName];
    const choice = readChoiceAnswer(answer, relationQuestions[questionName].criteria);
    if (!choice) return false;
    const r = choice.probabilities[`${label}_replaces_as_whole`];
    const d = choice.probabilities[`${label}_announces_change_but_defers_specification`];
    return probability(r) && probability(d) && r >= gate.replaceMin && d <= gate.defersMax;
  } catch { return false; } // Never copy provider/transport errors into the charter log.
}
