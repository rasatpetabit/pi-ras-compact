import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  CHARTER_PREAMBLE,
  captureCharter,
  charterChars,
  shownInCharter,
  detectPasted,
  readCharterState,
  renderCharter,
  verifyEntry,
  withMarkers,
  type BranchMessage,
  type CharterOptions,
} from '../src/core/charter.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12);
const options: CharterOptions = { decisionTools: new Set(['ask_user_question']), hash, pasteMinLines: 12, toolOutputMinChars: 600 };
const user = (entryId: string, text: string): BranchMessage => ({ entryId, role: 'user', text, toolCalls: [] });
const assistant = (entryId: string, text: string, toolCalls: BranchMessage['toolCalls'] = []): BranchMessage => ({ entryId, role: 'assistant', text, toolCalls });
const result = (entryId: string, toolCallId: string, text: string, isError = false): BranchMessage => ({ entryId, role: 'toolResult', text, toolCalls: [], toolCallId, isError });
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

test('every operator message is captured verbatim, in order, however short', () => {
  const msgs = [user('e1', 'Look at the techniques in cachelane.'), assistant('e2', 'ok'), user('e3', 'go'), user('e4', '  next  ')];
  const entries = captureCharter(msgs, options);
  assert.deepEqual(entries.map(e => [e.id, e.text]), [['u:e1', 'Look at the techniques in cachelane.'], ['u:e3', 'go'], ['u:e4', '  next  ']]);
  for (const [i, e] of entries.entries()) assert.ok(verifyEntry(e, [msgs[0]!, msgs[2]!, msgs[3]!][i]!.text, hash));
});

test('long prose the operator wrote is never stubbed', () => {
  const prose = lines(60, i => `Point ${i}: the agent must keep every directive, and here is why that matters for line ${i}.`);
  const [e] = captureCharter([user('p', prose)], options);
  assert.equal(e!.pasted.length, 0);
  assert.equal(e!.text, prose);
});

test('a fenced block the operator may have written stays verbatim, however long', () => {
  const block = '```\n' + lines(20, i => `const x${i} = ${i};`) + '\n```';
  const text = `Use this exact code:\n${block}\nand never touch gpu-node-3.`;
  const [e] = captureCharter([user('f', text)], options);
  assert.equal(e!.pasted.length, 0);
  assert.equal(e!.text, text);
});

test('a fenced log is stubbed by the log rule; the instruction around it stays', () => {
  const log = lines(15, i => `2026-09-29T10:${String(i).padStart(2, '0')}:00Z ERROR worker ${i} failed`);
  const text = 'Why?\n```\n' + log + '\n```\nDo not restart TP4A.';
  const [e] = captureCharter([user('g', text)], options);
  assert.equal(e!.pasted.length, 1);
  assert.equal(e!.pasted[0]!.why, 'log');
  assert.equal(text.slice(e!.pasted[0]!.start, e!.pasted[0]!.end), log);
  assert.ok(e!.text.endsWith('\n```\nDo not restart TP4A.'));
  assert.ok(verifyEntry(e!, text, hash));
});

test('a short fenced block stays verbatim', () => {
  const text = 'Run this:\n```\nnpm test\n```\nthen tell me.';
  assert.equal(detectPasted(text, options).length, 0);
});

test('an unclosed fence is left as written', () => {
  const text = 'look:\n```\n' + lines(30, i => `line ${i}`);
  assert.equal(detectPasted(text, options).length, 0);
});

test('a log run is stubbed; prose before and after is kept', () => {
  const log = lines(15, i => `2026-09-29T10:${String(i).padStart(2, '0')}:00Z ERROR worker ${i} failed`);
  const text = `Why does this keep happening?\n${log}\nDo not restart TP4A.`;
  const ranges = detectPasted(text, options);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.why, 'log');
  assert.equal(text.slice(ranges[0]!.start, ranges[0]!.end), log);
});

test('a log run shorter than the minimum stays', () => {
  const log = lines(5, i => `2026-09-29T10:0${i}:00Z ERROR x`);
  assert.equal(detectPasted(`see\n${log}\nok`, options).length, 0);
});

test('a JSON document stays unless it reproduces a tool result', () => {
  const doc = JSON.stringify({ a: Array.from({ length: 30 }, (_, i) => ({ i })) }, null, 2);
  assert.equal(detectPasted(doc, options).length, 0);
  const ranges = detectPasted(`here:\n${doc}`, options, [doc]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.why, 'tool_output');
});

test('an expanded skill body is stubbed at any length', () => {
  const text = 'please\n<skill name="x" location="/s/x">\nbody line\n</skill>\nthanks';
  const ranges = detectPasted(text, options);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.why, 'skill');
  assert.equal(text.slice(ranges[0]!.start, ranges[0]!.end), '<skill name="x" location="/s/x">\nbody line\n</skill>');
});

test('a pasted-back tool result is stubbed', () => {
  const out = lines(40, i => `row ${i} value ${i * 7}`);
  const msgs = [assistant('a', '', [{ id: 't1', name: 'bash', args: { command: 'x' } }]), result('r', 't1', out), user('u', `this output is wrong:\n${out}\nexplain`)];
  const e = captureCharter(msgs, options).find(x => x.id === 'u:u')!;
  assert.equal(e.pasted.length, 1);
  assert.equal(e.pasted[0]!.why, 'tool_output');
  assert.ok(verifyEntry(e, msgs[2]!.text, hash));
});

