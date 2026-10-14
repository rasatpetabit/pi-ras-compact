import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { defaultConfigPath, validateConfig } from '../src/client/config.js';
import { createCompactionAsker } from '../src/client/asker.js';
import { JevHttpClient } from '../src/client/jev-client.js';
const raw = () => parse(readFileSync(defaultConfigPath(), 'utf8')) as any;
test('unset charter route keeps existing config shape and pruning factory', () => {
  const { config, errors } = validateConfig(raw()); assert.ok(config, errors.join(','));
  assert.equal(Object.hasOwn(config.api, 'charterBackend'), false);
  assert.equal(Object.keys(config.api).some(k => k.startsWith('openaiDecisions')), false);
  assert.ok(createCompactionAsker(config, 'test') instanceof JevHttpClient);
});
test('named charter backend and explicit Decisions settings validate independently of pruning', () => {
  for (const backend of ['typesafe', 'local', 'openai-decisions']) {
    const r = raw(); Object.assign(r.api, { charter_backend: backend,
      openai_decisions_endpoint: 'https://api.openai.com/v1/decisions', openai_decisions_model: 'gpt-6-luna',
      openai_decisions_key_env: 'CUSTOM_DECISIONS_KEY', openai_decisions_timeout_ms: 45000,
      charter_replace_min: .68, charter_defers_max: .14 });
    if (backend === 'local') Object.assign(r.api, { local_endpoint: 'http://127.0.0.1:18390/v1/systemone-local', local_model: 'openjev' });
    const { config, errors } = validateConfig(r); assert.ok(config, errors.join(','));
    assert.equal(config.api.charterBackend, backend); assert.equal(config.api.backend, 'typesafe');
    assert.equal(config.api.openaiDecisionsModel, 'gpt-6-luna'); assert.equal(config.api.openaiDecisionsTimeoutMs, 45000);
    assert.equal(config.api.openaiDecisionsKeyEnv, 'CUSTOM_DECISIONS_KEY');
    assert.ok(createCompactionAsker(config, 'test') instanceof JevHttpClient);
  }
});
test('malformed, unpinned and unknown fields are rejected by name without values', () => {
  for (const [key, value] of [
    ['charter_backend', 'unknown'], ['backend', 'openai-decisions'], ['charter_backend', true],
    ['openai_decisions_model', 'gpt-latest'], ['openai_decisions_endpoint', 'https://evil.example/v1/decisions'],
    ['openai_decisions_endpoint', 'http://api.openai.com/v1/decisions'], ['openai_decisions_endpoint', 'http://localhost:1234/v1/decisions'],
    ['openai_decisions_endpoint', 'http://127.0.0.1:65536/v1/decisions'], ['openai_decisions_key_env', ''],
    ['openai_decisions_key_env', 'not an env name'], ['openai_decisions_key_env', 1], ['openai_decisions_timeout_ms', 0],
    ['openai_decisions_timeout_ms', 1000.5], ['openai_decisions_timeout_ms', 900001], ['openai_decisions_api_key', 'PRIVATE-KEY'],
  ]) {
    const r = raw(); r.api[key] = value; const out = validateConfig(r);
    assert.equal(out.config, undefined, String(key)); assert.ok(out.errors.some(e => e.startsWith(`api.${key}`)));
    assert.ok(!JSON.stringify(out.errors).includes('PRIVATE-KEY'));
  }
  const r = raw(); r.api.charter_backend = 'local';
  assert.equal(validateConfig(r).config, undefined, 'local charter requires endpoint/model');
});

test('new backend reference comments do not change production config identity; active values do', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { scratchDir } = await import('./support/scratch.js');
  const { loadConfig, backendPath } = await import('../src/client/config.js');
  const path = join(scratchDir('jev-decisions-config-'), 'jev.toml');
  writeFileSync(path, readFileSync(defaultConfigPath(), 'utf8'));
  const original = '[api]\nbackend = "typesafe"\n';
  writeFileSync(backendPath(path), original);
  const before = loadConfig(path); assert.ok(before.ok);
  writeFileSync(backendPath(path), original + '# decisions-reference: charter_backend = "openai-decisions"\n');
  const comment = loadConfig(path); assert.ok(comment.ok); assert.equal(comment.hash, before.hash);
  assert.deepEqual(comment.config, before.config);
  writeFileSync(backendPath(path), original + 'charter_backend = "openai-decisions"\nopenai_decisions_endpoint = "https://api.openai.com/v1/decisions"\nopenai_decisions_model = "gpt-6-luna"\nopenai_decisions_key_env = "CUSTOM_DECISIONS_KEY"\ncharter_replace_min = 0.68\ncharter_defers_max = 0.14\n');
  const active = loadConfig(path); assert.ok(active.ok); assert.notEqual(active.hash, before.hash);
  assert.equal(active.config.api.charterBackend, 'openai-decisions');
});
