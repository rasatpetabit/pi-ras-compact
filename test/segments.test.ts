import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foreignSegments, PENDING_RESULT, spanToSegments, validateCarry, type SegmentOptions } from '../src/core/segments.js';
import { big, call, context, say, user } from './support/span.js';

const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

const options = (patch: Partial<SegmentOptions> = {}): SegmentOptions => ({
  pins: new Set(['user', 'error', 'modify', 'boundary', 'decision'] as const),
  modifyTools: new Set(['edit', 'write']),
  decisionTools: new Set(['ask_user_question']),
  maxStoredChars: 100,
  gen: 1,
  hash: sha12,
  ...patch,
});

test('pins follow the configured classes; extension context and assistant text are never pinned', () => {
  const span = [
    user('fix the test'),
    context('memory recall block'),
    say('looking'),
    ...call('a', 'read', { path: 'x.ts' }, 'contents'),
    ...call('b', 'bash', { command: 'npm test' }, 'FAIL', true),
    ...call('c', 'edit', { path: 'x.ts', edits: [{ oldText: 'a', newText: 'b' }] }, 'ok'),
    ...call('d', 'grep', { pattern: 'x' }, 'hits'),
  ];
  const segments = spanToSegments(span, options({ boundaryToolUseId: 'd' }));
  assert.deepEqual(
    segments.map(s => [s.kind, s.call?.tool ?? '', s.pin]),
    [
      ['user', '', 'user'],
      ['context', '', null],
      ['assistant', '', null],
      ['call', 'read', null],
      ['call', 'bash', 'error'],
      ['call', 'edit', 'modify'],
      ['call', 'grep', 'boundary'],
    ],
  );
  const noUserPins = spanToSegments(span, options({ pins: new Set(['error'] as const) }));
  assert.deepEqual(noUserPins.filter(s => s.pin !== null).map(s => s.pin), ['error']);
  // A failed edit at the boundary matches all three call classes: modify wins, then error, then boundary.
  const [failedEdit] = spanToSegments(call('z', 'edit', { path: 'q.ts' }, 'no match', true), options({ boundaryToolUseId: 'z' }));
  assert.equal(failedEdit!.pin, 'modify');
  const [failedRead] = spanToSegments(call('z', 'read', { path: 'q.ts' }, 'ENOENT', true), options({ boundaryToolUseId: 'z' }));
  assert.equal(failedRead!.pin, 'error');
  // A questionnaire call is a decision, and an errored one stays a decision rather than falling back to error.
  const [answered] = spanToSegments(call('q', 'ask_user_question', { questions: [{ id: 'a' }] }, 'chosen: a'), options());
  assert.equal(answered!.pin, 'decision');
  const [errored] = spanToSegments(
    call('q', 'ask_user_question', { questions: [{ id: 'a' }] }, 'timed out', true),
    options({ boundaryToolUseId: 'q' }),
  );
  assert.equal(errored!.pin, 'decision');
  // With decision switched off, a successful questionnaire call is unpinned and an errored one falls back to error.
  const without = options({ pins: new Set(['user', 'error', 'modify', 'boundary'] as const) });
  const [plain] = spanToSegments(call('q', 'ask_user_question', { questions: [] }, 'chosen: a'), without);
  assert.equal(plain!.pin, null);
  const [failedQuestion] = spanToSegments(call('q', 'ask_user_question', { questions: [] }, 'timed out', true), without);
  assert.equal(failedQuestion!.pin, 'error');
});

test('stored inputs and pinned results are cut; unpinned results stay whole', () => {
  const long = big('file', 50);
  const span = [
    ...call('w', 'write', { path: 'a.ts', content: long, nested: [{ text: long }] }, long),
    ...call('r', 'read', { path: long }, long),
  ];
  const [write, read] = spanToSegments(span, options());
  assert.ok((write!.call!.input.content as string).length < 200);
  assert.match(write!.call!.input.content as string, /more chars not kept\]$/);
  assert.ok(((write!.call!.input.nested as Array<{ text: string }>)[0]!.text).length < 200);
  assert.ok(write!.call!.result.length < 200, 'pinned result cut');
  assert.ok((read!.call!.input.path as string).length < 200, 'unpinned inputs are cut too');
  assert.equal(read!.call!.result, long, 'unpinned result verbatim');
  // resultTruncated marks the truncate-status head, not the storage cap.
  assert.equal(write!.call!.resultTruncated, false);
  assert.equal(read!.call!.resultTruncated, false);
});

test('a call whose result is not in the span, and a result whose call is not, both stay', () => {
  const span = [
    { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'p', tool: 'bash', input: { command: 'ls' } }] },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'gone', text: 'orphan output' }] },
  ];
  const segments = spanToSegments(span, options());
  assert.equal(segments[0]!.call!.result, PENDING_RESULT);
  assert.equal(segments[1]!.call!.tool, 'unknown');
  assert.equal(segments[1]!.call!.result, 'orphan output');
});

test('a foreign carry loses wrapper tags, summary headers and file lists, and keeps every other paragraph', () => {
  const text = [
    '<summary-of-earlier-context>',
    'Old LLM summary paragraph.',
    '</summary-of-earlier-context>',
    '',
    '<compacted-conversation>',
    'Earlier conversation retained by Jev selective compaction. User and assistant text is verbatim.',
    '',
    '[User]: fix it',
    '',
    '[Assistant tool calls]: read(path=a.ts)',
    '</compacted-conversation>',
    '',
    '<read-files>',
    'a.ts',
    '</read-files>',
  ].join('\n');
  const segments = foreignSegments(text, 4);
  assert.deepEqual(segments.map(s => s.text), ['Old LLM summary paragraph.', '[User]: fix it', '[Assistant tool calls]: read(path=a.ts)']);
  assert.ok(segments.every(s => s.kind === 'foreign' && s.pin === null && s.gen === 4));
});

