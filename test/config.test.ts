import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { defaultConfigPath, loadConfig, validateConfig, overlayPath } from '../src/client/config.js';
import { scratchDir } from './support/scratch.js';

const committed = readFileSync(defaultConfigPath(), 'utf8');
const scratch = scratchDir('jev-config-');
let n = 0;
const write = (text: string): string => {
  const path = join(scratch, `c${n++}.toml`);
  writeFileSync(path, text);
  return path;
};
const edit = (from: RegExp, to: string): string => {
  assert.match(committed, from);
  return committed.replace(from, to);
};

test('the committed config is valid and maps every field', () => {
  const result = loadConfig(defaultConfigPath());
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.config.api.model, 'jev-1.13.0');
  assert.deepEqual(result.config.compaction.thresholdSchedule, [0.5, 0.65, 0.8]);
  assert.deepEqual(result.config.compaction.pins, ['user', 'error', 'modify', 'boundary', 'decision', 'instruction']);
  assert.ok(Array.isArray(result.config.compaction.instructionPaths), 'instruction paths are a list of operator-configured directories');
  // instruction_paths is free-form configuration: whatever directory list the operator
  // commits validates and maps verbatim.
  const explicit = validateConfig(parse(
    committed.replace(/^instruction_paths = .*\n?/gm, '').replace(/^\[compaction\]$/m, '[compaction]\ninstruction_paths = ["/opt/policy/"]'),
  ));
  assert.ok(explicit.config, JSON.stringify(explicit.errors));
  assert.deepEqual(explicit.config.compaction.instructionPaths, ['/opt/policy/']);
  assert.equal(result.config.compaction.maxRequestTokens, 30_000);
  // The committed config deliberately omits the optional RPC timeout until the follow-up
  // commit, so the previous code (which rejects unknown compaction keys) still loads it.
  assert.equal(result.config.compaction.promptTimeoutMs, undefined);
  assert.equal(result.config.render.maxArgCharsPinned, 8000);
  assert.match(result.hash, /^[0-9a-f]{12}$/);
});

test('an old config without the decision keys loads with real defaults, and decision joins pins', () => {
  // The committed config predates the keys, so it is the old-config case.
  const result = loadConfig(defaultConfigPath());
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.config.compaction.decisionTools, ['ask_user_question']);
  assert.equal(result.config.compaction.decisionPinGenerations, 20);
  assert.equal(result.config.compaction.decisionPinMaxChars, 40_000);

  const five = validateConfig(parse(edit(/^pins = .*$/m, 'pins = ["user", "error", "modify", "boundary", "decision"]')));
  assert.ok(five.config, JSON.stringify(five.errors));
  assert.deepEqual(five.config.compaction.pins, ['user', 'error', 'modify', 'boundary', 'decision']);
  const unknown = validateConfig(parse(edit(/^pins = .*$/m, 'pins = ["user", "decision", "everything"]')));
  assert.equal(unknown.config, undefined);
  assert.ok(unknown.errors.includes('compaction.pins'));

  // Explicit values load; out-of-range ones fail by field name like every other key.
  const explicit = edit(
    /^modify_tools = .*$/m,
    '$&\ndecision_tools = ["ask_user_question", "mcp__ask"]\ndecision_pin_generations = 7\ndecision_pin_max_chars = 50000',
  );
  const loaded = validateConfig(parse(explicit));
  assert.ok(loaded.config, JSON.stringify(loaded.errors));
  assert.deepEqual(loaded.config.compaction.decisionTools, ['ask_user_question', 'mcp__ask']);
  assert.equal(loaded.config.compaction.decisionPinGenerations, 7);
  assert.equal(loaded.config.compaction.decisionPinMaxChars, 50_000);
  for (const [to, field] of [
    ['decision_pin_generations = 0', 'compaction.decision_pin_generations'],
    ['decision_pin_max_chars = 999', 'compaction.decision_pin_max_chars'],
    ['decision_tools = ["ask_user_question", " "]', 'compaction.decision_tools'],
  ] as const) {
    const bad = validateConfig(parse(edit(/^modify_tools = .*$/m, `$&\n${to}`)));
    assert.equal(bad.config, undefined, field);
    assert.ok(bad.errors.includes(field), `${field}: ${bad.errors.join(', ')}`);
  }
});

test('an unknown key is rejected and its value never appears in the errors', () => {
  const text = edit(/^\[api\]$/m, '[api]\nurl = "https://evil.example/steal"\ntoString = "x"');
  const result = loadConfig(write(text));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.includes('api.url (unknown)'));
  assert.ok(!result.ok && result.errors.includes('api.toString (unknown)'), 'inherited object names are not known keys');
  assert.ok(!JSON.stringify(result).includes('evil.example'));
});

test('out-of-range numbers, unsorted schedules, aliases and bad pins are rejected by field name', () => {
  const cases: Array<[RegExp, string, string]> = [
    [/^max_share = 0\.5 /m, 'max_share = 2 ', 'compaction.max_share'],
    [/^max_after_share = [0-9.]+ /m, 'max_after_share = 2 ', 'compaction.max_after_share'],
    [/^threshold_schedule = .*$/m, 'threshold_schedule = [0.8, 0.5]', 'compaction.threshold_schedule'],
    [/^model = "jev-1\.13\.0"/m, 'model = "jev-latest"', 'api.model'],
    [/^pins = .*$/m, 'pins = ["user", "everything"]', 'compaction.pins'],
    [/^timeout_ms = 20000$/m, 'timeout_ms = 0', 'api.timeout_ms'],
    [/^retry_jitter = 0\.25 /m, 'retry_jitter = 2 ', 'api.retry_jitter'],
    [/^max_retries = 2 /m, 'max_retries = -1 ', 'api.max_retries'],
    [/^max_request_tokens = 30_000/m, 'max_request_tokens = 20_000', 'compaction.max_request_tokens (must exceed max_state_tokens)'],
    [/^path = .*$/m, 'path = "relative/calls.jsonl"', 'telemetry.path'],
  ];
  for (const [from, to, field] of cases) {
    const result = validateConfig(parse(edit(from, to)));
    assert.equal(result.config, undefined, field);
    assert.ok(result.errors.includes(field), `${field}: ${JSON.stringify(result.errors)}`);
  }
});

