import { effectiveAskerModel, type JevConfig } from './config.js';
import { JEV_ENDPOINT } from './jev-client.js';

/** Additive, credential-free identity of the effective decision route; not server attestation. */
export interface BackendDescriptor {
  id: string;
  label?: string;
  model?: string;
  where?: string;
  /** Revision pinned in configuration. */
  revision?: string;
  /** Revision validated from a successful local service response; not cryptographic attestation. */
  verified_revision?: string;
}

/** Never retain userinfo, path, query or fragment. URL normalizes default ports. */
export function endpointOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid decision endpoint protocol');
  return `${url.protocol}//${url.host}`;
}

export function hostedDescriptor(config: JevConfig): BackendDescriptor {
  return { id: 'typesafe', label: 'TypeSafe hosted', model: config.api.model, where: endpointOrigin(JEV_ENDPOINT) };
}
export function localDescriptor(config: JevConfig): BackendDescriptor {
  return { id: 'local', label: 'Local', model: effectiveAskerModel(config),
    ...(config.api.localEndpoint ? { where: endpointOrigin(config.api.localEndpoint) } : {}),
    ...(config.api.localRevision ? { revision: config.api.localRevision } : {}) };
}
/** Uses client-owned identity functions, including before a pass makes any pruning requests. */
export function backendDescriptor(config: JevConfig): BackendDescriptor {
  return config.api.backend === 'local' ? localDescriptor(config) : hostedDescriptor(config);
}
