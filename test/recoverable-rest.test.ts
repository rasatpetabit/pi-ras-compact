import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { coreOptions } from '../src/client/config.js';
import { expand } from '../src/core/expand.js';
import { compactSpan } from '../src/core/prune.js';
import { renderSegment, stubCounts } from '../src/core/render.js';
import { branchMessages } from '../src/pi/branch.js';
import { entryMarker, markerLines } from '../src/pi/marker.js';
import { testConfig } from './support/config.js';
import { allOnes, FakeAsker } from './support/fake-asker.js';
import { call, say } from './support/span.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const options = { ...coreOptions(testConfig()), maxArgCharsPinned: 8000, stubWrites: false };
const originalResult = '    original read result\n' + 'R'.repeat(10000) + '\nEND';
const originalInput = { path: 'out.txt', content: 'W'.repeat(10000) + '\nEND' };
const entries = [
  { type: 'message', id: 'a-read', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'large.txt' } }] } },
  { type: 'message', id: 'r-read', message: { role: 'toolResult', toolCallId: 'r', isError: true, content: [{ type: 'text', text: originalResult }] } },
  { type: 'message', id: 'a-write', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'w', name: 'write', arguments: originalInput }] } },
  { type: 'message', id: 'r-write', message: { role: 'toolResult', toolCallId: 'w', content: [{ type: 'text', text: 'ok' }] } },
];
const input = {
  previous: undefined, goal: '', budgetTokens: 1, suffixChars: 0, demotedUnknown: 0,
  span: [...call('r', 'read', { path: 'large.txt' }, originalResult, true), ...call('w', 'write', originalInput, 'ok'), say('unpinned analysis')],
};

// Removing caps from the finish(6) accounting, hiding them in the collapsed box, or
// linking the cut arguments as a result should break this reproduction of the live bug.
test('step 6 reports caps despite zero pruning cuts and its links restore original session bytes', async () => {
  const asker = new FakeAsker(allOnes);
  const outcome = await compactSpan(input, options, asker);
  assert.equal(outcome.stats.step, 6);
  assert.equal(outcome.stats.truncated, 0);
  assert.equal(outcome.stats.dropped, 1);
  assert.equal(outcome.stats.jevRequests, 0, 'emergency path does not call the judge');
  assert.equal(outcome.stats.capped, 2);
  assert.equal(outcome.stats.stubbed, 2);
  assert.equal(outcome.stats.unlinked, 0);
  assert.doesNotMatch(outcome.summary, /\[jev-compaction: \d+ more chars not kept\]/);
  assert.doesNotMatch(outcome.summary, /unpinned analysis/);
  const saved = JSON.parse(JSON.stringify({ type: 'compaction', id: 'compact', summary: outcome.summary, details: { jev: { stats: outcome.stats, carry: outcome.carry } } }));
  const messages = branchMessages([...entries, saved]);
  const links = [...outcome.summary.matchAll(/jev_expand\("([^"]+)"(?:, part="(input)")?\)/g)];
  assert.ok(links.length >= 2);
  for (const [, id, part] of links) {
    const restored = expand(messages, { id: id!, part: part as 'input' | undefined, limit: 100000 }, hash);
    assert.ok(restored.ok);
    assert.equal(restored.text, part === 'input' ? originalInput.content : originalResult);
    assert.match(restored.header, /Historical snapshot/);
  }
  const data = entryMarker(saved);
  const collapsed = markerLines(data, false, 120).join('\n');
  assert.match(collapsed, /2 capped/);
  assert.match(collapsed, /jev_expand/);
  assert.doesNotMatch(collapsed, /0 cut\b/, 'new records distinguish pruning cuts from actual caps');
  for (const width of [40, 60, 80]) {
    const lines = markerLines(data, false, width);
    assert.match(lines.join('\n'), /2 capped/, `cap information must survive at width ${width}`);
    assert.ok(lines.every(line => line.length <= width), `no overflow at width ${width}`);
  }
});

test('old idless carries link by source hash and expand through a branch containing a compaction', async () => {
  const first = await compactSpan(input, options, new FakeAsker(allOnes));
  const carry = JSON.parse(JSON.stringify(first.carry));
  for (const segment of carry.segments) delete segment.call.id;
  const second = await compactSpan({ ...input, span: [], previous: carry }, options, new FakeAsker(allOnes));
  const messages = branchMessages([...entries, { type: 'compaction', id: 'compact', summary: second.summary }]);
  assert.equal(second.stats.unlinked, 0);
  const links = [...second.summary.matchAll(/jev_expand\("(h:[0-9a-f]{12})"(?:, part="(input)")?\)/g)];
  assert.ok(links.length >= 2);
  for (const [, id, part] of links) {
    const restored = expand(messages, { id: id!, part: part as 'input' | undefined, limit: 100000 }, hash);
    assert.ok(restored.ok);
    assert.equal(restored.text, part === 'input' ? originalInput.content : originalResult);
  }
});

test('an idless compact argument elision is explicitly counted as unlinked', () => {
  const rendered = renderSegment({ kind: 'call', text: '', pin: null, gen: 1, call: {
    tool: 'read', input: { path: 'p'.repeat(1000) }, result: 'ok', isError: false, resultTruncated: false,
  } }, 'keep', { maxArgChars: 160, maxArgCharsPinned: 8000, modifyTools: new Set(), truncateHeadChars: 300 });
  assert.match(rendered, /args cut; no restore id/);
  assert.equal(stubCounts(rendered).unlinked, 1);
});

test('write body stubs link a visible legacy cap without claiming an invalid hash resolves', () => {
  const segment = { kind: 'call' as const, text: '', pin: 'modify' as const, gen: 1, srcHash: 'invalid', call: {
    id: 'w', tool: 'write', input: { path: 'out.txt', content: 'W'.repeat(8000) + '\n[jev-compaction: 2000 more chars not kept]' },
    result: 'ok', isError: false, resultTruncated: false,
  } };
  const rendering = { maxArgChars: 160, maxArgCharsPinned: 8000, modifyTools: new Set(['write']), truncateHeadChars: 300, stubWrites: true };
  const linked = renderSegment(segment, 'keep', rendering);
  assert.equal(stubCounts(linked).unlinked, 0);
  assert.doesNotMatch(linked, /\[jev-compaction: \d+ more chars not kept\]/);
  const idless = renderSegment({ ...segment, call: { ...segment.call, id: undefined } }, 'keep', rendering);
  assert.doesNotMatch(idless, /jev_expand\("h:invalid/);
  assert.equal(stubCounts(idless).unlinked, 1);
});
