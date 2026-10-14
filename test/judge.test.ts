import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, RESULT_FALSE, RESULT_TRUE, STATE_FRAMING, statusAt, type Verdict } from '../src/core/judge.js';
import { spanToSegments } from '../src/core/segments.js';
import { allOnes, FakeAsker } from './support/fake-asker.js';
import { call, say, user } from './support/span.js';

const segmentsOf = (span: Parameters<typeof spanToSegments>[0]) =>
  spanToSegments(span, {
    pins: new Set(),
    modifyTools: new Set(),
    decisionTools: new Set(),
    maxStoredChars: 8000,
    gen: 1,
    hash: text => createHash('sha256').update(text).digest('hex').slice(0, 12),
  });
const options = { goal: 'ship', maxStateTokens: 25_000, maxRequestTokens: 30_000 };

test('only targets are asked: three questions per call, one per text segment; the state shows every visible segment', async () => {
  const segments = segmentsOf([user('VISIBLE-USER-TEXT'), say('assistant words'), ...call('a', 'read', { path: 'x' }, 'data')]);
  const fake = new FakeAsker(allOnes);
  const { verdicts, usage } = await judge(segments, [0, 1, 2], [1, 2], options, fake, 'span');
  const names = fake.asked.flat().sort();
  assert.equal(names.length, 4);
  assert.ok(names.some(n => /^keep_m\d+$/.test(n)));
  assert.deepEqual(names.filter(n => !n.startsWith('keep_m')).map(n => n.split('_')[0]).sort(), ['call', 'result', 'staleness']);
  assert.ok(JSON.stringify(fake.states[0]).includes('VISIBLE-USER-TEXT'));
  assert.deepEqual([...verdicts.keys()].sort(), [1, 2]);
  assert.equal(usage.requests, 1);
});

test('questions are split into batches that fit maxRequestTokens', async () => {
  const span = Array.from({ length: 40 }, (_, i) => call(`c${i}`, 'read', { path: `f${i}` }, 'x')).flat();
  const segments = segmentsOf(span);
  const all = segments.map((_, i) => i);
  const fake = new FakeAsker(allOnes);
  // About 2,900 state tokens and about 150 per call's questions: the 6,000 question tokens need several requests.
  const { verdicts, usage } = await judge(segments, all, all, { goal: '', maxStateTokens: 4000, maxRequestTokens: 5000 }, fake, 'span');
  assert.ok(usage.requests > 1, `expected several batches, got ${usage.requests}`);
  assert.equal(fake.questionCount, 120);
  assert.equal(verdicts.size, 40);
});

test('a span too large for one Jev state is judged in windows that each fit', async () => {
  // 60 compacted calls need about 1,000 state tokens, 30 about 600, 15 about 400: at 600 the span splits twice.
  const span = Array.from({ length: 60 }, (_, i) => call(`c${i}`, 'read', { path: `f${i}` }, 'x')).flat();
  const segments = segmentsOf(span);
  const all = segments.map((_, i) => i);
  const fake = new FakeAsker(allOnes);
  const { verdicts, usage } = await judge(segments, all, all, { goal: '', maxStateTokens: 600, maxRequestTokens: 30_000 }, fake, 'span');
  assert.equal(verdicts.size, 60, 'every call is judged');
  assert.equal(fake.questionCount, 180);
  assert.ok(usage.requests >= 4, `expected one request per window, got ${usage.requests}`);
  const shown = fake.states.map(state => (state as { history: unknown[] }).history.length);
  assert.ok(shown.every(n => n < 60), 'no state holds the whole span');
});

test('every entry asked about is readable in its state: text is split into windows, never left out', async () => {
  const span = [...Array.from({ length: 30 }, (_, i) => say(`note ${i} ${'z'.repeat(2000)}`)), ...call('a', 'read', { path: 'x' }, 'data')];
  const segments = segmentsOf(span);
  const all = segments.map((_, i) => i);
  const fake = new FakeAsker(allOnes);
  const { verdicts } = await judge(segments, all, all, { goal: 'g', maxStateTokens: 1200, maxRequestTokens: 30_000 }, fake, 'span');
  assert.equal(verdicts.size, segments.length, 'every segment is asked about');
  assert.ok(fake.states.length > 1, 'the candidate was split');
  for (const state of fake.states) {
    for (const entry of (state as { history: Array<{ text: string; tool_calls?: unknown[] }> }).history) {
      assert.ok(!/^\[… \d+ chars omitted …\]$/.test(entry.text), 'no text collapsed');
      assert.ok((entry.tool_calls ?? []).every(c => typeof c === 'object'), 'no call one-lined');
    }
  }
});

test('a segment that cannot be shown readably even alone is not asked about, so it keeps', async () => {
  // At this budget the long text fits only collapsed to an omission note: readable nowhere.
  const segments = segmentsOf([user('go'), say(`long ${'wordy '.repeat(3000)}`)]);
  const fake = new FakeAsker(allOnes);
  const { verdicts, usage } = await judge(segments, [0, 1], [1], { goal: 'g', maxStateTokens: 240, maxRequestTokens: 30_000 }, fake, 'span');
  assert.equal(usage.requests, 0);
  assert.equal(verdicts.size, 0);
  assert.deepEqual(statusAt(verdicts.get(1), 0.9, 0.1), { status: 'keep', guarded: false });
});