test('compaction.prompt_timeout_ms is optional but, when present, its range is enforced by field name', () => {
  // Absent is valid (the committed config omits it during the rollout).
  assert.ok(validateConfig(parse(committed)).config, 'the committed config is valid without the key');
  const withZero = edit(/^\[compaction\]$/m, '[compaction]\nprompt_timeout_ms = 0');
  assert.equal(validateConfig(parse(withZero)).config, undefined);
  assert.ok(validateConfig(parse(withZero)).errors.includes('compaction.prompt_timeout_ms'));
  const tooBig = edit(/^\[compaction\]$/m, '[compaction]\nprompt_timeout_ms = 999_999_999');
  assert.ok(validateConfig(parse(tooBig)).errors.includes('compaction.prompt_timeout_ms'));
  const notANumber = edit(/^\[compaction\]$/m, '[compaction]\nprompt_timeout_ms = "120_000"');
  assert.ok(validateConfig(parse(notANumber)).errors.includes('compaction.prompt_timeout_ms'));
  const present = validateConfig(parse(edit(/^\[compaction\]$/m, '[compaction]\nprompt_timeout_ms = 2500')));
  assert.equal(present.config?.compaction.promptTimeoutMs, 2500);
});

test('the obsolete [budget] table is accepted and ignored, including unknown keys inside it', () => {
  // Deployment compatibility, one direction only: this code ignores a leftover
  // [budget], while the previous code REQUIRED it. The committed config carries
  // the section for exactly that reason, so the new extension may load first.
  const result = loadConfig(defaultConfigPath());
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(Object.hasOwn(result.config, 'budget'), false);
  const withJunk = edit(/^daily_requests = .*$/m, 'daily_requests = 1\nunknown_key = 2');
  const junk = validateConfig(parse(withJunk));
  assert.ok(junk.config, JSON.stringify(junk.errors));
  assert.equal(Object.hasOwn(junk.config!, 'budget'), false);
});

test('a missing key and a syntax error both fail', () => {
  const missing = validateConfig(parse(edit(/^max_share = .*$/m, '')));
  assert.ok(missing.errors.includes('compaction.max_share (missing)'));
  const missingAfter = validateConfig(parse(edit(/^max_after_share = .*$/m, '')));
  assert.ok(missingAfter.errors.includes('compaction.max_after_share (missing)'));
  const broken = loadConfig(write('[api\nmodel = '));
  assert.deepEqual(broken, { ok: false, errors: ['(syntax)'] });
  assert.deepEqual(loadConfig(join(scratch, 'absent.toml')), { ok: false, errors: ['(file missing)'] });
});

test('an edit to the file is picked up on the next load without a restart, even at the same size', () => {
  const path = write(committed);
  const first = loadConfig(path);
  assert.ok(first.ok && first.config.compaction.keepThreshold === 0.5);
  writeFileSync(path, edit(/^keep_threshold = 0\.5$/m, 'keep_threshold = 0.6'));
  const second = loadConfig(path);
  assert.ok(second.ok && second.config.compaction.keepThreshold === 0.6);
  assert.ok(first.ok && second.ok && first.hash !== second.hash);
});

test('jev.toml stays loadable by pi-jev before e2d10660; the overlay carries the newer keys', () => {
  // Live sessions running older pi-jev read jev.toml strictly: an unknown key or pin class there
  // cancels every compaction in them. Newer keys belong in jev.overlay.toml until the gate passes.
  // The monorepo rollout keeps the base at the pre-gate pin set; the packaged public config may
  // already carry all standard classes. Either way the base loads on its own and the overlay is
  // the only way a different pin list arrives.
  const base = readFileSync(defaultConfigPath(), 'utf8');
  assert.ok(!/^instruction_|^decision_/m.test(base), 'no instruction_/decision_ keys in jev.toml');
  const parsed = validateConfig(parse(base));
  assert.ok(parsed.config, JSON.stringify(parsed.errors));
  const basePins = parsed.config.compaction.pins as string[];
  const legacy = ['user', 'error', 'modify', 'boundary'];
  assert.ok(legacy.every(pin => basePins.includes(pin)), 'the legacy pin classes stay loadable');
  assert.ok(basePins.every(pin => [...legacy, 'decision', 'instruction'].includes(pin)), 'only standard pin classes appear');
  const dir = mkdtempSync(join(tmpdir(), 'jev-overlay-'));
  const path = join(dir, 'jev.toml');
  writeFileSync(path, base);
  const alone = loadConfig(path);
  assert.ok(alone.ok);
  if (!alone.ok) return;
  assert.deepEqual(alone.config.compaction.pins, basePins);
  writeFileSync(overlayPath(path), '[compaction]\npins = ["user", "decision"]\n');
  const merged = loadConfig(path);
  assert.ok(merged.ok);
  if (!merged.ok) return;
  assert.deepEqual(merged.config.compaction.pins, ['user', 'decision']);
  assert.equal(merged.config.compaction.modifyTools.length, alone.config.compaction.modifyTools.length, 'other keys come from the base');
  assert.notEqual(merged.hash, alone.hash, 'the overlay changes the config hash');
});
