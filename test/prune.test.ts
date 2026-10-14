import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreOptions } from '../src/client/config.js';
import { compactSpan, tokensForChars, type CompactInput, type CoreOptions, type DecisionTuple } from '../src/core/prune.js';
import type { Carry } from '../src/core/segments.js';
import { renderSegment } from '../src/core/render.js';
import { testConfig } from './support/config.js';
import { allOnes, allZero, FakeAsker, textKeep } from './support/fake-asker.js';
import { big, call, say, user } from './support/span.js';

const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);
const RULES = new Set(['pin', 'carried', 'unasked', 'unanswered', 'budget_drop', 'borderline']);
const KINDS = new Set(['user', 'assistant', 'context', 'call', 'foreign']);
const PINS = new Set(['user', 'error', 'modify', 'boundary', 'decision', 'instruction']);
const OUTCOMES = new Set(['keep', 'truncate', 'drop']);
/** A decision string is a rule from the fixed list, a `threshold:<v>` value, a tool name, or a 12-hex hash. */
function assertVocabulary(row: DecisionTuple, tools: ReadonlySet<string>): void {
  for (const value of row) {
    if (typeof value !== 'string') continue;
    const rule = value.startsWith('threshold:') ? 'threshold' : value;
    assert.ok(
      RULES.has(value) ||
        KINDS.has(value) ||
        PINS.has(value) ||
        OUTCOMES.has(value) ||
        tools.has(value) ||
        /^threshold:(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
        /^[0-9a-f]{12}$/.test(value),
      `string outside the vocabulary: ${rule} ${JSON.stringify(value)}`,
    );
  }
}

// Explicit values, so the tests do not move when the eval retunes the committed config.
const options: CoreOptions = {
  ...coreOptions(testConfig()),
  pins: new Set(['user', 'error', 'modify', 'boundary'] as const),
  modifyTools: new Set(['edit', 'write']),
  pinGenerations: 3,
  keepThreshold: 0.5,
  borderline: 0.1,
  truncateHeadChars: 300,
  thresholdSchedule: [0.5, 0.65, 0.8],
};
const HUGE = 10_000_000;
/** What a segment costs in the summary, as the pruner charges it: its rendered text plus a separator. */
const rendered = (segment: Carry['segments'][number]): number =>
  renderSegment(segment, 'keep', {
    maxArgChars: options.maxArgChars,
    maxArgCharsPinned: options.maxArgCharsPinned,
    modifyTools: options.modifyTools,
    truncateHeadChars: options.truncateHeadChars,
  }).length + 2;
const input = (patch: Partial<CompactInput>): CompactInput => ({
  previous: undefined, span: [], goal: 'fix auth', budgetTokens: HUGE, suffixChars: 0, demotedUnknown: 0, ...patch,
});

test('with every answer at zero, pinned user text, errors and edits survive and the rest is dropped', async () => {
  const edits = [{ oldText: 'token.expiresAt', newText: 'token?.expiresAt' }];
  const span = [
    user('Fix the failing auth test.'),
    ...call('r', 'read', { path: 'src/auth/session.ts' }, big('session.ts', 200)),
    ...call('t', 'bash', { command: 'npm test' }, 'FAIL: TypeError at session.ts:88', true),
    ...call('e', 'edit', { path: 'src/auth/session.ts', edits }, 'Applied 1 edit'),
    say('Guarding the undefined token.'),
  ];
  const outcome = await compactSpan(input({ span }), options, new FakeAsker(allZero));
  assert.ok(outcome.ok);
  assert.equal(outcome.stats.step, 2);
  assert.ok(outcome.summary.includes('[User]: Fix the failing auth test.'));
  assert.ok(outcome.summary.includes('FAIL: TypeError at session.ts:88'));
  assert.ok(outcome.summary.includes(JSON.stringify(edits, null, 2)));
  assert.ok(!outcome.summary.includes('session.ts line 5:'));
  assert.ok(!outcome.summary.includes('Guarding the undefined token.'));
  assert.deepEqual(outcome.carry.segments.map(s => s.pin), ['user', 'error', 'modify']);
  assert.equal(outcome.stats.dropped, 2);
  assert.equal(outcome.stats.truncated, 0);
});

test('an ask_user_question result is pinned decision and survives all-zero answers', async () => {
  const withDecision = { ...options, pins: new Set(['user', 'error', 'modify', 'boundary', 'decision'] as const) };
  const span = [
    user('Fix the failing auth test.'),
    ...call('q', 'ask_user_question', { questions: [{ id: 'a' }] }, 'chosen: a'),
    ...call('r', 'read', { path: 'src/auth/session.ts' }, big('session.ts', 200)),
    say('Guarding the undefined token.'),
  ];
  // allZero drops the read and the assistant text at the first judgment, before the budget is
  // tested, so the compaction stops at step 2. The budget holds the two pins and not the read:
  // what steps 3-5 would cut is already gone, and the decision pin is what remains.
  const outcome = await compactSpan(input({ span, budgetTokens: tokensForChars(1000) }), withDecision, new FakeAsker(allZero));
  assert.ok(outcome.ok);
  assert.equal(outcome.stats.step, 2);
  assert.ok(outcome.summary.includes('chosen: a'));
  assert.ok(!outcome.summary.includes('session.ts line 5:'));
  assert.deepEqual(outcome.carry.segments.map(s => s.pin), ['user', 'decision']);
  assert.deepEqual(outcome.stats.pinnedByClass, { user: 1, error: 0, modify: 0, decision: 1, boundary: 0, instruction: 0 });
});

test('a decision pin survives steps 3 to 5 when the budget is smaller than the pins', async () => {
  const withDecision = { ...options, pins: new Set(['user', 'error', 'modify', 'boundary', 'decision'] as const) };
  // A carried unpinned paragraph makes step 3 re-judge it; every answer keeps, so only the budget
  // removes anything: steps 4 and 5 run, and the pins alone still exceed the budget (step 6).
  const previous: Carry = {
    version: 1,
    generation: 1,
    segments: [{ kind: 'assistant', text: `old ${'x'.repeat(2000)}`, pin: null, gen: 1 }],
  };
  const span = [
    user('Fix the failing auth test.'),
    ...call('q', 'ask_user_question', { questions: [{ id: 'a' }] }, 'chosen: a'),
    ...call('r', 'read', { path: 'src/auth/session.ts' }, big('session.ts', 200)),
  ];
  const outcome = await compactSpan(input({ previous, span, budgetTokens: 1 }), withDecision, new FakeAsker(allOnes));
  assert.ok(outcome.ok);
  assert.equal(outcome.stats.step, 6);
  assert.ok(outcome.summary.includes('chosen: a'));
  assert.ok(!outcome.summary.includes('session.ts line 5:'));
  assert.deepEqual(outcome.carry.segments.map(s => s.pin), ['user', 'decision']);
});

test('within budget the carry is kept as it is and costs no Jev questions', async () => {
  const previous: Carry = {
    version: 1,
    generation: 1,
    segments: [
      { kind: 'assistant', text: 'old one', pin: null, gen: 1 },
      { kind: 'foreign', text: 'old two', pin: null, gen: 1 },
    ],
  };
  const fake = new FakeAsker(allOnes);
  const outcome = await compactSpan(input({ previous, span: [user('next'), ...call('a', 'read', { path: 'x' }, 'y')] }), options, fake);
  assert.ok(outcome.ok);
  assert.equal(outcome.stats.step, 2);
  assert.equal(fake.questionCount, 3, 'only the new call is asked about');
  assert.equal(outcome.carry.generation, 2);
  assert.deepEqual(outcome.carry.segments.slice(0, 2).map(s => s.text), ['old one', 'old two']);
});

test('over budget the carry is re-judged, then the schedule drops oldest first without new Jev calls', async () => {
  const para = (n: number): string => `paragraph ${n} ${'x'.repeat(2000)}`;
  const previous: Carry = {
    version: 1,
    generation: 1,
    segments: [1, 2, 3, 4].map(n => ({ kind: 'assistant' as const, text: para(n), pin: null, gen: 1 })),
  };
  const fake = new FakeAsker(textKeep(0.6));
  // Room for the wrapper, the header, the user line and two paragraphs, not three.
  const budgetTokens = tokensForChars(600 + 2 * 2100);
  const outcome = await compactSpan(input({ previous, span: [user('go')], goal: 'go', budgetTokens }), options, fake);
  assert.ok(outcome.ok);
  assert.equal(outcome.stats.step, 4);
  assert.equal(fake.asked.length, 1, 'one request: the carry re-judge; the schedule reuses its answers');
  assert.equal(fake.questionCount, 4);
  assert.deepEqual(outcome.carry.segments.map(s => s.text.slice(0, 11)), ['paragraph 3', 'paragraph 4', 'go']);
  assert.ok(tokensForChars(outcome.summary.length) <= budgetTokens);
});

test('pins expire after pin_generations compactions, also when a compaction stops at step 2', async () => {
  let previous: Carry | undefined;
  const fake = new FakeAsker(allOnes);
  for (let g = 1; g <= 5; g++) {
    const outcome = await compactSpan(input({ previous, span: [user(`request ${g}`)] }), options, fake);
    assert.ok(outcome.ok);
    assert.equal(outcome.stats.step, 2);
    assert.equal(outcome.carry.generation, g);
    assert.equal(outcome.stats.demoted, g === 5 ? 1 : 0, `generation ${g}`);
    previous = outcome.carry;
  }
  // At generation 5, request 1 is 4 generations old (> 3) and demoted; request 2 is 3 old and still pinned.
  assert.deepEqual(previous!.segments.map(s => [s.text, s.pin]), [
    ['request 1', null],
    ['request 2', 'user'],
    ['request 3', 'user'],
    ['request 4', 'user'],
    ['request 5', 'user'],
  ]);
  assert.equal(fake.questionCount, 0, 'within budget, demoted pins are not re-judged');
});

test('a decision pin expires after decisionPinGenerations, and a modify pin from the same generation does not outlive pinGenerations', async () => {
  const withDecision = { ...options, pins: new Set(['user', 'error', 'modify', 'boundary', 'decision'] as const) };
  let previous: Carry | undefined;
  const pinOf = (tool: string): Carry['segments'][number]['pin'] =>
    previous!.segments.find(s => s.call?.tool === tool)!.pin;
  // Generation 1 pins both. pinGenerations is 3, so the edit is still pinned at generation 4
  // and demoted at 5; decisionPinGenerations is 20, so the answer is still pinned at 21 and demoted at 22.
  for (let g = 1; g <= 22; g++) {
    const span =
      g === 1
        ? [
            ...call('e1', 'edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }, 'ok'),
            ...call('q1', 'ask_user_question', { questions: [{ id: 'a' }] }, 'chosen: a'),
          ]
        : [user(`step ${g}`)];
    const outcome = await compactSpan(input({ previous, span }), withDecision, new FakeAsker(allZero));
    assert.ok(outcome.ok);
    assert.equal(outcome.stats.step, 2, `generation ${g} stays within budget`);
    previous = outcome.carry;
    if (g === 4) {
      assert.equal(pinOf('edit'), 'modify');
      assert.equal(pinOf('ask_user_question'), 'decision');
    }
    if (g === 5) {
      assert.equal(pinOf('edit'), null, 'the modify pin expired with pinGenerations');
      assert.equal(pinOf('ask_user_question'), 'decision', 'the decision pin outlives it');
      assert.equal(outcome.stats.demoted, 1, 'only the modify pin expired; the decision pin did not');
    }
    if (g === 21) assert.equal(pinOf('ask_user_question'), 'decision');
    if (g === 22) {
      assert.equal(pinOf('ask_user_question'), null, 'the decision pin expired with decisionPinGenerations');
    }
  }
});

test('pinned content stays bounded over a long session', async () => {
  let previous: Carry | undefined;
  for (let g = 1; g <= 30; g++) {
    const span = [
      user(`step ${g} ${'u'.repeat(500)}`),
      ...call(`e${g}`, 'edit', { path: `f${g}.ts`, edits: [{ oldText: 'a', newText: 'b' }] }, 'ok'),
    ];
    const outcome = await compactSpan(input({ previous, span }), options, new FakeAsker(allZero));
    assert.ok(outcome.ok);
    const pinned = outcome.carry.segments.filter(s => s.pin !== null).length;
    assert.ok(pinned <= (options.pinGenerations + 1) * 2, `generation ${g}: ${pinned} pins`);
    previous = outcome.carry;
  }
});

test('a disabled pin class is demoted on the next compaction', async () => {
  const first = await compactSpan(input({ span: [user('keep me')] }), options, new FakeAsker(allOnes));
  assert.ok(first.ok);
  const narrowed = { ...options, pins: new Set(['error'] as const) };
  const second = await compactSpan(input({ previous: first.carry, span: [] }), narrowed, new FakeAsker(allOnes));
  assert.ok(second.ok);
  assert.equal(second.stats.demoted, 1);
  assert.equal(second.carry.segments[0]!.pin, null);
});

test('when pinned content alone exceeds the budget the pins are still the result', async () => {
  const outcome = await compactSpan(
    input({ span: [user('p'.repeat(8000)), say('unpinned words')], budgetTokens: 500 }),
    options,
    new FakeAsker(allOnes),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stats.step, 6);
  assert.ok(outcome.summary.includes('p'.repeat(8000)), 'the pinned user text survives whole');
  assert.ok(!outcome.summary.includes('unpinned words'), 'everything unpinned was dropped first');
});

test('a foreign carry is kept per paragraph and rendered flat', async () => {
  const wrapper = [
    '<summary-of-earlier-context>', 'Old LLM summary paragraph.', '</summary-of-earlier-context>', '',
    '<compacted-conversation>', 'Earlier conversation retained by Jev selective compaction.', '', '[User]: fix it',
    '</compacted-conversation>', '', '<read-files>', 'a.ts', '</read-files>',
  ].join('\n');
  const outcome = await compactSpan(input({ previous: wrapper, span: [user('next')] }), options, new FakeAsker(allOnes));
  assert.ok(outcome.ok);
  assert.ok(outcome.summary.includes('Old LLM summary paragraph.'));
  assert.ok(outcome.summary.includes('[User]: fix it'));
  assert.equal(outcome.summary.match(/<compacted-conversation>/g)?.length, 1);
  assert.ok(!outcome.summary.includes('<summary-of-earlier-context>'));
  assert.ok(!outcome.summary.includes('<read-files>'));
  assert.deepEqual(outcome.carry.segments.map(s => s.kind), ['foreign', 'foreign', 'user']);
});

test('a fresh compaction counts asked, unasked, unanswered and pinned as a partition of the segments', async () => {
  const edits = [{ oldText: 'token.expiresAt', newText: 'token?.expiresAt' }];
  const span = [
    user('Fix the failing auth test.'),
    ...call('r', 'read', { path: 'src/auth/session.ts' }, big('session.ts', 200)),
    ...call('t', 'bash', { command: 'npm test' }, 'FAIL: TypeError at session.ts:88', true),
    ...call('e', 'edit', { path: 'src/auth/session.ts', edits }, 'Applied 1 edit'),
    say('Guarding the undefined token.'),
  ];
  const outcome = await compactSpan(input({ span }), options, new FakeAsker(allZero));
  assert.ok(outcome.ok);
  const stats = outcome.stats;
  assert.equal(stats.step, 2);
  // The three pins are never put to Jev; the read call and the assistant text are asked and answered.
  assert.deepEqual(
    { asked: stats.asked, unasked: stats.unasked, unanswered: stats.unanswered, pinned: stats.pinned },
    { asked: 2, unasked: 0, unanswered: 0, pinned: 3 },
  );
  assert.equal(stats.asked + stats.unasked + stats.unanswered + stats.pinned, stats.segments);
});

test('the decision size cap demotes the oldest decision pins and always keeps the newest, even over the cap', async () => {
  const decision = (gen: number, id: string, result: string): Carry['segments'][number] => ({
    kind: 'call', text: '', pin: 'decision', gen,
    call: { tool: 'ask_user_question', input: { id }, result, isError: false, resultTruncated: false },
  });
  // Two carried answers of the same rendered cost, oldest first, plus a fresh answer of that cost.
  // The cap holds exactly two, so the oldest is the one past it.
  const older = decision(1, 'old', 'a'.repeat(50));
  const newer = decision(1, 'new', 'b'.repeat(50));
  assert.equal(rendered(older), rendered(newer));
  const withDecision = {
    ...options,
    pins: new Set(['user', 'error', 'modify', 'boundary', 'decision'] as const),
    decisionPinMaxChars: 2 * rendered(older) + 5,
  };
  const previous: Carry = { version: 1, generation: 1, segments: [older, newer] };
  const outcome = await compactSpan(
    input({ previous, span: call('q', 'ask_user_question', { id: 'fre' }, 'c'.repeat(50)) }),
    withDecision,
    new FakeAsker(allZero),
  );
  assert.ok(outcome.ok);
  const kept = outcome.carry.segments.filter(s => s.pin === 'decision');
  // Newest first: the fresh answer and the later carried one fill the cap; the oldest is demoted.
  assert.deepEqual(kept.map(s => s.call!.input.id), ['new', 'fre']);
  assert.equal(outcome.carry.segments[0]!.call!.input.id, 'old');
  assert.equal(outcome.carry.segments[0]!.pin, null);
  assert.equal(outcome.stats.demotedCap, 1);
  assert.equal(outcome.stats.demoted, 0, 'a cap demotion is not an expiry demotion');

  // A single newest pin larger than the cap is kept, and an older one beside it is demoted.
  const huge = decision(1, 'huge', 'h'.repeat(400));
  const alone = await compactSpan(
    input({ previous: { version: 1, generation: 1, segments: [huge] }, span: [] }),
    withDecision,
    new FakeAsker(allZero),
  );
  assert.ok(alone.ok);
  assert.equal(alone.carry.segments[0]!.pin, 'decision');
  assert.equal(alone.stats.demotedCap, 0);
  const beside = await compactSpan(
    input({ previous: { version: 1, generation: 1, segments: [older, huge] }, span: [] }),
    withDecision,
    new FakeAsker(allZero),
  );
  assert.ok(beside.ok);
  assert.deepEqual(beside.carry.segments.map(s => [s.call!.input.id, s.pin]), [['old', null], ['huge', 'decision']]);
  assert.equal(beside.stats.demotedCap, 1);
});

test('the decision size cap keeps the newest generation even when the carry is out of order', async () => {
  const decision = (gen: number, id: string): Carry['segments'][number] => ({
    kind: 'call', text: '', pin: 'decision', gen,
    call: { tool: 'ask_user_question', input: { id }, result: 'r'.repeat(50), isError: false, resultTruncated: false },
  });
  // Generation 2 is stored BEFORE generation 1: position order would call the gen-1 pin newest.
  const newest = decision(2, 'gen2');
  const oldest = decision(1, 'gen1');
  const withDecision = {
    ...options,
    pins: new Set(['user', 'error', 'modify', 'boundary', 'decision'] as const),
    decisionPinMaxChars: rendered(newest) + 5,
  };
  const outcome = await compactSpan(
    input({ previous: { version: 1, generation: 2, segments: [newest, oldest] }, span: [] }),
    withDecision,
    new FakeAsker(allZero),
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.stats.demotedCap, 1);
  const pins = Object.fromEntries(outcome.carry.segments.map(s => [s.call!.input.id, s.pin]));
  assert.equal(pins.gen2, 'decision');
  assert.notEqual(pins.gen1, 'decision');
});

test('a decision pin is charged its rendered cost: long questions with short answers fit, and are stored whole', async () => {
  const question = { questions: [{ id: 'a', question: 'q'.repeat(3000), options: ['x'.repeat(500)] }] };
  const answer = (gen: number, id: string): Carry['segments'][number] => ({
    kind: 'call', text: '', pin: 'decision', gen,
    call: { tool: 'ask_user_question', input: { ...question, id }, result: `chosen: ${id}`, isError: false, resultTruncated: false },
  });
  const first = answer(1, 'one');
  const second = answer(1, 'two');
  const stored = JSON.stringify(first.call!.input).length + first.call!.result.length;
  assert.ok(stored > 3000);
  // The cap holds both rendered answers, but not even one at its stored size.
  const cap = 2 * rendered(first) + 5;
  assert.ok(cap < stored);
  const withDecision = {
    ...options,
    pins: new Set(['user', 'error', 'modify', 'boundary', 'decision'] as const),
    decisionPinMaxChars: cap,
  };
  const outcome = await compactSpan(
    input({ previous: { version: 1, generation: 1, segments: [first, second] }, span: [] }),
    withDecision,
    new FakeAsker(allZero),
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.stats.demotedCap, 0);
  assert.deepEqual(outcome.carry.segments.map(s => s.pin), ['decision', 'decision']);
  // The stored questions are unchanged: only the cap's accounting uses the rendered excerpt.
  assert.deepEqual(outcome.carry.segments[0]!.call!.input, first.call!.input);

  // A longer argument excerpt costs more, so the same cap now holds only the newest.
  const wider = { ...withDecision, maxArgChars: 2000 };
  const outcomeWide = await compactSpan(
    input({ previous: { version: 1, generation: 1, segments: [first, second] }, span: [] }),
    wider,
    new FakeAsker(allZero),
  );
  assert.ok(outcomeWide.ok);
  assert.equal(outcomeWide.stats.demotedCap, 1);
  assert.deepEqual(outcomeWide.carry.segments.map(s => s.pin), [null, 'decision']);
});

test('a re-judged carry counts its segments as asked, and one without a usable answer as unanswered', async () => {
  const para = (n: number): string => `paragraph ${n} ${'x'.repeat(2000)}`;
  const previous: Carry = {
    version: 1,
    generation: 1,
    segments: [1, 2, 3].map(n => ({ kind: 'assistant' as const, text: para(n), pin: null, gen: 1 })),
  };
  // The first paragraph's answer is dropped as missing, so it keeps by default; the other two are dropped.
  const fake = new FakeAsker(name =>
    name === 'keep_m0' ? undefined : name === 'keep_m1' || name === 'keep_m2' ? { noul: 0 } : allOnes(name),
  );
  const budgetTokens = tokensForChars(600 + 2100);
  const outcome = await compactSpan(input({ previous, span: [user('go')], goal: 'go', budgetTokens }), options, fake);
  assert.ok(outcome.ok);
  const stats = outcome.stats;
  assert.equal(stats.step, 3, 'the carry is re-judged and now fits');
  assert.equal(stats.segments, 4);
  assert.deepEqual(
    { asked: stats.asked, unasked: stats.unasked, unanswered: stats.unanswered, pinned: stats.pinned },
    { asked: 2, unasked: 0, unanswered: 1, pinned: 1 },
  );
  assert.equal(stats.asked + stats.unasked + stats.unanswered + stats.pinned, stats.segments);
  assert.deepEqual(outcome.carry.segments.map(s => s.text.slice(0, 11)), ['paragraph 1', 'go']);
});

test('a compaction whose state cannot be shown readably asks nothing and counts every unpinned segment unasked', async () => {
  const span = [
    user('Fix the failing auth test.'),
    ...call('r', 'read', { path: 'src/auth/session.ts' }, 'contents of session'),
    say('Guarding the undefined token.'),
  ];
  // 100 state tokens is below what this candidate needs to be fitted and shown readably
  // (calibrated by trying it: 150 also throws, 200 fits), so judgeWindow asks nothing.
  const fake = new FakeAsker(allOnes);
  const outcome = await compactSpan(input({ span }), { ...options, maxStateTokens: 100 }, fake);
  assert.ok(outcome.ok);
  assert.equal(fake.questionCount, 0, 'no question reached Jev');
  const stats = outcome.stats;
  assert.deepEqual(
    { asked: stats.asked, unasked: stats.unasked, unanswered: stats.unanswered, pinned: stats.pinned },
    { asked: 0, unasked: 2, unanswered: 0, pinned: 1 },
  );
  assert.equal(stats.asked + stats.unasked + stats.unanswered + stats.pinned, stats.segments);
});

test('a carry the re-judge never asks about is unasked', async () => {
  const previous: Carry = {
    version: 1,
    generation: 1,
    segments: [
      { kind: 'assistant', text: 'old one', pin: null, gen: 1 },
      { kind: 'foreign', text: 'old two', pin: null, gen: 1 },
    ],
  };
  const fake = new FakeAsker(allOnes);
  const outcome = await compactSpan(input({ previous, span: [user('next')], budgetTokens: HUGE }), options, fake);
  assert.ok(outcome.ok);
  const stats = outcome.stats;
  assert.equal(stats.step, 2);
  assert.deepEqual(
    { asked: stats.asked, unasked: stats.unasked, unanswered: stats.unanswered, pinned: stats.pinned },
    { asked: 0, unasked: 2, unanswered: 0, pinned: 1 },
  );
  assert.equal(stats.asked + stats.unasked + stats.unanswered + stats.pinned, stats.segments);
});

test('the decision record has one row per input segment and its outcomes match the stats', async () => {
  const edits = [{ oldText: 'token.expiresAt', newText: 'token?.expiresAt' }];
  const span = [
    user('Fix the failing auth test.'),
    ...call('r', 'read', { path: 'src/auth/session.ts' }, big('session.ts', 200)),
    ...call('t', 'bash', { command: 'npm test' }, 'FAIL: TypeError at session.ts:88', true),
    ...call('e', 'edit', { path: 'src/auth/session.ts', edits }, 'Applied 1 edit'),
    say('Guarding the undefined token.'),
  ];
  const outcome = await compactSpan(input({ span }), options, new FakeAsker(allZero));
  assert.ok(outcome.ok);
  const decisions = outcome.decisions!;
  assert.equal(decisions.segments.length, outcome.stats.segments);
  assert.deepEqual(
    decisions.segments.map(row => row[0]),
    decisions.segments.map((_, i) => i),
  );
  const outcomes = { keep: 0, truncate: 0, drop: 0 };
  for (const row of decisions.segments) {
    outcomes[row[13]] += 1;
    assertVocabulary(row, new Set(['read', 'bash', 'edit']));
  }
  assert.deepEqual(outcomes, {
    keep: outcome.stats.kept,
    truncate: outcome.stats.truncated,
    drop: outcome.stats.dropped,
  });
  assert.equal(decisions.generation, outcome.stats.generation);
  assert.equal(decisions.final_step, outcome.stats.step);
  assert.equal(decisions.keep_threshold, options.keepThreshold);
  assert.equal(decisions.threshold_final, null, 'step 2 never runs the schedule');
  assert.equal('decisions' in outcome.carry, false);
  assert.equal(JSON.stringify(outcome.carry).includes('"decisions"'), false);
});

test('a borderline rescue records rule borderline, and an answered keep records the threshold', async () => {
  const rescued = (name: string) => {
    if (name.startsWith('staleness_')) return { score: 0, confidence: 1, probabilities: {} };
    if (name.startsWith('result_')) return { noul: 0.42 };
    if (name.startsWith('call_')) return { noul: 0.2 };
    return { noul: 0 };
  };
  const span = [say('plain text the judge drops'), ...call('r', 'read', { path: 'x.ts' }, 'file body')];
  const outcome = await compactSpan(input({ span }), options, new FakeAsker(rescued));
  assert.ok(outcome.ok);
  const [text, callRow] = outcome.decisions!.segments;
  assert.equal(text![11], 'threshold:0.5');
  assert.equal(text![12], 1);
  assert.equal(text![7], 1);
  assert.equal(text![8], 0);
  assert.equal(text![13], 'drop');
  assert.equal(callRow![11], 'borderline');
  assert.equal(callRow![12], 1);
  assert.equal(callRow![7], 1);
  assert.equal(callRow![8], null);
  assert.equal(callRow![9], 0.2);
  assert.equal(callRow![10], 0.42);
  assert.equal(callRow![13], 'keep');
});

test('an unreadable window records asked -2 and rule unasked', async () => {
  const span = [
    user('Fix the failing auth test.'),
    ...call('r', 'read', { path: 'src/auth/session.ts' }, 'contents of session'),
    say('Guarding the undefined token.'),
  ];
  const outcome = await compactSpan(input({ span }), { ...options, maxStateTokens: 100 }, new FakeAsker(allOnes));
  assert.ok(outcome.ok);
  const fresh = outcome.decisions!.segments.filter(row => row[3] === null);
  assert.ok(fresh.length >= 1);
  for (const row of fresh) {
    assert.equal(row[7], -2);
    assert.equal(row[11], 'unasked');
    assert.equal(row[12], 1);
    assert.equal(row[8], null);
    assert.equal(row[9], null);
    assert.equal(row[10], null);
  }
});

test('an asked segment with no usable answer records unanswered, and a carried segment left alone stays carried', async () => {
  const para = (n: number): string => `paragraph ${n} ${'x'.repeat(2000)}`;
  const previous: Carry = {
    version: 1,
    generation: 1,
    segments: [1, 2, 3].map(n => ({ kind: 'assistant' as const, text: para(n), pin: null, gen: 1 })),
  };
  const fake = new FakeAsker(name =>
    name === 'keep_m0' ? undefined : name === 'keep_m1' || name === 'keep_m2' ? { noul: 0 } : allOnes(name),
  );
  const budgetTokens = tokensForChars(600 + 2100);
  const outcome = await compactSpan(input({ previous, span: [user('go')], goal: 'go', budgetTokens }), options, fake);
  assert.ok(outcome.ok);
  assert.equal(outcome.stats.step, 3);
  const [first, second, third, pinned] = outcome.decisions!.segments;
  assert.equal(first![7], -1);
  assert.equal(first![11], 'unanswered');
  assert.equal(first![12], 3);
  assert.equal(first![13], 'keep');
  assert.equal(second![11], 'threshold:0.5');
  assert.equal(second![12], 3);
  assert.equal(second![13], 'drop');
  assert.equal(third![11], 'threshold:0.5');
  assert.equal(pinned![11], 'pin');
  assert.equal(pinned![7], 0);
  assert.equal(pinned![12], 1);
});

test('step 4 records its threshold only for a segment it changes, and step 5 records budget_drop', async () => {
  const para = (n: number): string => `paragraph ${n} ${'x'.repeat(400)}`;
  const previous: Carry = {
    version: 1,
    generation: 1,
    segments: [1, 2, 3, 4].map(n => ({ kind: 'assistant' as const, text: para(n), pin: null, gen: 1 })),
  };
  // 0.6 survives the configured 0.5 and is dropped by the schedule's 0.65. The whole kept
  // summary is 486 tokens (measured); 400 holds three paragraphs, so the schedule drops only
  // the oldest and then stops.
  const scheduled = await compactSpan(
    input({ previous, span: [user('go')], goal: 'go', budgetTokens: 400 }),
    options,
    new FakeAsker(textKeep(0.6)),
  );
  assert.ok(scheduled.ok);
  assert.equal(scheduled.stats.step, 4);
  assert.equal(scheduled.decisions!.threshold_final, 0.65);
  const rows = scheduled.decisions!.segments;
  assert.equal(rows[0]![11], 'threshold:0.65');
  assert.equal(rows[0]![12], 4);
  assert.equal(rows[0]![13], 'drop');
  for (const row of rows.slice(1, 4)) {
    assert.equal(row[11], 'threshold:0.5', 'a segment the schedule leaves is not rewritten');
    assert.equal(row[12], 3);
    assert.equal(row[13], 'keep');
  }

  // Every answer is above the whole schedule, so step 4 changes nothing and step 5 is what drops.
  const swept = await compactSpan(
    input({ previous, span: [user('go')], goal: 'go', budgetTokens: 1 }),
    options,
    new FakeAsker(textKeep(0.99)),
  );
  assert.ok(swept.ok);
  assert.equal(swept.stats.step, 6);
  assert.equal(swept.decisions!.final_step, 6);
  for (const row of swept.decisions!.segments.filter(row => row[3] === null)) {
    assert.equal(row[11], 'budget_drop');
    assert.equal(row[12], 5);
    assert.equal(row[13], 'drop');
  }
  const pin = swept.decisions!.segments.find(row => row[3] === 'user')!;
  assert.equal(pin[11], 'pin');
  assert.equal(pin[13], 'keep');
});

test('a fresh call hashes the uncut message, and a carried segment uses its stored hash or null', async () => {
  const inputValue = { path: 'big.ts', body: 'b'.repeat(20_000) };
  const result = 'c'.repeat(20_000);
  const span = call('r', 'read', inputValue, result);
  const first = await compactSpan(input({ span }), options, new FakeAsker(allOnes));
  assert.ok(first.ok);
  const [row] = first.decisions!.segments;
  const uncut = JSON.stringify(['read', inputValue, result]);
  assert.equal(row![5], uncut.length);
  assert.equal(row![6], sha12(uncut));
  assert.notEqual(JSON.stringify(first.carry.segments[0]!.call!.input), JSON.stringify(inputValue));
  assert.equal(first.carry.segments[0]!.srcHash, row![6]);
  assert.equal(first.carry.segments[0]!.srcChars, row![5]);

  const again = await compactSpan(
    input({ previous: first.carry, span: [user('next')] }),
    options,
    new FakeAsker(allOnes),
  );
  assert.ok(again.ok);
  assert.equal(again.decisions!.segments[0]![6], sha12(uncut));
  assert.equal(again.decisions!.segments[0]![5], uncut.length);

  const legacy: Carry = {
    version: 1,
    generation: 1,
    segments: [{ kind: 'assistant', text: 'from before the hash', pin: null, gen: 1 }],
  };
  const old = await compactSpan(input({ previous: legacy, span: [user('next')] }), options, new FakeAsker(allOnes));
  assert.ok(old.ok);
  assert.equal(old.decisions!.segments[0]![5], null);
  assert.equal(old.decisions!.segments[0]![6], null);
  assert.equal(old.decisions!.segments[0]![11], 'carried');
  assert.equal(old.decisions!.segments[0]![7], 0);
});

test('a result cut to its head is stored cut, so a later compaction does not cut it again', async () => {
  const keepCallOnly = (name: string) =>
    name.startsWith('result_')
      ? { noul: 0 }
      : name.startsWith('staleness_')
        ? { score: 4, confidence: 1, probabilities: {} }
        : { noul: 1 };
  const outcome = await compactSpan(
    input({ span: call('r', 'read', { path: 'big.ts' }, big('big', 300)) }),
    options,
    new FakeAsker(keepCallOnly),
  );
  assert.ok(outcome.ok);
  const [segment] = outcome.carry.segments;
  assert.equal(segment!.call!.resultTruncated, true);
  assert.equal(segment!.call!.id, 'r');
  assert.match(segment!.call!.result, /\[jev-compaction truncated \d+ chars of this tool result; jev_expand\("r"\) restores it exactly\]$/);
  assert.ok(outcome.summary.includes(segment!.call!.result.trim()));
});


test('pinned oversized read results and write arguments render recoverable caps and count segments', async () => {
  const span = [
    ...call('r', 'read', { path: 'large.txt' }, 'r'.repeat(10000), true),
    ...call('w', 'write', { path: 'out.txt', content: 'w'.repeat(10000) }, 'ok'),
  ];
  const outcome = await compactSpan(input({ span }), { ...options, stubWrites: false, maxArgCharsPinned: 8000 }, new FakeAsker(allZero));
  assert.doesNotMatch(outcome.summary, /\[jev-compaction: \d+ more chars not kept\]/);
  assert.match(outcome.summary, /jev_expand\("r"\) restores it exactly/);
  assert.match(outcome.summary, /jev_expand\("w", part="input"\) restores the full arguments/);
  assert.equal(outcome.stats.capped, 2);
  assert.equal(outcome.stats.stubbed, 2);
  assert.equal(outcome.stats.unlinked, 0);
  assert.equal(outcome.stats.truncated, 0, 'caps are distinct from judge truncations');
  assert.ok(outcome.carry.segments.every(s => JSON.stringify(s).includes('more chars not kept]')), 'carry keeps bare caps');
});

test('a carried cap with neither id nor hash is counted as one unlinked segment', async () => {
  const previous: Carry = { version: 1, generation: 1, segments: [{
    kind: 'call', text: '', pin: null, gen: 1,
    call: { tool: 'read', input: { path: 'old.txt' }, result: '[jev-compaction: 100 more chars not kept]\n[jev-compaction: 200 more chars not kept]', isError: false, resultTruncated: false },
  }] };
  const outcome = await compactSpan(input({ previous }), options, new FakeAsker(allZero));
  assert.equal(outcome.stats.capped, 1);
  assert.equal(outcome.stats.stubbed, 0);
  assert.equal(outcome.stats.unlinked, 1);
});
