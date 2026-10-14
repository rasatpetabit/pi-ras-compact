import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { JevConfig } from './config.js';

/**
 * Source-bound route policy pin, adapted from the H2O split-route prior art.
 * The adapter records this pin only for an explicitly configured charter gate.
 * Proposals/confirmation stay on the existing scorer; the Decisions route can
 * only veto confirmed proposals, never discover targets. The key's environment VALUE is never read or hashed.
 */
export function routePolicyRevision(config: JevConfig): string | undefined {
  if (config.api.charterBackend === undefined) return undefined;
  const hash = createHash('sha256');
  // The telemetry directory is not route policy: a redirected telemetry path (a test's per-run
  // scratch, an operator's custom state dir) must not move the pin, or the same policy would
  // produce a different revision on every run and across environments. Everything else in the
  // resolved config stays hashed. Version 4: v3 hashed the whole config, telemetry included.
  const { telemetry: _excluded, ...pinned } = config;
  hash.update(JSON.stringify({
    version: 4,
    families: { corrects: 'proposer', still_applies: 'proposer', confirmed_proposal: 'four-way-choice', otherwise: 'pruning', recovery: false },
    config: pinned,
  }));
  for (const file of [
    './decision-routes.ts', './asker.ts', './config.ts', './jev-client.ts',
    './local-client.ts', './openai-decisions-client.ts', './answer-validation.ts',
    '../core/charter-gate.ts', '../core/choice-answer.ts', '../core/charter-judge.ts', '../pi/extension.ts',
  ]) {
    hash.update(file);
    hash.update(readFileSync(new URL(file, import.meta.url)));
  }
  return hash.digest('hex');
}
