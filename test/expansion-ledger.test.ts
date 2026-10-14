import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { flushTelemetry } from '../src/client/ledger.js';
import { register } from '../src/pi/extension.js';
import { EXPAND_TOOL_NAME } from '../src/pi/expand-tool.js';
import { testConfig } from './support/config.js';
import { piUser, testDeps } from './support/pi-event.js';

const h = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const T0 = '1970-01-01T00:00:00.000Z';
const entry = (id: string, message: unknown) => ({ type: 'message', id, parentId: null, timestamp: T0, message });
const SECRET_PATH = '/srv/private/notes.md';
const RESULT = 'line one of the file\nline two of the file';
const USER = 'Please keep the auth fix narrow.';
const branch = [
  entry('u1', piUser(USER)),
  entry('a1', { role: 'assistant', content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: SECRET_PATH } }], timestamp: 0 }),
  entry('t1', { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: RESULT }], isError: false, timestamp: 0 }),
  { type: 'compaction', id: 'c9', parentId: null, timestamp: T0, summary: 's', firstKeptEntryId: 'x', tokensBefore: 1, details: { jev: { attempt_id: 'att-9' } } },
];

function setup() {
  const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<{ details: { ok: boolean } }> }> = [];
  const config = testConfig(c => { c.compaction.maxAfterShare = 0.5; });
  const fake = { on: () => {}, appendEntry: () => {}, registerEntryRenderer: () => {}, registerTool: (t: never) => void tools.push(t) };
  register(fake as never, testDeps({ config }));
  const tool = tools.find(t => t.name === EXPAND_TOOL_NAME)!;
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 'sess-1' } };
  const rows = async () => {
    await flushTelemetry();
    const path = join(dirname(config.telemetry.path), 'expansions.jsonl');
    try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  };
  return { tool, ctx, rows, config };
}

test('jev_expand appends one content-free expansions.jsonl row that joins decisions.jsonl by segment hash', async () => {
  const { tool, ctx, rows } = setup();
  await tool.execute('x1', { id: 'r1', offset: 5, limit: 10 }, undefined, undefined, ctx);
  await tool.execute('x2', { id: 'u:u1' }, undefined, undefined, ctx);
  await tool.execute('x3', { id: `h:${h(JSON.stringify(['read', { path: SECRET_PATH }, RESULT]))}`, part: 'input' }, undefined, undefined, ctx);
  await tool.execute('x4', { id: 'nope' }, undefined, undefined, ctx);
  const got = await rows();
  assert.equal(got.length, 4);
  const [a, b, c, d] = got;
  assert.deepEqual(
    { ...a, ts: undefined },
    { ts: undefined, source: 'live', session_id: 'sess-1', tool_call_id: 'x1', ok: true, id_kind: 'tool_result', part: 'result', tool: 'read',
      seg_hash: h(JSON.stringify(['read', { path: SECRET_PATH }, RESULT])), chars_returned: 10, total_chars: RESULT.length,
      offset: 5, limit: 10, compaction_entry_id: 'c9', attempt_id: 'att-9' },
  );
  assert.equal(b.id_kind, 'user_entry'); assert.equal(b.seg_hash, h(USER)); assert.equal(b.tool, null);
  assert.equal(c.id_kind, 'hash'); assert.equal(c.part, 'input'); assert.equal(c.seg_hash, a.seg_hash);
  assert.equal(d.ok, false); assert.equal(d.seg_hash, null); assert.equal(d.chars_returned, 0);
  const raw = JSON.stringify(got);
  for (const content of [SECRET_PATH, 'line one', USER, 'nope']) assert.ok(!raw.includes(content), `no content in the ledger: ${content}`);
});

test('a failing expansion ledger never changes what jev_expand returns', async () => {
  const { tool, ctx } = setup();
  const brokenCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => { throw new Error('boom'); } } };
  const result = await tool.execute('x5', { id: 'r1' }, undefined, undefined, brokenCtx);
  assert.equal(result.details.ok, true);
});
