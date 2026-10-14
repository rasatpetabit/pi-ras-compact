import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, defaultConfigPath } from '../src/client/config.js';

// The committed production config routes charter retirement through the Decisions gate with
// exactly the qualified values (qualified on 2026-10-12: R=0.72, D=0.14, gpt-6-luna). Any drift
// from them is a new, unqualified gate. The qualification receipt lives in the monorepo
// corpus; without it (standalone checkout) the check skips.
const receiptUrl = new URL('../../docs/design/jev-charter-veto/run/receipt.json', import.meta.url);
const qualified = existsSync(receiptUrl)
  ? JSON.parse(readFileSync(receiptUrl, 'utf8')) as { verdict: string; dry_run: boolean; identity: { R: number; D: number } }
  : null;

test('production charter retirement uses the qualified Decisions gate', { skip: !qualified }, () => {
  assert.equal(qualified.verdict, 'PASS');
  assert.equal(qualified.dry_run, false);
  const loaded = loadConfig(defaultConfigPath());
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.errors.join(','));
  const { api } = loaded.config;
  assert.equal(api.charterBackend, 'openai-decisions');
  assert.equal(api.openaiDecisionsModel, 'gpt-6-luna');
  assert.equal(api.openaiDecisionsEndpoint, 'https://api.openai.com/v1/decisions');
  assert.equal(api.openaiDecisionsKeyEnv, 'JEV_OPENAI_DECISIONS_API_KEY');
  assert.equal(api.charterReplaceMin, qualified.identity.R);
  assert.equal(api.charterDefersMax, qualified.identity.D);
  assert.equal(api.backend, 'local', 'pruning stays on the local 27B');
});