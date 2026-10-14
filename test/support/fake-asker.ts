import type { JevAnswer, JevAsker, JevQuestions, JevResponse, JevState } from '../../src/vendor/pi-jev/vendor/fast-jev-compaction/index.js';

export type Policy = (name: string) => JevAnswer | undefined;

export const allOnes: Policy = name =>
  name.startsWith('staleness_') ? { score: 0, confidence: 1, probabilities: {} } : { noul: 1 };
export const allZero: Policy = name =>
  name.startsWith('staleness_') ? { score: 4, confidence: 1, probabilities: {} } : { noul: 0 };
/** Every text keep question gets `p`; calls keep. */
export const textKeep = (p: number): Policy => name => (name.startsWith('keep_m') ? { noul: p } : allOnes(name));

export class FakeAsker implements JevAsker {
  readonly asked: string[][] = [];
  readonly states: unknown[] = [];
  /** Each request as sent: its questions and its state. */
  readonly requests: Array<{ questions: JevQuestions; state: JevState }> = [];
  constructor(private readonly policy: Policy = allOnes) {}
  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const names = Object.keys(questions);
    this.asked.push(names);
    this.states.push(state);
    this.requests.push({ questions, state });
    const answers: Record<string, JevAnswer> = {};
    for (const name of names) {
      const answer = this.policy(name);
      if (answer) answers[name] = answer;
    }
    return { answers, usage: { input_tokens: 100, output_tokens: 1 } };
  }
  get questionCount(): number {
    return this.asked.flat().length;
  }
}
