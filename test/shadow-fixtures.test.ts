import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { corpusSummary, loadStage3Requests } from '../src/shadow/fixtures.js';

/**
 * The stage3 receipt ships inside the package (local-fixtures) and, in a monorepo
 * checkout, also lives one level above it; resolve whichever is present. Receipt-bound
 * checks skip when neither copy is available; synthetic-fixture checks always run.
 */
const receipt: string | null = [
  fileURLToPath(new URL('../local-fixtures/jev-rtx-migration/h2o4b-adjudicator/stage3/receipt.json', import.meta.url)),
  fileURLToPath(new URL('../../docs/design/jev-rtx-migration/h2o4b-adjudicator/stage3/receipt.json', import.meta.url)),
].find(p => existsSync(p)) ?? null;
const skipReceipt = !receipt;

test('the committed stage3 receipt yields the declared 48 fixtures and 325 questions', { skip: skipReceipt }, () => {
  const entries = loadStage3Requests(receipt!);
  assert.equal(entries.length, 48);
  const summary = corpusSummary(entries);
  assert.equal(summary.requests, 48);
  assert.equal(summary.questions, 325);
  assert.deepEqual(summary.datasets, { base: 8, holdout2: 15, panel: 25 });
  // The transport-level label surface (noul values, choice and score label probabilities,
  // score values) equals the record's own stage3 native-answer count of 795.
  assert.equal(summary.transport_label_values, 795);
  // Every entry carries the identity needed to name a flip: dataset, fixture, request hash.
  for (const entry of entries) {
    assert.ok(['base', 'holdout2', 'panel'].includes(entry.dataset));
    assert.ok(/^[a-f0-9]{64}$/.test(entry.receivedSha256));
    assert.ok(typeof entry.fixture === 'string' && entry.fixture.length > 0);
    assert.ok(Object.keys(entry.questions).length > 0);
  }
});

test('route-checkpoint is located by dataset, fixture and request hash', { skip: skipReceipt }, () => {
  const route = loadStage3Requests(receipt!).find(e => e.fixture === 'route-checkpoint');
  assert.ok(route);
  assert.equal(route.dataset, 'holdout2');
  assert.equal(route.receivedSha256, '3a5fa9259a7c4ce02fb06dd4345fb473cecb2a14da0ceca3aec3a8577b6490e4');
  assert.ok('call_t3' in route.questions && 'result_t3' in route.questions);
});

test('duplicate (dataset, request hash) rows dedupe to the first seen request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-shadow-fixtures-'));
  const record = (dataset: string, sha: string, questions: Record<string, unknown>) => ({
    dataset, fixture: 'f', records_field: true,
    metadata: [{ decision_model: 'h2o-lightning-4b', received_sha256: sha, request: { state: { id: 1 }, questions } }],
  });
  const path = join(dir, 'mini.json');
  const q = { call_t1: { type: 'noul', instructions: 'x' } };
  writeFileSync(path, JSON.stringify({ records: [
    record('base', 'a'.repeat(64), q),
    record('base', 'a'.repeat(64), q),           // repeat row, same request hash
    record('panel', 'b'.repeat(64), q),
  ] }));
  const entries = loadStage3Requests(path);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.dataset), ['base', 'panel']);
  rmSync(dir, { recursive: true, force: true });
});

test('receipts holding datasets outside the declared development corpus are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-shadow-fixtures-'));
  const path = join(dir, 'bad.json');
  writeFileSync(path, JSON.stringify({ records: [
    { dataset: 'holdout3', fixture: 'sealed', metadata: [{ decision_model: 'h2o-lightning-4b',
      received_sha256: 'c'.repeat(64), request: { state: {}, questions: { q: { type: 'noul', instructions: 'x' } } } }] },
  ] }));
  assert.throws(() => loadStage3Requests(path), /holdout3/);
  rmSync(dir, { recursive: true, force: true });
});

test('the receipt file still hashes to the value pinned in the record', { skip: skipReceipt }, () => {
  const bytes = readFileSync(receipt!);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '9f2f29949b8db6974f39d61185b23106777c920038b5bc49f7b02b5fead727d9');
});