test('validateCarry accepts a real carry unchanged and rejects every malformed shape', () => {
  const segments = spanToSegments([user('hi'), ...call('a', 'read', { path: 'x' }, 'y')], options());
  const good = JSON.parse(JSON.stringify({ version: 1, generation: 1, segments }));
  const read = validateCarry(good);
  assert.deepEqual(read?.carry, good);
  assert.equal(read?.demotedUnknown, 0);
  // A carry written before the tolerant reader round-trips byte for byte.
  assert.equal(JSON.stringify(read?.carry), JSON.stringify(good));
  const bad: unknown[] = [
    undefined,
    { ...good, version: 2 },
    { ...good, generation: 0 },
    { ...good, segments: 'x' },
    { ...good, segments: [{ ...good.segments[0], kind: 'tool' }] },
    // A pin that is not even a string is not an unknown class: the segment is invalid.
    { ...good, segments: [{ ...good.segments[0], pin: 5 }] },
    { ...good, segments: [{ ...good.segments[0], gen: 2 }] },
    { ...good, segments: [{ ...good.segments[1], call: { ...good.segments[1].call, isError: 'no' } }] },
    { ...good, segments: [{ ...good.segments[0], call: good.segments[1].call }] },
  ];
  for (const value of bad) assert.equal(validateCarry(value), undefined, JSON.stringify(value)?.slice(0, 120));
});

test('an unknown pin string is demoted to null and counted; every other pin survives', () => {
  const segments = spanToSegments(
    [user('hi'), ...call('a', 'edit', { path: 'x' }, 'y'), ...call('b', 'bash', { command: 'z' }, 'boom', true)],
    options(),
  );
  const good = JSON.parse(JSON.stringify({ version: 1, generation: 1, segments }));
  assert.deepEqual(good.segments.map((s: { pin: string | null }) => s.pin), ['user', 'modify', 'error']);
  good.segments[1].pin = 'nonsense';
  const read = validateCarry(good);
  assert.equal(read?.demotedUnknown, 1);
  assert.deepEqual(read?.carry.segments.map((s: { pin: string | null }) => s.pin), ['user', null, 'error']);
  assert.deepEqual(read?.carry.segments[1], { ...good.segments[1], pin: null });
});

test('a carry with source hash and length round-trips, and a malformed pair is dropped from that segment only', () => {
  const inputText = 'a'.repeat(250);
  const inputValue = { path: 'x.ts', body: 'b'.repeat(250) };
  const result = 'c'.repeat(250);
  const segments = spanToSegments(
    [user(inputText), ...call('a', 'read', inputValue, result, true)],
    options({ maxStoredChars: 40, pins: new Set(['error'] as const) }),
  );
  const [text, stored] = segments;
  assert.equal(text!.srcHash, sha12(inputText));
  assert.equal(text!.srcChars, inputText.length);
  assert.equal(stored!.srcHash, sha12(JSON.stringify(['read', inputValue, result])));
  assert.equal(stored!.srcChars, JSON.stringify(['read', inputValue, result]).length);
  // The stored body is the cut one; the hash is of the message before that cut.
  assert.ok(JSON.stringify(stored!.call!.input).length < JSON.stringify(inputValue).length);
  assert.notEqual(stored!.call!.result, result);

  const good = JSON.parse(JSON.stringify({ version: 1, generation: 1, segments }));
  const read = validateCarry(good);
  assert.deepEqual(read?.carry, good);
  assert.equal(JSON.stringify(read?.carry), JSON.stringify(good));

  const malformed = JSON.parse(JSON.stringify(good));
  malformed.segments[0].srcHash = 'not-hex';
  malformed.segments[0].srcChars = 1.5;
  malformed.segments[1].srcHash = 'abc';
  delete malformed.segments[1].srcChars;
  const dropped = validateCarry(malformed);
  assert.equal(dropped?.demotedUnknown, 0);
  assert.equal('srcHash' in (dropped?.carry.segments[0] ?? {}), false);
  assert.equal('srcChars' in (dropped?.carry.segments[0] ?? {}), false);
  assert.equal('srcHash' in (dropped?.carry.segments[1] ?? {}), false);
  assert.equal(dropped?.carry.segments[1]?.text, '');
  // Absent stays absent: a carry from before this field still round-trips.
  const legacy = JSON.parse(JSON.stringify(good));
  delete legacy.segments[0].srcHash;
  delete legacy.segments[0].srcChars;
  const old = validateCarry(legacy);
  assert.equal(JSON.stringify(old?.carry), JSON.stringify(legacy));

  // A present read path that is not a non-empty string is dropped from that segment only.
  const badPath = JSON.parse(JSON.stringify(good));
  badPath.segments[0].readPath = '';
  badPath.segments[1].readPath = 12;
  const stripped = validateCarry(badPath);
  assert.equal('readPath' in (stripped?.carry.segments[0] ?? {}), false);
  assert.equal('readPath' in (stripped?.carry.segments[1] ?? {}), false);
  assert.equal(stripped?.carry.segments[1]?.call?.tool, 'read');
});

test('a carry past the size sanity bound is rejected as unstructured', () => {
  const big = JSON.parse(JSON.stringify({ version: 1, generation: 1, segments: spanToSegments([user('hi')], options()) }));
  big.segments[0].text = 'x'.repeat(32 * 1024 * 1024 + 1);
  assert.equal(validateCarry(big), undefined);
});
