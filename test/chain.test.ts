import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { JevError } from '../src/client/jev-client.js';
import { captureCharter, readCharterState, type BranchMessage } from '../src/core/charter.js';
import { EMPTY_CHAIN, finishedRoots, paragraphs, readChainState, renderChain, updateChain, verifyStep, type ChainAsker } from '../src/core/chain.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12);
const opts = { decisionTools: new Set<string>(), hash, pasteMinLines: 12, toolOutputMinChars: 600 };
const user = (entryId: string, text: string): BranchMessage => ({ entryId, role: 'user', text, toolCalls: [] });
const agent = (entryId: string, text: string): BranchMessage => ({ entryId, role: 'assistant', text, toolCalls: [] });

const charter = captureCharter([user('e1', 'Adopt the cachelane techniques in /compact.'), user('e2', 'Keep core directives through every compaction.')], opts);
const stepText = 'Now I am building the charter module so that operator directives are carried verbatim through every compaction.';
const span = [agent('a1', `Short.\n\n${stepText}\n\n  Next I will run the replay harness on the long chains to measure directive survival.  `)];

class Scripted implements ChainAsker {
  last: Parameters<ChainAsker['ask']> | undefined;
  constructor(private readonly answers: Record<string, unknown>) {}
  async ask(...args: Parameters<ChainAsker['ask']>) { this.last = args; return { answers: this.answers }; }
}

test('paragraphs are exact slices of their entry', () => {
  const ps = paragraphs(span[0]!, 60);
  assert.equal(ps.length, 2);
  for (const p of ps) assert.ok(verifyStep(p, span[0]!.text));
  assert.equal(ps[0]!.text, stepText);
});

test('the served request and the agent step are recorded; the render shows the path', async () => {
  const asker = new Scripted({ serves: { choice: 'R1', probabilities: { R1: 0.8 } }, step: { choice: 'P1', probabilities: { P1: 0.7 } } });
  const { state } = await updateChain(EMPTY_CHAIN, charter, readCharterState(undefined), span, 1, asker);
  assert.equal(state.current, 'u:e2'); // R1 is the most recent live request
  assert.equal(state.branches[0]!.steps[0]!.text, stepText);
  const text = renderChain(state, charter);
  assert.ok(text.includes('[u:e2] "Keep core directives'));
  assert.ok(text.includes(`(compaction 1) ${stepText}`));
});

test('a confident done answer marks an open request finished; finished roots are listed as one line', async () => {
  const first = await updateChain(EMPTY_CHAIN, charter, readCharterState(undefined), span, 1,
    new Scripted({ serves: { choice: 'R2', probabilities: { R2: 0.9 } } }));
  assert.equal(first.state.current, 'u:e1');
  const second = await updateChain(first.state, charter, readCharterState(undefined), span, 2,
    new Scripted({ serves: { choice: 'R1', probabilities: { R1: 0.9 } }, done_0: { noul: 0.95 }, pending_0: { noul: 0.05 } }));
  assert.equal(second.state.current, 'u:e2');
  assert.deepEqual([...finishedRoots(second.state)], ['u:e1']);
  const pendingSaysYes = await updateChain(first.state, charter, readCharterState(undefined), span, 2,
    new Scripted({ serves: { choice: 'R1', probabilities: { R1: 0.9 } }, done_0: { noul: 0.95 }, pending_0: { noul: 0.4 } }));
  assert.equal(finishedRoots(pendingSaysYes.state).size, 0, 'a done answer without a confirming nothing-pending keeps it open');
  assert.ok(renderChain(second.state, charter).includes('Finished requests'));
});

test('a low done probability keeps the request open', async () => {
  const first = await updateChain(EMPTY_CHAIN, charter, readCharterState(undefined), span, 1,
    new Scripted({ serves: { choice: 'R2', probabilities: { R2: 0.9 } } }));
  const second = await updateChain(first.state, charter, readCharterState(undefined), span, 2,
    new Scripted({ serves: { choice: 'R1', probabilities: { R1: 0.9 } }, done_0: { noul: 0.6 } }));
  assert.equal(finishedRoots(second.state).size, 0);
});

