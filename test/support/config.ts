import { join } from 'node:path';
import { defaultConfigPath, loadConfig, type JevConfig } from '../../src/client/config.js';
import { scratchDir } from './scratch.js';

/**
 * The committed config (one source of truth for values), with telemetry in a fresh scratch dir.
 * Base and overlay only: tests start from TypeSafe whatever the live backend file selects.
 */
export function testConfig(mutate?: (config: JevConfig) => void): JevConfig {
  const loaded = loadConfig(defaultConfigPath(), { backend: false });
  if (!loaded.ok) throw new Error(`committed config is invalid: ${loaded.errors.join(', ')}`);
  const config = structuredClone(loaded.config);
  config.telemetry.path = join(scratchDir('jev-telemetry-'), 'calls.jsonl');
  // The pool tests exercise the keep/drop pool with operator messages in it, as before the
  // session charter. The loader default is on (test/charter-integration.test.ts checks it);
  // tests of the charter turn it on explicitly.
  config.compaction.charter = false;
  // Likewise the pool tests render write bodies as before; test/live.test.ts covers the stubs.
  config.compaction.stubWrites = false;
  config.compaction.touchedPaths = false;
  mutate?.(config);
  return config;
}
