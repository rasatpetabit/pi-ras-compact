import type { CoreAsker } from '../core/judge.js';
import type { JevConfig } from './config.js';
import { JevHttpClient, type AskerContext } from './jev-client.js';
import { LocalDecisionClient } from './local-client.js';

/** Backend selection is explicit; failures never substitute the other backend. */
export function createCompactionAsker(config: JevConfig, configHash: string, signal?: AbortSignal, context?: AskerContext): CoreAsker {
  if (config.api.backend !== undefined && config.api.backend !== 'typesafe' && config.api.backend !== 'local') {
    throw new Error('Unknown decision backend');
  }
  const options = { config, configHash, caller: 'pi-compaction', context };
  return config.api.backend === 'local'
    ? new LocalDecisionClient(options, signal)
    : new JevHttpClient(options, signal);
}