test('errors and unusable answers keep the previous chain', async () => {
  const first = await updateChain(EMPTY_CHAIN, charter, readCharterState(undefined), span, 1,
    new Scripted({ serves: { choice: 'R1', probabilities: { R1: 0.9 } } }));
  const failed = await updateChain(first.state, charter, readCharterState(undefined), span, 2, { ask: async () => { throw new Error('x'); } });
  assert.deepEqual(failed.state, first.state);
  const vague = await updateChain(first.state, charter, readCharterState(undefined), span, 2,
    new Scripted({ serves: { choice: 'R2', probabilities: { R2: 0.3 } } }));
  assert.equal(vague.state.current, first.state.current);
});

class LocalValidating extends Scripted {
  readonly calls: Parameters<ChainAsker['ask']>[] = [];
  async ask(...args: Parameters<ChainAsker['ask']>) {
    this.calls.push(args);
    if (Object.keys(args[1]).length === 0 || Object.values(args[1]).some(q =>
      q.type === 'choice' && Object.keys(q.criteria ?? {}).length < 2)) {
      throw new JevError('parse', 'Local decision questions are invalid');
    }
    return super.ask(...args);
  }
}

const singleRoot = charter.slice(0, 1);
const singleSpan = [agent('a1', stepText)];
const openChain = { version: 1 as const, branches: [{ root: 'u:e1', steps: [], done: false, since: 1 }], current: 'u:e1' };

test('one live root resolves serves locally while step and done are asked', async () => {
  const asker = new LocalValidating({ step: { choice: 'P1', probabilities: { P1: 0.7 } }, done_0: { noul: 0.1 } });
  const { state, log } = await updateChain(openChain, singleRoot, readCharterState(undefined), span, 2, asker);
  assert.equal(log.why, 'ok');
  assert.deepEqual(log.singleton, ['serves']);
  assert.deepEqual(Object.keys(asker.calls[0]![1]), ['step', 'done_0']);
  assert.equal(state.current, 'u:e1');
  assert.equal(state.branches[0]!.steps[0]!.text, stepText);
  assert.equal(log['done_u:e1'], 0.1);
  assert.deepEqual(openChain.branches[0]!.steps, [], 'the previous chain is not mutated');
});

test('one paragraph resolves step locally while serves and done are asked', async () => {
  const asker = new LocalValidating({ serves: { choice: 'R1', probabilities: { R1: 0.8 } }, done_0: { noul: 0.1 } });
  const { state, log } = await updateChain(openChain, charter, readCharterState(undefined), singleSpan, 2, asker);
  assert.equal(log.why, 'ok');
  assert.deepEqual(log.singleton, ['step']);
  assert.deepEqual(Object.keys(asker.calls[0]![1]), ['serves', 'done_0']);
  assert.equal(state.current, 'u:e2');
  assert.deepEqual(state.branches[1]!.steps, [{ entryId: 'a1', start: 0, end: stepText.length, text: stepText, gen: 2 }]);
  assert.deepEqual(log.step, { choice: 'P1', p: 1 });
});

test('one root and one paragraph with no open branches update without calling the asker', async () => {
  const asker = new LocalValidating({});
  const { state, log } = await updateChain(EMPTY_CHAIN, singleRoot, readCharterState(undefined), singleSpan, 21, asker);
  assert.equal(asker.calls.length, 0);
  assert.equal(log.why, 'ok');
  assert.deepEqual(log.singleton, ['serves', 'step']);
  assert.equal(state.current, 'u:e1');
  assert.equal(state.branches[0]!.since, 21);
  assert.equal(state.branches[0]!.steps[0]!.gen, 21);
  assert.ok(verifyStep(state.branches[0]!.steps[0]!, singleSpan[0]!.text));
});

