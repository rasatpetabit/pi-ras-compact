import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'smol-toml';
import { defaultConfigPath, validateConfig, type JevConfig } from '../src/client/config.js';
import { routePolicyRevision } from '../src/client/decision-routes.js';
import { scratchDir } from './support/scratch.js';

/** A gate-on config, built the way config/jev.backend.toml's [api] table builds it in production. */
function gateConfig(overrides: Record<string, unknown> = {}): JevConfig {
  const raw = parse(readFileSync(defaultConfigPath(), 'utf8')) as Record<string, Record<string, unknown>>;
  Object.assign(raw.api, {
    charter_backend: 'openai-decisions',
    openai_decisions_endpoint: 'https://api.openai.com/v1/decisions',
    openai_decisions_model: 'gpt-6-luna',
    openai_decisions_key_env: 'JEV_OPENAI_DECISIONS_API_KEY',
    charter_replace_min: 0.72,
    charter_defers_max: 0.14,
    ...overrides,
  });
  const { config, errors } = validateConfig(raw);
  assert.ok(config, errors.join(','));
  return config!;
}

test('the route policy pin is off without the gate and 64 hex with it', () => {
  const raw = parse(readFileSync(defaultConfigPath(), 'utf8')) as Record<string, Record<string, unknown>>;
  const { config: off, errors } = validateConfig(raw);
  assert.ok(off, errors.join(','));
  assert.equal(routePolicyRevision(off!), undefined, 'no charter backend configured, no pin');
  assert.match(routePolicyRevision(gateConfig())!, /^[0-9a-f]{64}$/);
});

test('the pin is identical across two runs with the same config, whatever the telemetry path', () => {
  const config = gateConfig();
  assert.equal(routePolicyRevision(structuredClone(config)), routePolicyRevision(structuredClone(config)));
  // The telemetry directory is not route policy: a redirected path (an identity run's per-run
  // scratch, an operator's custom state dir) must not move the pin.
  const redirected = structuredClone(config);
  redirected.telemetry.path = '/elsewhere/scratch/calls.jsonl';
  assert.equal(routePolicyRevision(redirected), routePolicyRevision(config));
});

test('the pin changes when the charter config changes', () => {
  const config = gateConfig();
  const drifted = gateConfig({ charter_replace_min: 0.71 });
  assert.notEqual(routePolicyRevision(drifted), routePolicyRevision(config));
});

test('the pin changes when the gate source changes', async () => {
  const config = gateConfig();
  // A byte-identical copy of decision-routes.ts in a scratch tree, with every file it reads
  // beside it: the copy reads its own neighbours, so editing one must move its pin.
  const copy = join(scratchDir('jev-route-revision-'), 'client');
  const source = dirname(fileURLToPath(new URL('../src/client/decision-routes.ts', import.meta.url)));
  const root = dirname(source);
  mkdirSync(copy, { recursive: true });
  for (const file of ['decision-routes.ts', 'asker.ts', 'config.ts', 'jev-client.ts', 'local-client.ts', 'openai-decisions-client.ts', 'answer-validation.ts']) {
    copyFileSync(join(source, file), join(copy, file));
  }
  for (const [dir, file] of [['core', 'charter-gate.ts'], ['core', 'choice-answer.ts'], ['core', 'charter-judge.ts'], ['pi', 'extension.ts']] as const) {
    mkdirSync(join(dirname(copy), dir), { recursive: true });
    copyFileSync(join(root, dir, file), join(dirname(copy), dir, file));
  }
  assert.equal(readFileSync(join(copy, 'decision-routes.ts'), 'utf8'), readFileSync(join(source, 'decision-routes.ts'), 'utf8'));
  const probed = await import(`${pathToFileURL(join(copy, 'decision-routes.ts')).href}`);
  assert.equal(probed.routePolicyRevision(config), routePolicyRevision(config), 'same bytes, same pin');
  writeFileSync(join(dirname(copy), 'core', 'charter-gate.ts'), `${readFileSync(join(root, 'core', 'charter-gate.ts'), 'utf8')}\n// a source edit\n`);
  assert.notEqual(probed.routePolicyRevision(config), routePolicyRevision(config), 'a gate source edit moves the pin');
});