test('the questions ask one thing each, preview the output, and the state carries our framing, not "re-run"', async () => {
  const output = `HEAD-OF-OUTPUT ${'m'.repeat(5000)} TAIL-OF-OUTPUT`;
  const segments = segmentsOf([user('go'), ...call('a', 'bash', { command: 'npm test' }, output)]);
  const fake = new FakeAsker(allOnes);
  await judge(segments, [0, 1], [1], options, fake, 'span');
  const asked = Object.assign({}, ...fake.requests.map(r => r.questions)) as Record<string, { instructions: string; criteria?: unknown }>;
  const result = Object.entries(asked).find(([name]) => name.startsWith('result_'))![1];
  const callQ = Object.entries(asked).find(([name]) => name.startsWith('call_'))![1];
  assert.ok(!/re-running|re-run|verbatim/.test(result.instructions + callQ.instructions), 'no irrecoverability clause');
  assert.match(result.instructions, /Start and end of the output: HEAD-OF-OUTPUT m+ … m+ TAIL-OF-OUTPUT$/);
  assert.ok(result.instructions.length < 700, 'the preview is bounded');
  assert.deepEqual(result.criteria, { true: RESULT_TRUE, false: RESULT_FALSE });
  assert.ok(Object.keys(asked).some(name => name.startsWith('staleness_')), "upstream's staleness question is kept");
  const state = fake.states[0] as { context: string };
  assert.equal(state.context, STATE_FRAMING);
  assert.ok(!/re-run/.test(state.context));
});

test('every window gets the same goal and the newest conversation text', async () => {
  const span = [
    user('FIRST-REQUEST'),
    ...Array.from({ length: 40 }, (_, i) => [say(`step ${i} ${'r '.repeat(300)}`), ...call(`c${i}`, 'read', { path: `f${i}` }, 'x')]).flat(),
    user('LATEST-REQUEST'),
    say('NEWEST-ASSISTANT-TEXT'),
  ];
  const segments = segmentsOf(span);
  const all = segments.map((_, i) => i);
  const calls = all.filter(i => segments[i]!.kind === 'call');
  const fake = new FakeAsker(allOnes);
  await judge(segments, all, calls, { goal: '', maxStateTokens: 3000, maxRequestTokens: 30_000 }, fake, 'carry');
  assert.ok(fake.states.length > 1, 'the candidate was split');
  const goals = new Set(fake.states.map(state => (state as { goal: string }).goal));
  assert.equal(goals.size, 1, 'one goal for every window');
  assert.match([...goals][0]!, /LATEST-REQUEST/);
  for (const state of fake.states) assert.ok(JSON.stringify(state).includes('NEWEST-ASSISTANT-TEXT'), 'each window shows the newest text');
});

test('a malformed or out-of-range probability keeps the content', async () => {
  const segments = segmentsOf([say('some text'), ...call('a', 'read', { path: 'x' }, 'data')]);
  const bad = (name: string) =>
    name.startsWith('result_') ? { noul: -0.5 } : name.startsWith('keep_m') ? { noul: 7 } : name.startsWith('staleness_') ? undefined : { noul: 0 };
  const { verdicts } = await judge(segments, [0, 1], [0, 1], options, new FakeAsker(bad), 'span');
  assert.deepEqual(statusAt(verdicts.get(0), 0.5, 0.1), { status: 'keep', guarded: false }, 'text answered 7');
  assert.deepEqual(statusAt(verdicts.get(1), 0.5, 0.1), { status: 'keep', guarded: false }, 'call whose output was answered -0.5');
});

test('statusAt applies upstream three-way rule for calls and one threshold for text', () => {
  const callVerdict = (keepCall: number, keepResult: number, staleness = 4): Verdict => ({
    kind: 'call',
    answers: {
      call_x: { noul: keepCall },
      result_x: { noul: keepResult },
      staleness_x: { score: staleness, confidence: 1, probabilities: {} },
    },
  });
  const v = callVerdict(0.7, 0.55);
  assert.deepEqual(statusAt(v, 0.5, 0.1), { status: 'keep', guarded: false });
  assert.deepEqual(statusAt(v, 0.65, 0.1), { status: 'truncate', guarded: false });
  assert.deepEqual(statusAt(v, 0.8, 0.1), { status: 'drop', guarded: false });
  assert.deepEqual(statusAt({ kind: 'call', answers: {} }, 0.8, 0.1), { status: 'keep', guarded: false }, 'missing answers keep');
  assert.deepEqual(statusAt(undefined, 0.8, 0.1), { status: 'keep', guarded: false }, 'never asked keeps');
  assert.deepEqual(statusAt({ kind: 'text', keep: 0.6 }, 0.5, 0.1), { status: 'keep', guarded: false });
  assert.deepEqual(statusAt({ kind: 'text', keep: 0.6 }, 0.65, 0.1), { status: 'drop', guarded: false });
  assert.deepEqual(statusAt({ kind: 'text', keep: undefined }, 0.8, 0.1), { status: 'keep', guarded: false });
  // Just under the threshold, confidently fresh: upstream's staleness rescue keeps it.
  const rescued = callVerdict(0.2, 0.42, 0);
  assert.deepEqual(statusAt(rescued, 0.5, 0.1), { status: 'keep', guarded: true });
  assert.deepEqual(statusAt(rescued, 0.5, 0.05), { status: 'drop', guarded: false }, 'outside the borderline band');
});