test('local-client parse validation no longer freezes singleton chain updates', async () => {
  const asker = new LocalValidating({ done_0: { noul: 0.1 } });
  await assert.rejects(asker.ask({}, { serves: { type: 'choice', instructions: 'Choose', criteria: { R1: 'Only root' } } }),
    (error: unknown) => error instanceof JevError && error.kind === 'parse');
  asker.calls.length = 0;
  const { state, log } = await updateChain(openChain, singleRoot, readCharterState(undefined), singleSpan, 21, asker);
  assert.equal(log.why, 'ok'); // Before the fix: 'error', with state === openChain and zero steps.
  assert.equal(state.branches[0]!.steps.length, 1);
  assert.deepEqual(Object.keys(asker.calls[0]![1]), ['done_0']);
});

test('singleton step preserves done confirmation for other requests', async () => {
  const asker = new LocalValidating({ serves: { choice: 'R1', probabilities: { R1: 1 } }, done_0: { noul: 0.95 }, pending_0: { noul: 0.05 } });
  const { state, log } = await updateChain(openChain, charter, readCharterState(undefined), singleSpan, 2, asker);
  assert.equal(log.why, 'ok');
  assert.deepEqual(Object.keys(asker.calls[1]![1]), ['pending_0']);
  assert.deepEqual([...finishedRoots(state)], ['u:e1']);
  assert.equal(state.branches[1]!.steps.length, 1);
});

test('a low-confidence served request does not attach a deterministic step', async () => {
  const asker = new LocalValidating({ serves: { choice: 'R1', probabilities: { R1: 0.3 } } });
  const { state, log } = await updateChain(EMPTY_CHAIN, charter, readCharterState(undefined), singleSpan, 2, asker);
  assert.equal(log.why, 'ok');
  assert.deepEqual(log.singleton, ['step']);
  assert.deepEqual(state, EMPTY_CHAIN);
});

test('one root with no candidate paragraph creates a branch without inventing a step', async () => {
  const asker = new LocalValidating({});
  const { state, log } = await updateChain(EMPTY_CHAIN, singleRoot, readCharterState(undefined), [], 2, asker);
  assert.equal(asker.calls.length, 0);
  assert.deepEqual(log.singleton, ['serves']);
  assert.equal(state.current, 'u:e1');
  assert.deepEqual(state.branches[0]!.steps, []);
  assert.equal(log.step, null);
});

test('a remaining question failure keeps the previous singleton chain', async () => {
  const { state, log } = await updateChain(openChain, singleRoot, readCharterState(undefined), singleSpan, 2,
    { ask: async () => { throw new JevError('parse', 'bad answer'); } });
  assert.equal(state, openChain);
  assert.equal(log.why, 'error');
});

test('a bad carry reads as the empty chain', () => {
  for (const raw of [undefined, null, 1, { version: 2 }, { version: 1, branches: 'x' }]) assert.deepEqual(readChainState(raw).branches, []);
  const s = readChainState({ version: 1, branches: [{ root: 'u:e1', steps: [{ bad: 1 }], done: false }], current: 'u:missing' });
  assert.equal(s.branches[0]!.steps.length, 0);
  assert.equal(s.current, null);
});

test('the session\'s first request stays selectable however many requests follow it', async () => {
  const many = captureCharter(Array.from({ length: 14 }, (_, i) => user(`m${i}`, `request number ${i} with enough words`)), opts);
  const asker = new Scripted({ serves: { choice: 'R1', probabilities: { R1: 0.9 } } });
  await updateChain(EMPTY_CHAIN, many, readCharterState(undefined), span, 1, asker);
  const criteria = Object.values(asker.last![1].serves!.criteria!);
  assert.ok(criteria.includes('request number 0 with enough words'));
  assert.ok(criteria.includes('request number 13 with enough words'));
  assert.equal(criteria.length, 11);
});
