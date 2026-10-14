import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactCall, mergeFileLists, pinnedCall, renderFileLists, renderSegment, renderSummary,
  SUMMARY_HEADER, stubCounts, summaryOverheadChars, truncatedResult, type RenderOptions,
} from '../src/core/render.js';
import type { Segment } from '../src/core/segments.js';

const render: RenderOptions = { maxArgChars: 160, maxArgCharsPinned: 8000, modifyTools: new Set(['edit']), truncateHeadChars: 300 };
const editCall = (pin: Segment['pin']): Segment => ({
  kind: 'call', text: '', pin, gen: 1,
  call: { tool: 'edit', input: { path: 'a.ts', edits: [{ oldText: 'if (x) {\n  a();\n}', newText: 'if (x) {\n  b();\n}' }] }, result: 'ok', isError: false, resultTruncated: false },
});

test('a pinned modify call keeps its arguments exactly; other calls get the one-line cut', () => {
  const pinned = renderSegment(editCall('modify'), 'keep', render);
  assert.ok(pinned.includes(JSON.stringify([{ oldText: 'if (x) {\n  a();\n}', newText: 'if (x) {\n  b();\n}' }], null, 2)));
  const plain = renderSegment(editCall(null), 'keep', render);
  assert.ok(plain.startsWith('[Assistant tool call]: edit(path=a.ts edits='));
  assert.ok(!plain.includes('\n  a();'));
  assert.equal(compactCall('read', { path: 'x'.repeat(500) }, 160), `read(path=${'x'.repeat(159)}…) [args cut; no restore id]`);
  // 'write\n--- content\n' (18) + 9000 = 9018 chars, cut at 8000.
  assert.match(pinnedCall('write', { content: 'y'.repeat(9000) }, 8000), /\n\[jev-compaction: 1018 more chars not kept\]$/);
});

test('a pinned decision call renders its arguments at max_arg_chars, not as a modify block', () => {
  const decision: Segment = {
    kind: 'call', text: '', pin: 'decision', gen: 1,
    call: { tool: 'ask_user_question', input: { questions: 'q'.repeat(500) }, result: 'chosen: a', isError: false, resultTruncated: false },
  };
  const rendered = renderSegment(decision, 'keep', render);
  assert.ok(rendered.startsWith('[Assistant tool call]: ask_user_question(questions='));
  assert.ok(!rendered.includes('\n--- questions'), 'a decision pin is not a modify block');
  assert.equal(rendered.split('\n')[0], `[Assistant tool call]: ask_user_question(questions=${'q'.repeat(159)}…) [args cut; no restore id]`);
  assert.ok(rendered.endsWith('[Tool result]: chosen: a'));
});

test('a kept output keeps the indentation of its first line', () => {
  const read: Segment = { kind: 'call', text: '', pin: null, gen: 1, call: { tool: 'read', input: { path: 'a.py' }, result: '    return x\n  y = 1\n\n', isError: false, resultTruncated: false } };
  assert.ok(renderSegment(read, 'keep', render).endsWith(']:     return x\n  y = 1'));
});

test('truncate renders a bounded head once; an already truncated result is not cut again', () => {
  const read: Segment = { kind: 'call', text: '', pin: null, gen: 1, call: { tool: 'read', input: { path: 'a' }, result: 'z'.repeat(5000), isError: false, resultTruncated: false } };
  const once = renderSegment(read, 'truncate', render);
  assert.match(once, /\[jev-compaction truncated 4700 chars of this tool result; re-run the tool if needed\]$/);
  const stored = { ...read, call: { ...read.call!, result: truncatedResult('z'.repeat(5000), false, 300), resultTruncated: true } };
  assert.equal(renderSegment(stored, 'truncate', render), renderSegment(stored, 'keep', render));
});

test('the summary is one flat wrapper and its length is the overhead plus each part plus two', () => {
  const parts = ['[User]: a', '[Assistant]: bb', 'foreign paragraph'];
  const summary = renderSummary(parts, 'ship it\n\nnow');
  assert.equal(summary.match(/<compacted-conversation>/g)?.length, 1);
  assert.ok(!summary.includes('<summary-of-earlier-context>'));
  assert.ok(summary.includes('Ongoing goal: ship it\nnow'));
  assert.equal(summary.length, summaryOverheadChars('ship it\n\nnow') + parts.reduce((n, p) => n + p.length + 2, 0));
});

test('file lists keep the newest entries, never list a modified file as read, and count the rest', () => {
  const lists = mergeFileLists({ read: ['a', 'b', 'c'], modified: ['m1'] }, { read: ['a', 'm2'], modified: ['m2', 'm3'] }, 2);
  assert.deepEqual(lists, { readFiles: ['c', 'a'], modifiedFiles: ['m2', 'm3'], omittedRead: 1, omittedModified: 1 });
  assert.equal(
    renderFileLists(lists),
    '\n\n<read-files>\n(1 earlier files not listed)\nc\na\n</read-files>\n\n<modified-files>\n(1 earlier files not listed)\nm2\nm3\n</modified-files>',
  );
  assert.equal(renderFileLists({ readFiles: [], modifiedFiles: [], omittedRead: 0, omittedModified: 0 }), '');
});

