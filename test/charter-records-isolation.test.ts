import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { flushTelemetry } from '../src/client/ledger.js';
import type { JevConfig } from '../src/client/config.js';
import { CHARTER_HEADER } from '../src/core/charter.js';
import { readCharterRecords, rebuildCharterPrefix } from '../src/core/charter-records.js';
import { handleCompact, type HookResult, type NativeCompaction } from '../src/pi/extension.js';
import { testConfig } from './support/config.js';
import { piCtx, piEvent, piUser, testDeps } from './support/pi-event.js';

const compactionOf = (result: HookResult) => {
  assert.ok(result && 'compaction' in result, `expected a compaction, got ${JSON.stringify(result)}`);
  return result.compaction;
};
const T0 = '1970-01-01T00:00:00.000Z';
const entry = (id: string, message: unknown) => ({ type: 'message', id, parentId: null, timestamp: T0, message });
const RULE = 'Never use node-a, node-b or gpu-node-3 as dev fallbacks; the primary build VM only.';
const ASK = 'Fix the failing auth test in src/auth/session.ts.';
const saysMain = 'User answered: main';
const branch = [
  entry('u0', piUser(RULE)),
  entry('u1', piUser(ASK)),
  entry('q', { role: 'assistant', content: [{ type: 'toolCall', id: 'ask1', name: 'ask_user_question', arguments: { questions: [{ question: 'Which branch?' }] } }], timestamp: 0 }),
  entry('qr', { role: 'toolResult', toolCallId: 'ask1', toolName: 'ask_user_question', content: [{ type: 'text', text: saysMain }], isError: false, timestamp: 0 }),
];
const charterOn = () => testConfig(c => { c.compaction.maxAfterShare = 0.5; c.compaction.charter = true; });
const rowsOf = async (config: JevConfig): Promise<Record<string, unknown>[]> => {
  await flushTelemetry(); // telemetry appends are asynchronous and never awaited on the call path
  const path = join(dirname(config.telemetry.path), 'compactions.jsonl'); // beside calls.jsonl by design
  const raw = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  return raw ? raw.split('\n').map(l => JSON.parse(l) as Record<string, unknown>) : [];
};

/**
 * Two compactions of the same branch: one with the real records writer, one whose writer throws.
 * `saveCharterRecords` is injected through the `Deps` seam (extension.ts), the same shape as the
 * `compact` seam, so no module mocking is needed and the failure is exactly the writer's.
 */
let cached: Promise<{ ok: NativeCompaction; okConfig: JevConfig; failed: NativeCompaction; failedConfig: JevConfig }> | undefined;
const runs = () => cached ??= (async () => {
  const okConfig = charterOn();
  const failedConfig = charterOn();
  const ok = compactionOf(await handleCompact(piEvent({ branchEntries: branch }), piCtx(), testDeps({ config: okConfig })));
  const failed = compactionOf(await handleCompact(piEvent({ branchEntries: branch }), piCtx(), testDeps({
    config: failedConfig,
    saveCharterRecords: () => { throw new Error('records sink unavailable'); },
  })));
  return { ok, okConfig, failed, failedConfig };
})();

test('a records failure costs the records only: the charter, the chain and the stats are untouched', async () => {
  const { ok, okConfig, failed, failedConfig } = await runs();
  // The compaction completes, and the session charter is the same text it would have been.
  assert.equal(failed.summary, ok.summary, 'the throwing writer changes nothing in the summary');
  assert.ok(failed.summary.startsWith(CHARTER_HEADER));
  assert.ok(failed.summary.includes(RULE), 'an operator message from before the compaction point survives');
  assert.ok(failed.summary.includes(ASK));
  assert.ok(failed.summary.includes(saysMain), 'the answer survives');
  assert.equal(failed.firstKeptEntryId, ok.firstKeptEntryId);
  assert.deepEqual(failed.details.jev.charter, ok.details.jev.charter);
  assert.deepEqual(failed.details.jev.charter_stats, ok.details.jev.charter_stats);
  assert.deepEqual(failed.details.jev.chain, ok.details.jev.chain);
  // The only loss is the optional metadata: charter and stats stay, records go.
  assert.ok(failed.details.jev.charter);
  assert.ok(failed.details.jev.charter_stats);
  assert.equal(failed.details.jev.charter_records, undefined);
  // Telemetry names the records failure and never the charter.
  const rows = await rowsOf(failedConfig);
  assert.equal(rows.length, 1, 'the failing compaction still writes its line');
  assert.match(String(rows[0].charter_records_error), /records sink unavailable/);
  assert.equal(rows[0].charter_error, undefined);
  assert.equal(rows[0].charter_chars, (await rowsOf(okConfig))[0]?.charter_chars, 'the charter size is still recorded');
});

test('the writer that works is unchanged: the records validate against the summary it did not alter', async () => {
  const { ok, okConfig, failed } = await runs();
  const records = ok.details.jev.charter_records;
  assert.ok(records, 'records are still saved on the success path');
  assert.ok(readCharterRecords(records, ok.summary), 'and validate against the saved summary');
  assert.equal(rebuildCharterPrefix(records, ok.summary), ok.summary.slice(0, ok.summary.indexOf('<compacted-conversation>')));
  const rows = await rowsOf(okConfig);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].charter_records_error, undefined);
  assert.equal(rows[0].charter_error, undefined);
  assert.ok(failed.summary.includes(CHARTER_HEADER), 'the throwing run is a compaction, not a cancellation');
});
