import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modifyStub, renderSegment, type RenderOptions } from '../src/core/render.js';
import type { Segment } from '../src/core/segments.js';

const base: RenderOptions = { maxArgChars: 200, maxArgCharsPinned: 100_000, modifyTools: new Set(['write', 'edit']), truncateHeadChars: 300 };
const body = Array.from({ length: 40 }, (_, i) => `line ${i} of the written file`).join('\n');
const write = (content: string, id?: string): Segment => ({
  kind: 'call', text: '', pin: 'modify', gen: 1, srcHash: 'abcdef012345', srcChars: 10,
  call: { tool: 'write', input: { path: 'src/a.ts', content }, result: 'Wrote file', isError: false, resultTruncated: false, ...(id ? { id } : {}) },
});

test('a pinned write body renders as a stub with its restore id when stubbing is on', () => {
  const out = renderSegment(write(body, 't7'), 'keep', { ...base, stubWrites: true });
  assert.match(out, /write path=src\/a\.ts \[body stubbed: 40 lines, \d+ chars; the file is on disk, and jev_expand\("t7", part="input"\) restores exactly what was written/);
  assert.ok(out.includes('line 0 of the written file') && out.includes('line 4 of the written file'));
  assert.ok(!out.includes('line 10 of the written file'));
});

test('without an id the stub names the source hash; with stubbing off or a short body the write renders in full', () => {
  assert.match(renderSegment(write(body), 'keep', { ...base, stubWrites: true }), /jev_expand\("h:abcdef012345", part="input"\)/);
  assert.ok(renderSegment(write(body, 't7'), 'keep', base).includes('line 39 of the written file'));
  assert.equal(modifyStub(write('short', 't7'), { ...base, stubWrites: true }), undefined);
});

test('an edit above the threshold renders as a stub; below it, in full', () => {
  const edit = (n: number): Segment => ({
    kind: 'call', text: '', pin: 'modify', gen: 1,
    call: { tool: 'edit', input: { path: 'src/b.ts', edits: [{ oldText: 'x'.repeat(n), newText: 'y'.repeat(n) }] }, result: 'Applied', isError: false, resultTruncated: false, id: 'e1' },
  });
  assert.match(renderSegment(edit(2000), 'keep', { ...base, stubEditChars: 1500 }), /edit path=src\/b\.ts \[1 edit stubbed: \d+ chars; jev_expand\("e1", part="input"\) restores the exact old and new text\]/);
  assert.ok(renderSegment(edit(100), 'keep', { ...base, stubEditChars: 1500 }).includes('y'.repeat(100)));
});