test('answered questions carry the question and the verbatim answer', () => {
  const msgs = [
    assistant('a', '', [{ id: 'q1', name: 'ask_user_question', args: { questions: [{ question: 'Which host?', options: [] }] } }]),
    result('r', 'q1', 'User answered: "Which host?"="local vm only"'),
  ];
  const [e] = captureCharter(msgs, options);
  assert.equal(e!.id, 'a:q1');
  assert.equal(e!.text, 'Q: Which host?\nA: User answered: "Which host?"="local vm only"');
  assert.ok(verifyEntry(e!, msgs[1]!.text, hash));
});

test('an errored or unanswered question is not an answer', () => {
  const msgs = [
    assistant('a', '', [{ id: 'q1', name: 'ask_user_question', args: { question: 'x?' } }, { id: 'q2', name: 'ask_user_question', args: { question: 'y?' } }]),
    result('r', 'q1', 'rejected', true),
  ];
  assert.equal(captureCharter(msgs, options).length, 0);
});

test('verification fails on any altered character', () => {
  const [e] = captureCharter([user('e', 'never push')], options);
  assert.equal(verifyEntry(e!, 'never push!', hash), false);
  assert.equal(verifyEntry({ ...e!, text: 'always push' }, 'never push', hash), false);
});

test('withMarkers with no ranges is the identity', () => {
  assert.equal(withMarkers('e', 'abc', []), 'abc');
});

test('a bad carry retires nothing', () => {
  for (const raw of [undefined, null, 3, 'x', { version: 2, retired: { 'u:e': { reason: 'done', gen: 1 } } }, { version: 1, retired: [] }]) {
    assert.deepEqual(readCharterState(raw).retired, {});
  }
  const s = readCharterState({ version: 1, retired: { 'u:a': { reason: 'done', by: null, gen: 2 }, 'u:b': { reason: 'bogus', gen: 1 }, __proto__: { reason: 'done', gen: 1 } } });
  assert.deepEqual(Object.keys(s.retired), ['u:a']);
});

test('render shows live entries in order and counts omitted (dropped/done/superseded) ones', () => {
  const entries = captureCharter([user('e1', 'first'), user('e2', 'second'), user('e3', 'third')], options);
  const text = renderCharter(entries, { version: 1, retired: { 'u:e2': { reason: 'done', by: null, gen: 2 } } });
  assert.ok(text.indexOf('first') < text.indexOf('third'));
  assert.ok(!text.includes('second'));
  assert.ok(text.includes('1 earlier entry was retired'));
  assert.equal(charterChars(entries, readCharterState(undefined)), renderCharter(entries, readCharterState(undefined)).length + 1);
  assert.equal(renderCharter([], readCharterState(undefined)), '');
});

test('an entry retired as corrected renders verbatim with its id, in order, unlabelled', () => {
  const log = lines(14, i => `2026-09-29T10:${String(i).padStart(2, '0')}:00Z ERROR worker ${i} crashed`);
  const msgs = [user('e1', `Proof the rye dough for 45 minutes.\n${log}\nthanks`), user('e2', 'Make it 60 minutes instead.')];
  const entries = captureCharter(msgs, options);
  assert.equal(entries[0]!.pasted.length, 1, 'fixture has a paste marker');
  const live = renderCharter(entries, readCharterState(undefined));
  const corrected = renderCharter(entries, readCharterState({ version: 1, retired: { 'u:e1': { reason: 'corrected', by: 'u:e2', gen: 1 } } }));
  // Byte-identical to the unretired render: id tag, paste marker, order, no notice, no label.
  assert.equal(corrected, live);
  assert.ok(corrected.includes(`[operator u:e1]\n${entries[0]!.text}\n`));
  assert.ok(corrected.includes('jev_expand("u:e1", offset='), 'paste marker kept');
  assert.ok(corrected.indexOf('[operator u:e1]') < corrected.indexOf('[operator u:e2]'));
  assert.ok(!/retired|superseded|obsolete|corrected/i.test(corrected.replace(CHARTER_PREAMBLE, '')), 'no retirement label or notice');
  assert.equal(charterChars(entries, readCharterState({ version: 1, retired: { 'u:e1': { reason: 'corrected', by: 'u:e2', gen: 1 } } })), live.length + 1);
});

test('dropped, done and superseded stay omitted; the count line counts only omitted entries', () => {
  const entries = captureCharter(['a', 'b', 'c', 'd', 'e'].map((x, i) => user(`e${i}`, `entry ${x}`)), options);
  const state = readCharterState({ version: 1, retired: {
    'u:e0': { reason: 'corrected', by: 'u:e4', gen: 1 },
    'u:e1': { reason: 'dropped', by: null, gen: 1 },
    'u:e2': { reason: 'done', by: null, gen: 1 },
    'u:e3': { reason: 'superseded', by: 'u:e4', gen: 1 },
  } });
  const text = renderCharter(entries, state);
  assert.ok(text.includes('[operator u:e0]\nentry a\n'));
  for (const x of ['b', 'c', 'd']) assert.ok(!text.includes(`\nentry ${x}\n`), x);
  assert.ok(text.includes('(3 earlier entries were retired as dropped, finished or superseded; jev_expand restores any of them by id.)'));
  const onlyCorrected = renderCharter(entries, readCharterState({ version: 1, retired: { 'u:e0': { reason: 'corrected', by: 'u:e4', gen: 1 }, 'u:e1': { reason: 'corrected', by: 'u:e4', gen: 1 } } }));
  assert.ok(!onlyCorrected.includes('earlier entr'), 'no count line when nothing is omitted');
  assert.equal(onlyCorrected, renderCharter(entries, readCharterState(undefined)));
  assert.equal(shownInCharter('u:e0', state), true);
  assert.equal(shownInCharter('u:e1', state), false);
  assert.equal(shownInCharter('u:e4', state), true);
});
