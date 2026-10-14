import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { captureCharter, readCharterState, type BranchMessage } from '../src/core/charter.js';
import { reinstateReferenced, retireCorrected, type ChoiceAsker } from '../src/core/charter-judge.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12);
const opts = { decisionTools: new Set(['ask_user_question']), hash, pasteMinLines: 12, toolOutputMinChars: 600 };
const user = (entryId: string, text: string): BranchMessage => ({ entryId, role: 'user', text, toolCalls: [] });
const entries = captureCharter([user('e1', 'use node-b for builds'), user('e2', 'never push'), user('e3', 'no, use the primary VM, not node-b')], opts);

class Scripted implements ChoiceAsker {
  calls: Array<Record<string, unknown>> = [];
  confirms = 0;
  constructor(private readonly reply: (criteria: Record<string, string>) => unknown, private readonly still: unknown = { noul: 0.05 }) {}
  async ask(state: Record<string, unknown>, questions: Parameters<ChoiceAsker['ask']>[1]) {
    if (questions.still_applies) { this.confirms += 1; return { answers: { still_applies: this.still } }; }
    this.calls.push({ state, criteria: questions.corrects!.criteria });
    return { answers: { corrects: this.reply(questions.corrects!.criteria!) } };
  }
}
const pick = (text: string, p: number) => (criteria: Record<string, string>) => {
  const label = Object.entries(criteria).find(([, v]) => v === text)?.[0] ?? 'none';
  return { choice: label, probabilities: { [label]: p } };
};

test('a confident correction retires exactly the entry it names, with a logged reason', async () => {
  const asker = new Scripted(pick('use node-b for builds', 0.95));
  const { state, log } = await retireCorrected(entries, new Set(['u:e3']), readCharterState(undefined), 4, asker);
  assert.deepEqual(state.retired, { 'u:e1': { reason: 'corrected', by: 'u:e3', gen: 4 } });
  assert.equal(log.length, 1);
  assert.equal(log[0]!.why, 'retired');
  // Most recent first, and never the message itself.
  assert.deepEqual(Object.values(asker.calls[0]!.criteria as Record<string, string>).slice(1), ['never push', 'use node-b for builds']);
});

test('below threshold, none, unknown labels, missing answers and errors retire nothing', async () => {
  const cases: Array<[ChoiceAsker, string]> = [
    [new Scripted(pick('use node-b for builds', 0.6)), 'below_threshold'],
    [new Scripted(() => ({ choice: 'none', probabilities: { none: 0.99 } })), 'none'],
    [new Scripted(() => ({ choice: 'E9', probabilities: { E9: 0.99 } })), 'none'],
    [new Scripted(() => ({ choice: 'E1' })), 'no_answer'],
    [new Scripted(() => undefined), 'no_answer'],
    [{ ask: async () => { throw new Error('down'); } }, 'error'],
  ];
  for (const [asker, why] of cases) {
    const { state, log } = await retireCorrected(entries, new Set(['u:e3']), readCharterState(undefined), 2, asker);
    assert.deepEqual(state.retired, {}, why);
    assert.equal(log[0]!.why, why);
  }
});

test('a confident choice without a confirming no retires nothing', async () => {
  for (const still of [{ noul: 0.4 }, null, { noul: 'x' }]) {
    const asker = new Scripted(pick('use node-b for builds', 0.97), still);
    const { state, log } = await retireCorrected(entries, new Set(['u:e3']), readCharterState(undefined), 4, asker);
    assert.deepEqual(state.retired, {});
    assert.equal(log[0]!.why, 'not_confirmed');
    assert.equal(asker.confirms, 1);
  }
});

test('only fresh operator messages are asked about; the first message has no candidates', async () => {
  const asker = new Scripted(() => ({ choice: 'none', probabilities: { none: 1 } }));
  const { log } = await retireCorrected(entries, new Set(['u:e1']), readCharterState(undefined), 1, asker);
  assert.equal(asker.calls.length, 0);
  assert.equal(log[0]!.why, 'no_candidates');
});

test('earlier retirements are kept and retired entries are not offered again', async () => {
  const prior = readCharterState({ version: 1, retired: { 'u:e1': { reason: 'corrected', by: 'u:e2', gen: 1 } } });
  const asker = new Scripted(() => ({ choice: 'none', probabilities: { none: 1 } }));
  const { state } = await retireCorrected(entries, new Set(['u:e3']), prior, 3, asker);
  assert.deepEqual(Object.keys(state.retired), ['u:e1']);
  assert.deepEqual(Object.values(asker.calls[0]!.criteria as Record<string, string>).slice(1), ['never push']);
});

test('a fresh message that names a retired entry or quotes 40+ characters of it reinstates it; anything else does not', () => {
  const long = captureCharter([
    user('e1', 'Always deploy through the production-boundary copy step, never by hand-editing /opt/production.'),
    user('e2', 'no, it is fine to hand-edit for config'),
    user('e3', 'go back to what I said: Always deploy through the production-boundary copy step'),
    user('e4', 'restore u:e1 please'),
    user('e5', 'deploy'),
  ], opts);
  const retiredE1 = readCharterState({ version: 1, retired: { 'u:e1': { reason: 'corrected', by: 'u:e2', gen: 2 } } });
  assert.deepEqual(reinstateReferenced(long, new Set(['u:e3']), retiredE1).reinstated, ['u:e1']);
  assert.deepEqual(reinstateReferenced(long, new Set(['u:e4']), retiredE1).reinstated, ['u:e1']);
  const none = reinstateReferenced(long, new Set(['u:e5']), retiredE1);
  assert.deepEqual(none.reinstated, []);
  assert.deepEqual(Object.keys(none.state.retired), ['u:e1']);
  assert.deepEqual(reinstateReferenced(long, new Set(['u:e3']), retiredE1).state.retired, {});
});

test('the confirmation question asks the pinned wording over exactly the two messages; the corrects wording is unchanged', async () => {
  const seen: { corrects?: string; still?: string; stateKeys?: string[] } = {};
  const asker: ChoiceAsker = {
    async ask(state, questions) {
      if (questions.still_applies) {
        seen.still = questions.still_applies.instructions;
        seen.stateKeys = Object.keys(state);
        return { answers: { still_applies: { noul: 0.05 } } };
      }
      seen.corrects = questions.corrects!.instructions;
      return { answers: { corrects: pick('use node-b for builds', 0.95)(questions.corrects!.criteria!) } };
    },
  };
  const { log } = await retireCorrected(entries, new Set(['u:e3']), readCharterState(undefined), 4, asker);
  assert.equal(log[0]!.why, 'retired');
  assert.equal(
    seen.still,
    'After new_operator_message, does earlier_operator_message still apply, in whole or in part?',
  );
  assert.deepEqual(seen.stateKeys, ['earlier_operator_message', 'new_operator_message']);
  assert.equal(
    seen.corrects,
    'The operator has just sent new_operator_message. Does it correct, reverse or retract one of the earlier operator messages or answers listed as options, so that the earlier one no longer applies? Choose that earlier entry only if the new message clearly replaces it. Adding a requirement, narrowing it, or asking a new question is not a correction: choose none.',
  );
});
