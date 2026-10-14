import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { defaultConfigPath, loadConfig, overlayPath, backendPath } from '../src/client/config.js';
import { detectorPath, loadDetectorConfig, validateDetectorConfig } from '../src/client/detector-config.js';
import { scratchDir } from './support/scratch.js';

// Synthetic test values only; no calibration or runtime detector file is created in the repo.
const text = `mode = "shadow"
pressure_floor = 0.6
min_candidate_tokens = 100
max_sample_tokens = 4000
min_reclaim_tokens = 500
min_safe_boundary = 0.8
min_net_reduction_tokens = 100
rearm_growth_tokens = 200
cooldown_ms = 1000
failure_backoff_ms = 2000
request_timeout_ms = 3000
calibration = "eval/warrant/synthetic-test-only.json"
`;
const expected = {
  mode: 'shadow', pressureFloor: 0.6, minCandidateTokens: 100, maxSampleTokens: 4000,
  minReclaimTokens: 500, minSafeBoundary: 0.8, minNetReductionTokens: 100,
  rearmGrowthTokens: 200, cooldownMs: 1000, failureBackoffMs: 2000, requestTimeoutMs: 3000,
  calibration: 'eval/warrant/synthetic-test-only.json',
};
function pathFor() { return join(scratchDir('jev-detector-'), 'jev.toml'); }
function withNotes(fn: (notes: string[]) => void) {
  const original = process.stderr.write;
  const notes: string[] = [];
  process.stderr.write = ((chunk: unknown) => { notes.push(String(chunk)); return true; }) as typeof original;
  try { fn(notes); } finally { process.stderr.write = original; }
}

test('sibling detector path follows overlay/backend naming (including alternate basenames)', () => {
  assert.equal(detectorPath('/repo/config/jev.toml'), '/repo/config/jev.detector.toml');
  assert.equal(detectorPath('/tmp/alternate.toml'), '/tmp/alternate.detector.toml');
  assert.equal(detectorPath('/tmp/config'), '/tmp/config.detector.toml');
});

test('absent is silently off; explicit valid off, shadow and active map every field', () => {
  const path = pathFor();
  withNotes(notes => {
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    for (const mode of ['off', 'shadow', 'active']) {
      writeFileSync(detectorPath(path), text.replace('"shadow"', `"${mode}"`));
      assert.deepEqual(loadDetectorConfig(path), { ...expected, mode });
    }
    assert.deepEqual(notes, []);
  });
});

test('malformed syntax and schema disable with only one sanitized stderr note per path', () => {
  const path = pathFor();
  withNotes(notes => {
    writeFileSync(detectorPath(path), 'mode = "secret-untrusted-value"\n[broken');
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    writeFileSync(detectorPath(path), text + 'extra = "secret-untrusted-value"\n');
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    assert.equal(notes.length, 1);
    assert.equal(notes[0], '[pi-jev] detector config unreadable or malformed; detector off\n');
    assert.ok(!notes.join('').includes('secret-untrusted-value'));
  });
});

test('read failure other than missing is off plus one note, never throws', () => {
  const path = pathFor();
  mkdirSync(detectorPath(path));
  withNotes(notes => {
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    assert.equal(notes.length, 1);
  });
});

test('content edits, malformed recovery and deletion apply at next load; cached values cannot be mutated', () => {
  const path = pathFor();
  withNotes(notes => {
    writeFileSync(detectorPath(path), text);
    const first = loadDetectorConfig(path);
    assert.deepEqual(first, expected);
    first.mode = 'off';
    assert.deepEqual(loadDetectorConfig(path), expected);
    writeFileSync(detectorPath(path), text.replace('pressure_floor = 0.6', 'pressure_floor = 0.7'));
    assert.deepEqual(loadDetectorConfig(path), { ...expected, pressureFloor: 0.7 });
    writeFileSync(detectorPath(path), 'mode = "shadow"');
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' }, 'no stale enabled fallback');
    writeFileSync(detectorPath(path), text);
    assert.deepEqual(loadDetectorConfig(path), expected);
    rmSync(detectorPath(path));
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    assert.equal(notes.length, 1);
  });
});

test('strict flat schema rejects unknown/inherited names, tables and every missing key', () => {
  const raw = parse(text);
  assert.deepEqual(validateDetectorConfig(raw), { config: expected, errors: [] });
  for (const key of Object.keys(raw)) {
    const missing = { ...raw };
    delete missing[key];
    const result = validateDetectorConfig(missing);
    assert.equal(result.config, undefined);
    assert.deepEqual(result.errors, [`${key} (missing)`]);
  }
  for (const key of ['extra', 'toString', 'compaction']) {
    const result = validateDetectorConfig({ ...raw, [key]: 'untrusted-value' });
    assert.equal(result.config, undefined);
    assert.deepEqual(result.errors, [`${key} (unknown)`]);
    assert.ok(!JSON.stringify(result).includes('untrusted-value'));
  }
  for (const value of [null, false, [], 'config', new Date()]) assert.deepEqual(validateDetectorConfig(value), { errors: ['(root)'] });
  assert.equal(validateDetectorConfig(parse('[detector]\n' + text)).config, undefined);
});

