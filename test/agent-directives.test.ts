import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BranchMessage } from '../src/core/charter.js';
import { readDirectives, renderDirectives, selectDirectives, type DirectiveAsker } from '../src/core/agent-directives.js';

const user = (entryId: string, text: string): BranchMessage => ({ entryId, role: 'user', text, toolCalls: [] });
const agent = (entryId: string, text: string): BranchMessage => ({ entryId, role: 'assistant', text, toolCalls: [] });
const PLAN = 'Plan: build the charter first, then jev_expand, then measure on the long chains before any deploy.';
const COMMIT = 'I will report the held-out numbers before switching any default on, and I will not touch production until then.';
const ROUTINE = 'Next I will read prune.ts to see the pin code.';
const msgs = [
  agent('a1', `Here is the proposal.\n\n${PLAN}`),
  user('u1', 'yes, do it'),
  agent('a2', `${COMMIT}\n\n${ROUTINE}`),
];

const scripted = (fn: (q: Parameters<DirectiveAsker['ask']>[1]) => Record<string, unknown>): DirectiveAsker => ({ ask: async (_s, q) => ({ answers: fn(q) }) });

test('an approved plan is stored verbatim with its approver; a real commitment is stored and a routine step is not', async () => {
  const asker = scripted(q => {
    const a: Record<string, unknown> = {};
    for (const [id, x] of Object.entries(q)) {
      if (id === 'approves') {
        const label = Object.entries(x.criteria!).find(([, v]) => v.includes('Plan: build'))![0];
        a[id] = { choice: label, probabilities: { [label]: 0.9 } };
      } else if (id.startsWith('commits_')) a[id] = { noul: x.instructions.includes('held-out numbers') ? 0.95 : 0.2 };
    }
    return a;
  });
  const { directives, log } = await selectDirectives([], msgs, new Set(['a1', 'u1', 'a2']), 3, asker);
  const accepted = directives.filter(d => d.kind === 'accepted').map(d => d.text);
  assert.ok(accepted.includes(PLAN));
  assert.ok(directives.every(d => d.kind !== 'accepted' || d.approvedBy === 'u:u1'));
  assert.deepEqual(directives.filter(d => d.kind === 'committed').map(d => d.text), [COMMIT]);
  for (const d of directives) assert.equal(msgs.find(m => m.entryId === d.entryId)!.text.slice(d.start, d.end), d.text);
  assert.equal(log.commits_asked, 2);
  const text = renderDirectives(directives);
  assert.ok(text.includes(PLAN) && text.includes(COMMIT) && !text.includes(ROUTINE));
});

test('low confidence, none, and errors store nothing; earlier directives are kept', async () => {
  const prior = readDirectives([{ id: 'p:x:0', kind: 'committed', entryId: 'x', start: 0, end: 3, text: 'abc', gen: 1 }]);
  for (const asker of [
    scripted(() => ({ approves: { choice: 'M1', probabilities: { M1: 0.5 } }, commits_0: { noul: 0.5 }, commits_1: { noul: 0.1 } })),
    scripted(() => ({ approves: { choice: 'none', probabilities: { none: 0.99 } } })),
    { ask: async () => { throw new Error('down'); } },
  ]) {
    const { directives } = await selectDirectives(prior, msgs, new Set(['a1', 'u1', 'a2']), 3, asker as DirectiveAsker);
    assert.deepEqual(directives, prior);
  }
});

test('a commitment the operator later approves is promoted to accepted', async () => {
  const at = msgs[0]!.text.indexOf(PLAN);
  const prior = readDirectives([{ id: `p:a1:${at}`, kind: 'committed', entryId: 'a1', start: at, end: at + PLAN.length, text: PLAN, gen: 1 }]);
  const asker = scripted(q => (q.approves ? { approves: { choice: 'M1', probabilities: { M1: 0.95 } } } : {}));
  const { directives, log } = await selectDirectives(prior, msgs.slice(0, 2), new Set(['u1']), 2, asker);
  assert.equal(directives.find(d => d.text === PLAN)!.kind, 'accepted');
  assert.equal(log.promoted, 1);
});

test('a bad carry reads as no directives', () => {
  assert.deepEqual(readDirectives(undefined), []);
  assert.deepEqual(readDirectives([{ id: 1 }, null, 'x']), []);
});
