import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { defaultConfigPath, validateConfig, loadConfig, effectiveAskerModel, isLocalDecisionEndpoint, overlayPath } from '../src/client/config.js';
import { scratchDir } from './support/scratch.js';

const committed = readFileSync(defaultConfigPath(), 'utf8');
const localFields = 'backend = "local"\nlocal_endpoint = "http://127.0.0.1:18343/v1/systemone-local"\nlocal_model = "clm"';
const configured = (fields: string) => validateConfig(parse(committed.replace('[api]', '[api]\n' + fields)));

test('existing config remains TypeSafe; local selection requires explicit endpoint and known model', () => {
  const old = validateConfig(parse(committed));
  assert.ok(old.config);
  assert.equal(old.config.api.backend, 'typesafe');
  assert.equal(effectiveAskerModel(old.config), 'jev-1.13.0');
  const missing = configured('backend = "local"');
  assert.equal(missing.config, undefined);
  assert.ok(missing.errors.some(error => error.startsWith('api.local_endpoint')));
  assert.ok(missing.errors.some(error => error.startsWith('api.local_model')));
  for (const model of ['clm', 'openjev', 'anyjev']) {
    const good = configured(localFields.replace('local_model = "clm"', `local_model = "${model}"`));
    assert.ok(good.config, JSON.stringify(good.errors));
    assert.equal(effectiveAskerModel(good.config), model);
    assert.equal(good.config.api.model, 'jev-1.13.0');
  }
  assert.equal(configured('backend = "typo"').config, undefined);
  assert.equal(configured(localFields.replace('local_model = "clm"', 'local_model = "unknown"')).config, undefined);
});

test('local endpoints require an exact literal loopback address, port and path', () => {
  for (const endpoint of ['http://127.0.0.1:18343/v1/systemone-local', 'http://[::1]:18343/v1/systemone-local']) assert.ok(isLocalDecisionEndpoint(endpoint));
  for (const endpoint of [
    'http://localhost:18343/v1/systemone-local', 'http://127.1:18343/v1/systemone-local',
    'http://2130706433:18343/v1/systemone-local', 'http://0x7f000001:18343/v1/systemone-local',
    'http://127.0.0.2:18343/v1/systemone-local', 'http://192.0.2.200:18343/v1/systemone-local',
    'https://127.0.0.1:18343/v1/systemone-local', 'http://127.0.0.1/v1/systemone-local',
    'http://user:pass@127.0.0.1:18343/v1/systemone-local', 'http://127.0.0.1:18343/v1/systemone-local?x=1',
    'http://127.0.0.1:18343/v1/systemone-local#x', 'http://127.0.0.1:18343/v1/systemone-local/',
    'http://127.0.0.1:99999/v1/systemone-local', 'http://127.0.0.1:0/v1/systemone-local',
    'http://127.0.0.1:18343/x/../v1/systemone-local', 'http://127.0.0.1:18343/v1/%73ystemone-local',
  ]) assert.equal(isLocalDecisionEndpoint(endpoint), false, endpoint);
});

test('an isolated overlay selects local scoring without modifying the base config', () => {
  const dir = scratchDir('jev-local-config-');
  const path = join(dir, 'jev.toml');
  writeFileSync(path, committed);
  const overlay = `[api]\n${localFields}\n[compaction]\nmax_state_tokens = 1000\nmax_request_tokens = 2000\n`;
  writeFileSync(overlayPath(path), overlay);
  const loaded = loadConfig(path);
  assert.ok(loaded.ok, JSON.stringify(loaded));
  assert.equal(loaded.config.api.backend, 'local');
  assert.equal(loaded.config.compaction.maxStateTokens, 1000);
  assert.equal(loaded.config.compaction.maxRequestTokens, 2000);
  assert.equal(readFileSync(path, 'utf8'), committed);
  writeFileSync(overlayPath(path), overlay.replace('127.0.0.1', 'private.invalid'));
  const bad = loadConfig(path);
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify(bad).includes('private.invalid'));
});