const raw = parse(text);
for (const key of ['pressure_floor', 'min_safe_boundary']) {
  test(`${key}: finite probabilities including endpoints only`, () => {
    for (const value of [0, 1, 0.3]) assert.ok(validateDetectorConfig({ ...raw, [key]: value }).config);
    for (const value of [-0.1, 1.1, NaN, Infinity, '0.6', null, true]) {
      assert.deepEqual(validateDetectorConfig({ ...raw, [key]: value }).errors, [key]);
    }
  });
}
for (const key of ['min_candidate_tokens', 'max_sample_tokens', 'min_reclaim_tokens', 'min_net_reduction_tokens', 'rearm_growth_tokens', 'request_timeout_ms', 'cooldown_ms', 'failure_backoff_ms']) {
  test(`${key}: safe integer range, no operational defaults`, () => {
    const permitsZero = key === 'cooldown_ms' || key === 'failure_backoff_ms';
    for (const value of [1, 7, Number.MAX_SAFE_INTEGER]) assert.ok(validateDetectorConfig({ ...raw, [key]: value }).config);
    assert.equal(Boolean(validateDetectorConfig({ ...raw, [key]: 0 }).config), permitsZero);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', null, false]) {
      assert.deepEqual(validateDetectorConfig({ ...raw, [key]: value }).errors, [key]);
    }
  });
}

test('mode rejects aliases; calibration names a path, never inferred or read during loading', () => {
  for (const mode of ['on', 'SHADOW', '', true, 1, null]) assert.deepEqual(validateDetectorConfig({ ...raw, mode }).errors, ['mode']);
  for (const calibration of ['', ' ', 'bad\0path', true, 1, null]) assert.deepEqual(validateDetectorConfig({ ...raw, calibration }).errors, ['calibration']);
  for (const calibration of ['/evidence/run.json', '~/evidence.json', 'eval/warrant/run.json']) assert.ok(validateDetectorConfig({ ...raw, calibration }).config);
});

test('broken detector never changes loadConfig result or hash, including overlays/backends and invalid compaction config', () => {
  const path = pathFor();
  writeFileSync(path, readFileSync(defaultConfigPath(), 'utf8'));
  writeFileSync(overlayPath(path), '[compaction]\nkeep_threshold = 0.6\n');
  writeFileSync(backendPath(path), '[api]\nbackend = "typesafe"\n');
  const before = loadConfig(path);
  const beforeWithoutBackend = loadConfig(path, { backend: false });
  assert.ok(before.ok);
  assert.ok(beforeWithoutBackend.ok);
  withNotes(() => {
    for (const detector of ['[broken', text.replace('mode = "shadow"', 'mode = "bad"'), text]) {
      writeFileSync(detectorPath(path), detector);
      loadDetectorConfig(path);
      assert.deepEqual(loadConfig(path), before);
      assert.deepEqual(loadConfig(path, { backend: false }), beforeWithoutBackend);
    }
    writeFileSync(path, '[broken');
    const brokenBase = loadConfig(path);
    assert.deepEqual(brokenBase, { ok: false, errors: ['(syntax)'] });
    assert.deepEqual(loadDetectorConfig(path), expected, 'detector loading does not consume compaction config');
    writeFileSync(detectorPath(path), '[broken');
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    assert.deepEqual(loadConfig(path), brokenBase);
  });
});

test('mode off alone is valid and silent, including cached reload and rollback from enabled', () => {
  assert.deepEqual(validateDetectorConfig({ mode: 'off' }), { config: { mode: 'off' }, errors: [] });
  const path = pathFor();
  withNotes(notes => {
    writeFileSync(detectorPath(path), text);
    assert.deepEqual(loadDetectorConfig(path), expected);
    writeFileSync(detectorPath(path), 'mode = "off"\n');
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    assert.deepEqual(notes, []);
  });
  for (const mode of ['shadow', 'active']) {
    const result = validateDetectorConfig({ mode });
    assert.equal(result.config, undefined);
    assert.equal(result.errors.length, Object.keys(raw).length - 1);
  }
  assert.deepEqual(validateDetectorConfig({ mode: 'off', cooldown_ms: 0 }), { config: { mode: 'off' }, errors: [] });
  assert.deepEqual(validateDetectorConfig({ mode: 'off', cooldown_ms: -1 }).errors, ['cooldown_ms']);
  assert.deepEqual(validateDetectorConfig({ mode: 'off', extra: 1 }).errors, ['extra (unknown)']);
});


test('record-only config requires no calibration or numeric defaults; supplied keys remain strict', () => {
  assert.deepEqual(validateDetectorConfig({ mode: 'record' }), { config: { mode: 'record' }, errors: [] });
  assert.deepEqual(validateDetectorConfig({ mode: 'record', pressure_floor: .6 }), { config: { mode: 'record' }, errors: [] });
  for (const extra of [{ pressure_floor: 'bad' }, { extra: true }, { calibration: '' }]) {
    assert.equal(validateDetectorConfig({ mode: 'record', ...extra }).config, undefined);
  }
});

test('record mode loads and malformed record configs turn off with one sanitized note', () => {
  const path = pathFor();
  withNotes(notes => {
    writeFileSync(detectorPath(path), 'mode = "record"\n');
    assert.deepEqual(loadDetectorConfig(path), { mode: 'record' });
    assert.deepEqual(notes, []);
    for (const malformed of ['mode = "record"\npressure_floor = "secret"', 'mode = "record"\nextra = true', 'mode = "record"\n[broken']) {
      writeFileSync(detectorPath(path), malformed);
      assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
      assert.deepEqual(loadDetectorConfig(path), { mode: 'off' });
    }
    assert.deepEqual(notes, ['[pi-jev] detector config unreadable or malformed; detector off\n']);
  });
});