const cap = '[jev-compaction: 900 more chars not kept]';
const resultRestore = 'jev_expand("r") restores it exactly';
const inputRestore = 'jev_expand("r", part="input") restores the full arguments';
const cappedRead = (patch: Partial<Segment> = {}): Segment => ({
  kind: 'call', text: '', pin: 'boundary', gen: 1,
  call: { id: 'r', tool: 'read', input: { path: 'a' }, result: `head\n${cap}\n${cap}`, isError: false, resultTruncated: false },
  ...patch,
});

test('a kept pinned result links every stored cap marker by tool-call id', () => {
  const segment = cappedRead({ srcHash: '012345abcdef' });
  const text = renderSegment(segment, 'keep', render);
  assert.equal(text.split(`[jev-compaction: 900 more chars not kept; ${resultRestore}]`).length - 1, 2);
  assert.ok(!text.includes(cap));
  assert.equal(segment.call!.result, `head\n${cap}\n${cap}`, 'rendering does not change the carry');
});

test('stored input cap markers name part=input in pinned and compact calls', () => {
  // A generous compact limit keeps the stored marker visible instead of eliding it.
  for (const pin of ['modify', null] as const) {
    const segment = editCall(pin);
    segment.call = { ...segment.call!, id: 'r', input: { content: `head\n${cap}` } };
    assert.ok(renderSegment(segment, 'keep', { ...render, maxArgChars: 1000 }).includes(
      `[jev-compaction: 900 more chars not kept; ${inputRestore}]`));
  }
});

test('cap restores fall back to a valid source hash, for results and arguments', () => {
  const segment = cappedRead({ srcHash: '012345abcdef' });
  segment.call = { ...segment.call!, id: '', input: { path: cap } };
  const text = renderSegment(segment, 'keep', { ...render, maxArgChars: 1000 });
  assert.ok(text.includes('jev_expand("h:012345abcdef") restores it exactly'));
  assert.ok(text.includes('jev_expand("h:012345abcdef", part="input") restores the full arguments'));
});

test('caps without an id or valid hash stay bare, while adding an id links them', () => {
  for (const srcHash of [undefined, 'not-a-hash', '012345abcdef0']) {
    const segment = cappedRead({ srcHash });
    segment.call = { ...segment.call!, id: undefined };
    assert.ok(renderSegment(segment, 'keep', render).includes(cap));
    segment.call.id = 'r';
    assert.ok(renderSegment(segment, 'keep', render).includes(resultRestore));
  }
});

test('already-linked cap markers remain byte-for-byte unchanged beside newly linked markers', () => {
  const linked = '[jev-compaction: 10 more chars not kept; jev_expand("original") restores it exactly]';
  const segment = cappedRead();
  segment.call!.result = `${linked}\n${cap}`;
  const text = renderSegment(segment, 'keep', render);
  assert.ok(text.endsWith(`${linked}\n[jev-compaction: 900 more chars not kept; ${resultRestore}]`));
});

test('a pinned render-time cut links its marker with the optional input restore', () => {
  assert.match(pinnedCall('write', { content: 'y'.repeat(9000) }, 8000), /\n\[jev-compaction: 1018 more chars not kept\]$/);
  assert.ok(pinnedCall('write', { content: 'y'.repeat(9000) }, 8000, inputRestore).endsWith(
    `[jev-compaction: 1018 more chars not kept; ${inputRestore}]`));
});

test('compact calls append one args-cut note only when an argument is elided', () => {
  assert.equal(compactCall('read', { path: 'abc' }, 3, inputRestore), 'read(path=abc)');
  assert.equal(compactCall('read', {}, 3, inputRestore), 'read');
  assert.equal(compactCall('read', { path: 'abcd', other: 'efgh' }, 3, inputRestore),
    `read(path=ab… other=ef…) [args cut; ${inputRestore}]`);
});

test('the summary header directs exact jev_expand recovery rather than re-running a tool', () => {
  assert.equal(SUMMARY_HEADER, 'Earlier conversation retained verbatim by Jev selective compaction. A cut or stubbed tool result or argument names the jev_expand call that restores it exactly; call it instead of re-running the tool.');
  assert.ok(!SUMMARY_HEADER.includes('re-run a tool'));
});


test('stub counts classify segments, not markers, across every restore format', () => {
  const linked = `[jev-compaction: 900 more chars not kept; ${resultRestore}]`;
  assert.deepEqual(stubCounts(`${linked}\n${linked}`), { capped: 1, stubbed: 1, unlinked: 0 });
  assert.deepEqual(stubCounts(`${cap}\n${linked}`), { capped: 1, stubbed: 1, unlinked: 1 });
  assert.deepEqual(stubCounts(`${cap}\n${cap}`), { capped: 1, stubbed: 0, unlinked: 1 });
  assert.deepEqual(stubCounts(truncatedResult('x'.repeat(1000), false, 300)), { capped: 0, stubbed: 0, unlinked: 1 });
  assert.deepEqual(stubCounts(truncatedResult('x'.repeat(1000), false, 300, 'r')), { capped: 0, stubbed: 1, unlinked: 0 });
  for (const text of [
    '[body stubbed: 10 lines, 900 chars; the file is on disk, and jev_expand("w", part="input") restores exactly what was written. First lines:]',
    '[2 edits stubbed: 900 chars; jev_expand("e", part="input") restores the exact old and new text]',
    `read(path=ab…) [args cut; ${inputRestore}]`,
  ]) assert.deepEqual(stubCounts(text), { capped: 0, stubbed: 1, unlinked: 0 });
  assert.deepEqual(stubCounts('plain output mentioning jev_expand'), { capped: 0, stubbed: 0, unlinked: 0 });
});
