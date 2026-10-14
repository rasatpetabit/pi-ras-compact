import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routePolicyRevision } from '../src/client/decision-routes.js';
import { testConfig } from './support/config.js';

test('route pin is absent when unset and binds named charter route without reading keys', () => {
  const config = testConfig(); assert.equal(routePolicyRevision(config), undefined);
  config.api.charterBackend = 'openai-decisions';
  const revision = routePolicyRevision(config); assert.match(revision!, /^[a-f0-9]{64}$/);
  assert.equal(routePolicyRevision(structuredClone(config)), revision);
  const original = process.env.JEV_OPENAI_DECISIONS_API_KEY;
  try {
    process.env.JEV_OPENAI_DECISIONS_API_KEY = 'not-read-by-policy-hash';
    assert.equal(routePolicyRevision(config), revision);
  } finally {
    if (original === undefined) delete process.env.JEV_OPENAI_DECISIONS_API_KEY;
    else process.env.JEV_OPENAI_DECISIONS_API_KEY = original;
  }
  for (const mutate of [
    (c: typeof config) => { c.api.charterBackend = 'typesafe'; },
    (c: typeof config) => { c.api.openaiDecisionsTimeoutMs = 25000; },
    (c: typeof config) => { c.api.openaiDecisionsEndpoint = 'http://127.0.0.1:12345/v1/decisions'; },
    (c: typeof config) => { c.api.localRevision = 'a'.repeat(40); },
  ]) {
    const changed = structuredClone(config); mutate(changed);
    assert.notEqual(routePolicyRevision(changed), revision);
  }
});
