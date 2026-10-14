import { entryMarker, markerFor, type MarkerData } from '../../src/pi/marker.js';
import type { BackendDescriptor } from '../../src/client/backend-descriptor.js';
import type { RouteRecord } from '../../src/pi/presentation.js';

export const LOCAL: BackendDescriptor = { id: 'local', label: 'Local', model: 'openjev', where: 'http://127.0.0.1:18390', revision: '0b6bb6e571bc0123456789abcdef0123456789abcd' };
export const HOSTED: BackendDescriptor = { id: 'typesafe', label: 'TypeSafe hosted', model: 'jev-1.13.0', where: 'https://api.typesafe.ai' };
export function sampleCards(): Record<string, MarkerData> {
  const saved = (jev: Record<string, unknown>) => ({ id: 'c1', fromHook: true, tokensBefore: 120000, summary: 'saved summary body', details: { jev } });
  const jev = { backend: 'local', backend_descriptor: LOCAL, model: 'openjev', latencyMs: 4200,
    budget: { predictedAfter: 38000, trigger: 100000, target: 40000, fixedAfter: 10000, budgetTokens: 30000 },
    stats: { kept: 42, truncated: 8, dropped: 17, pinned: 9, jevRequests: 0, jevInputTokens: 0, jevOutputTokens: 0 },
    charter_stats: { said: 4, answered: 3, retired: 2 }, config_hash: 'abc' };
  const local = entryMarker(saved({ ...jev, backend_requests: { local: 0 }, backend_responses: { local: 0 } }));
  const served = entryMarker(saved({ ...jev, backend_descriptor: { ...LOCAL, verified_revision: LOCAL.revision }, backend_requests: { local: 2 }, backend_responses: { local: 2 } }));
  const hosted = entryMarker(saved({ ...jev, backend: 'typesafe', backend_descriptor: HOSTED, backend_requests: { typesafe: 2 }, backend_responses: { typesafe: 2 }, model: HOSTED.model, latencyMs: 7800 }));
  const fallback = entryMarker(saved({ ...jev, backend: 'typesafe', backend_descriptor: HOSTED, model: HOSTED.model, latencyMs: 7800,
    backend_requests: { local: 1, typesafe: 2 }, backend_responses: { local: 0, typesafe: 2 }, fallback_from: 'local', fallback_reason: 'timeout', fallback_descriptor: LOCAL }));
  const future = (requests?: Record<string, number>, responses?: Record<string, number>) => entryMarker(saved({
    ...jev, backend: 'edge',
    backend_descriptor: { id: 'edge', label: 'Edge West', model: 'edge-2', where: 'https://edge-west.example:8443' },
    ...(requests ? { backend_requests: requests } : {}),
    ...(responses ? { backend_responses: responses } : {}),
  }));
  const pi = (resolution?: string, reason: string | null = null) => markerFor({ id: 'pi', tokensBefore: 120000 }, {
    engine: 'fallback', reason, tokensBefore: 120000, tokensAfter: null, latencyMs: 1234,
    ...(resolution ? { resolution } : {}), ...(reason && reason !== 'disabled' ? { backend: 'local', backend_descriptor: LOCAL } : {}),
  }, null);
  return {
    'Local measured (zero pruning requests)': { ...local, measuredAfter: 44000 },
    'Local predicted': local,
    'Local served (verified response)': { ...served, measuredAfter: 44000 },
    'Local charter attempts unconfirmed': entryMarker(saved({ ...jev, backend_requests: { local: 2 }, backend_responses: { local: 0 } })),
    'Historical positive attempts, no response evidence': entryMarker(saved({ ...jev, backend_requests: { local: 2 } })),
    'Hosted predicted': hosted,
    'Hosted measured': { ...hosted, measuredAfter: 44000 },
    'Hosted retry after local timeout': fallback,
    'Historical fallback ID, no source descriptor or reason': { ...hosted, fallback_from: 'local' },
    'Future client (served)': future({ edge: 2 }, { edge: 1 }),
    'Future client (no requests)': future({ edge: 0 }, { edge: 0 }),
    'Future client (activity unknown)': future(),
    'Future client (service unconfirmed)': future({ edge: 2 }, { edge: 0 }),
    'Recorded ID, no label': entryMarker(saved({ ...jev, backend: 'edge', backend_descriptor: { id: 'edge', model: 'edge-2', where: 'https://edge.example' } })),
    'Pre-change Jev, recorded model and latency': entryMarker(saved({ model: 'openjev', latencyMs: 4200, stats: jev.stats, budget: jev.budget })),
    'Pre-change Jev, no model or latency': entryMarker(saved({})),
    'Measured after, before absent': { ...local, tokensBefore: null, measuredAfter: 44000 },
    'Predicted after, before absent': { ...local, tokensBefore: null },
    'Message-only estimate': { ...local, predictedAfter: null, contextAfter: 900 },
    'Before only': { ...local, predictedAfter: null },
    'Neither context figure': { ...local, tokensBefore: null, predictedAfter: null },
    'Measured without prediction': { ...local, measuredAfter: 44000, predictedAfter: null },
    'Measured exceeds trigger': { ...local, measuredAfter: 110000 },
    'Predicted exceeds trigger': { ...local, predictedAfter: 110000 },
    'Completed Pi explicitly selected': pi('native', 'network'),
    'Completed Pi disabled': pi('disabled', 'disabled'),
    'Pi outcome absent': entryMarker({ id: 'pi', tokensBefore: 120000 }),
    'Pi legacy failure, no explicit selection': pi(undefined, 'timeout'),
    'Other extension': markerFor({ id: 'other', fromHook: true, tokensBefore: 120000 }, undefined, 900),
  };
}
export function sampleOutcomes(): Array<{ state: string; route: RouteRecord; explanation?: string }> {
  const route: RouteRecord = { backend_requests: { typesafe: 2 }, backend_responses: { typesafe: 2 }, backend: 'typesafe', backend_descriptor: HOSTED, tokens_before: 120000, predicted_after: 38000, reason: 'timeout' };
  return [
    { state: 'success', route: { ...route, backend: 'local', backend_descriptor: LOCAL, backend_requests: { local: 0 }, backend_responses: { local: 0 } } },
    { state: 'success', route },
    ...['served', 'no requests', 'activity unknown', 'service unconfirmed'].map(state => {
      const data = sampleCards()[`Future client (${state})`];
      return { state: 'success', route: { backend: data.backend, backend_descriptor: data.backend_descriptor, backend_requests: data.backend_requests, backend_responses: data.backend_responses } };
    }),
    { state: 'hosted_success', route: { ...route, fallback_from: 'local', fallback_reason: 'timeout', fallback_descriptor: LOCAL } },
    { state: 'hosted_retry', route: { backend: 'local', backend_descriptor: LOCAL, reason: 'timeout' } },
    ...['failure', 'chooser', 'retry', 'native', 'cancel', 'abort', 'headless', 'rpc', 'last_resort'].map(state => ({ state, route })),
    { state: 'failure', route: { reason: 'config' }, explanation: 'configuration missing or invalid' },
    { state: 'last_resort', route: {} },
  ];
}
