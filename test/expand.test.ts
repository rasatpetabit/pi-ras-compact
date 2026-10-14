import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BranchMessage } from '../src/core/charter.js';
import { expand } from '../src/core/expand.js';
import { PENDING_RESULT } from '../src/core/segments.js';
import { branchMessages } from '../src/pi/branch.js';

const out = 'x'.repeat(50_000) + 'END';
const msgs: BranchMessage[] = [
  { entryId: 'u1', role: 'user', text: 'never push\n```\nlog\n```', toolCalls: [] },
  { entryId: 'a1', role: 'assistant', text: '', toolCalls: [
    { id: 'call-w', name: 'write', args: { path: '/f.ts', content: 'export const a = 1;\n' } },
    { id: 'call-b', name: 'bash', args: { command: 'big' } },
    { id: 'q1', name: 'ask_user_question', args: { question: 'host?' } },
  ] },
  { entryId: 'r1', role: 'toolResult', text: 'Wrote 20 bytes', toolCalls: [], toolCallId: 'call-w' },
  { entryId: 'r2', role: 'toolResult', text: out, toolCalls: [], toolCallId: 'call-b' },
  { entryId: 'r3', role: 'toolResult', text: 'User answered: ai', toolCalls: [], toolCallId: 'q1' },
];

test('a tool result is returned byte-exact, paged', () => {
  const first = expand(msgs, { id: 'call-b' });
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.total, out.length);
  assert.equal(first.returned, 20_000);
  assert.match(first.header, /Historical snapshot/);
  assert.match(first.header, /offset=20000/);
  let joined = first.text;
  for (let at = 20_000; at < out.length; ) {
    const page = expand(msgs, { id: 'call-b', offset: at });
    assert.ok(page.ok);
    if (!page.ok) return;
    joined += page.text;
    at += page.returned;
  }
  assert.equal(joined, out);
});

test('a write stub expands to the content the agent wrote', () => {
  const r = expand(msgs, { id: 'call-w', part: 'input' });
  assert.ok(r.ok && r.text === 'export const a = 1;\n');
});

test('an operator message and a slice of it', () => {
  const whole = expand(msgs, { id: 'u:u1' });
  assert.ok(whole.ok && whole.text === 'never push\n```\nlog\n```');
  const slice = expand(msgs, { id: 'u:u1', offset: 11, limit: 11 });
  assert.ok(slice.ok && slice.text === '```\nlog\n```');
});

test('an answer by its charter id', () => {
  const r = expand(msgs, { id: 'a:q1' });
  assert.ok(r.ok && r.text === 'User answered: ai');
});

test('unknown ids and empty ids are plain errors', () => {
  assert.equal(expand(msgs, { id: 'nope' }).ok, false);
  assert.equal(expand(msgs, { id: 'u:missing' }).ok, false);
  assert.equal(expand(msgs, { id: '' }).ok, false);
  assert.equal(expand(msgs, { id: 'nope', part: 'input' }).ok, false);
});

test('legacy duplicate calls restore only when their complete snapshots are identical', () => {
  const branch: BranchMessage[] = [
    { entryId: 'a', role: 'assistant', text: '', toolCalls: [
      { id: 'one', name: 'read', args: { path: 'same' } },
      { id: 'two', name: 'read', args: { path: 'same' } },
    ] },
    { entryId: 'r1', role: 'toolResult', text: 'original bytes', toolCallId: 'one', toolCalls: [] },
    { entryId: 'r2', role: 'toolResult', text: 'original bytes', toolCallId: 'two', toolCalls: [] },
  ];
  const hash = () => 'constant';
  const result = expand(branch, { id: 'h:constant' }, hash);
  assert.ok(result.ok && result.text === 'original bytes');
  const input = expand(branch, { id: 'h:constant', part: 'input' }, hash);
  assert.ok(input.ok && input.text === JSON.stringify({ path: 'same' }, null, 2));
  const differentResult = branch.map(m => m.entryId === 'r2' ? { ...m, text: 'different bytes' } : m);
  assert.equal(expand(differentResult, { id: 'h:constant' }, hash).ok, false);
  const differentInput = branch.map(m => m.entryId === 'a' ? { ...m, toolCalls: [m.toolCalls[0]!, { ...m.toolCalls[1]!, args: { path: 'other' } }] } : m);
  assert.equal(expand(differentInput, { id: 'h:constant', part: 'input' }, hash).ok, false);
});

test('legacy empty results use the same placeholder hash as segments', () => {
  const branch: BranchMessage[] = [
    { entryId: 'a', role: 'assistant', text: '', toolCalls: [{ id: 'empty', name: 'read', args: { path: 'p' } }] },
    { entryId: 'r', role: 'toolResult', text: '', toolCallId: 'empty', toolCalls: [] },
  ];
  const hash = (text: string) => text === JSON.stringify(['read', { path: 'p' }, PENDING_RESULT]) ? 'expected' : 'wrong';
  const result = expand(branch, { id: 'h:expected', part: 'input' }, hash);
  assert.ok(result.ok && result.text === JSON.stringify({ path: 'p' }, null, 2));
});

test('native bash execution synthetic ids restore commands and output', () => {
  const branch = branchMessages([{ type: 'message', id: 'shell', message: {
    role: 'bashExecution', timestamp: 1234, command: 'echo historical', output: 'historical\n', exitCode: 0,
  } }]);
  const input = expand(branch, { id: 'bashexec_1234', part: 'input' });
  assert.ok(input.ok && input.text === JSON.stringify({ command: 'echo historical' }, null, 2));
  const result = expand(branch, { id: 'bashexec_1234' });
  assert.ok(result.ok && result.text === 'historical\n');
  assert.equal(branchMessages([{ type: 'message', id: 'excluded', message: { role: 'bashExecution', timestamp: 1, excludeFromContext: true, command: 'private', output: 'private' } }]).length, 0);
});

test('limits are clamped', () => {
  const r = expand(msgs, { id: 'call-b', limit: 10_000_000 });
  assert.ok(r.ok && r.returned === 50_003);
  const s = expand(msgs, { id: 'call-b', offset: -5, limit: 0 });
  assert.ok(s.ok && s.offset === 0 && s.returned === 20_000);
});
