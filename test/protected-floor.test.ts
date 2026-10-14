import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactSpan, tokensForChars, type CompactInput } from '../src/core/prune.js';
import { coreOptions } from '../src/client/config.js';
import { renderSegment, summaryOverheadChars } from '../src/core/render.js';
import { testConfig } from './support/config.js';
import { FakeAsker, allOnes } from './support/fake-asker.js';
import { user, say, call } from './support/span.js';

const options = coreOptions(testConfig());
const input = (patch: Partial<CompactInput>): CompactInput => ({
  previous: undefined, span: [], goal: 'Continue safely', budgetTokens: 1,
  suffixChars: 0, demotedUnknown: 0, ...patch,
});
const forbidden = { ask: async () => { throw Error('must not score'); } };

test('over-floor result keeps exact pins, paired tools and source hashes without scoring', async () => {
  const source = input({
    previous: { version: 1, generation: 1, segments: [{ kind: 'assistant', text: 'old optional', pin: null, gen: 1 }] },
    span: [user('Preserve ticket T_42 and do not deploy'), say('fresh optional'),
      ...call('read', 'read', { path: 'src/a.ts' }, 'optional result'),
      ...call('edit', 'edit', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }, 'Applied exact edit'),
      ...call('error', 'bash', { command: 'check' }, 'Exact failure E_0x123', true)],
    suffixChars: 19, demotedUnknown: 2,
  });
  const result = await compactSpan(source, options, forbidden);
  assert.equal(result.stats.step, 6); assert.equal(result.stats.generation, 2);
  assert.equal(result.stats.jevRequests, 0); assert.equal(result.stats.asked, 0);
  assert.equal(result.stats.unasked, 3); assert.equal(result.stats.demotedUnknown, 2);
  assert.equal(result.decisions.threshold_final, null);
  assert.deepEqual(result.carry.segments.map(s => s.pin), ['user', 'modify', 'error']);
  for (const text of ['ticket T_42', 'Applied exact edit', 'Exact failure E_0x123']) assert.ok(result.summary.includes(text));
  assert.ok(!result.summary.includes('optional'));
  assert.ok(result.carry.segments.every(s => s.srcHash && s.srcChars));
  const drops = result.decisions.segments.filter(row => row[13] === 'drop');
  assert.equal(drops.length, 3);
  for (const row of drops) {
    assert.equal(row[7], 0); assert.deepEqual(row.slice(8, 11), [null, null, null]);
    assert.equal(row[11], 'budget_drop'); assert.equal(row[12], 5);
  }
});

test('strict floor boundary includes normalized goal, suffix and chars/4 rounding', async () => {
  const goal = '  Preserve\n identifiers  '; const suffixChars = 7;
  const seed = await compactSpan(input({ span: [user('PIN')], goal, budgetTokens: 100000 }), options, forbidden);
  const floor = summaryOverheadChars(goal) + suffixChars
    + seed.carry.segments.reduce((n, s) => n + renderSegment(s, 'keep', options).length + 2, 0);
  const source = input({ span: [user('PIN'), say('optional')], goal, suffixChars });
  await assert.rejects(compactSpan({ ...source, budgetTokens: tokensForChars(floor) }, options, forbidden), /must not score/);
  const result = await compactSpan({ ...source, budgetTokens: tokensForChars(floor) - 1 }, options, forbidden);
  assert.equal(result.stats.step, 6); assert.deepEqual(result.carry, seed.carry);
  assert.equal(result.summary, seed.summary);
});

test('expiry, disabled classes and duplicate/cap demotions precede the shortcut', async () => {
  const source = input({
    previous: { version: 1, generation: 5, segments: [
      { kind: 'user', text: 'expired', pin: 'user', gen: 1 },
      { kind: 'assistant', text: 'disabled', pin: 'modify', gen: 5 },
    ] },
    span: [...call('i1', 'read', { path: '/work/AGENTS.md' }, 'old instruction'),
      ...call('i2', 'read', { path: '/work/AGENTS.md' }, 'latest instruction'),
      ...call('i3', 'read', { path: '/work/SKILL.md' }, 'newest oversized instruction'.repeat(20)),
      ...call('d1', 'ask_user_question', { questions: [] }, 'older decision'),
      ...call('d2', 'ask_user_question', { questions: [] }, 'newest oversized decision'.repeat(20))],
    cwd: '/work', instructionRefs: ['/work/AGENTS.md'],
  });
  const opt = { ...options, pins: new Set(['user', 'instruction', 'decision'] as const),
    instructionPinMaxChars: 1, decisionPinMaxChars: 1 };
  const result = await compactSpan(source, opt, forbidden);
  assert.equal(result.stats.demoted, 2); assert.equal(result.stats.demotedDuplicate, 1);
  assert.equal(result.stats.demotedCap, 2); assert.equal(result.stats.jevRequests, 0);
  assert.deepEqual(result.carry.segments.map(s => s.call?.tool), ['read', 'ask_user_question']);
  assert.deepEqual(result.carry.segments.map(s => s.pin), ['instruction', 'decision']);
  assert.ok(result.summary.includes('newest oversized instruction')); assert.ok(result.summary.includes('newest oversized decision'));
  assert.ok(!result.summary.includes('expired')); assert.ok(!result.summary.includes('disabled'));
});

test('foreign carry and wrapper alone can exceed budget; normal paths still require scores', async () => {
  const result = await compactSpan(input({ previous: 'opaque foreign source', span: [say('fresh optional')] }),
    { ...options, pins: new Set() }, forbidden);
  assert.equal(result.stats.step, 6); assert.equal(result.stats.unasked, 2);
  assert.deepEqual(result.carry.segments, []); assert.equal(result.stats.jevRequests, 0);
  await assert.rejects(compactSpan(input({ span: [say('needed scoring')], budgetTokens: 100000 }), options, forbidden), /must not score/);
  const fake = new FakeAsker(allOnes);
  await compactSpan(input({ span: [say('needed scoring')], budgetTokens: 100000 }), options, fake);
  assert.ok(fake.questionCount > 0);
});
