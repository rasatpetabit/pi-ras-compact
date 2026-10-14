import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { defaultConfigPath } from './config.js';
import type { DetectorConfig as AssessmentConfig, WarrantParams } from '../core/warrant.js';

/** Record is observer-only; shadow/active require the same explicit assessment parameters.
 * Active arming is feature-detected on the running Pi context, never a config default. */
export type DetectorConfig = AssessmentConfig | { mode: 'record' };

/** Independent sibling, never merged into the strictly validated compaction config. */
export function detectorPath(path: string): string {
  return path.replace(/\.toml$/, '') + '.detector.toml';
}

type Rule = { field: keyof WarrantParams; kind: 'mode' | 'probability' | 'positive-int' | 'count' | 'path' };
const SCHEMA: Record<string, Rule> = {
  mode: { field: 'mode', kind: 'mode' },
  pressure_floor: { field: 'pressureFloor', kind: 'probability' },
  min_candidate_tokens: { field: 'minCandidateTokens', kind: 'positive-int' },
  max_sample_tokens: { field: 'maxSampleTokens', kind: 'positive-int' },
  min_reclaim_tokens: { field: 'minReclaimTokens', kind: 'positive-int' },
  min_safe_boundary: { field: 'minSafeBoundary', kind: 'probability' },
  min_net_reduction_tokens: { field: 'minNetReductionTokens', kind: 'positive-int' },
  rearm_growth_tokens: { field: 'rearmGrowthTokens', kind: 'positive-int' },
  cooldown_ms: { field: 'cooldownMs', kind: 'count' },
  failure_backoff_ms: { field: 'failureBackoffMs', kind: 'count' },
  request_timeout_ms: { field: 'requestTimeoutMs', kind: 'positive-int' },
  calibration: { field: 'calibration', kind: 'path' },
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

function check(kind: Rule['kind'], value: unknown): boolean {
  switch (kind) {
    case 'mode': return value === 'off' || value === 'record' || value === 'shadow' || value === 'active';
    case 'probability': return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    case 'positive-int': return Number.isSafeInteger(value) && (value as number) > 0;
    case 'count': return Number.isSafeInteger(value) && (value as number) >= 0;
    // Evidence paths may be repo-relative; resolving/reading evidence is a later calibration gate.
    case 'path': return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
  }
}

/** Flat, strict schema; no defaults for numeric parameters and no values in diagnostics. */
export function validateDetectorConfig(raw: unknown): { config?: DetectorConfig; errors: string[] } {
  if (!record(raw)) return { errors: ['(root)'] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) if (!Object.hasOwn(SCHEMA, key)) errors.push(`${key} (unknown)`);
  for (const [key, rule] of Object.entries(SCHEMA)) {
    if (!Object.hasOwn(raw, key)) {
      if (raw.mode !== 'off' && raw.mode !== 'record') errors.push(`${key} (missing)`);
    } else if (!check(rule.kind, raw[key])) errors.push(key);
  }
  if (errors.length > 0) return { errors };
  if (raw.mode === 'record') return { config: { mode: 'record' }, errors };
  if (raw.mode === 'off' && Object.keys(SCHEMA).some(key => !Object.hasOwn(raw, key))) return { config: { mode: 'off' }, errors };
  const config = Object.fromEntries(Object.entries(SCHEMA).map(([key, rule]) => [rule.field, raw[key]])) as unknown as WarrantParams;
  return { config, errors };
}

let cache: { path: string; text: string; config: DetectorConfig } | undefined;
const noted = new Set<string>();

function disabled(path: string): DetectorConfig {
  if (!noted.has(path)) {
    noted.add(path);
    // Fixed text: neither untrusted config values nor parser/OS messages reach stderr.
    process.stderr.write('[pi-jev] detector config unreadable or malformed; detector off\n');
  }
  return { mode: 'off' };
}

/**
 * Reads beside the supplied jev.toml on every call, caching by text just like loadConfig.
 * Absent is a silent opt-out; any other failure disables only the detector with one note
 * per path per process. It neither calls loadConfig nor touches that loader's cache/hash.
 */
export function loadDetectorConfig(path: string = defaultConfigPath()): DetectorConfig {
  const sibling = detectorPath(path);
  let text: string;
  try {
    text = readFileSync(sibling, 'utf8');
  } catch (error) {
    cache = undefined;
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { mode: 'off' } : disabled(sibling);
  }
  if (cache?.path === sibling && cache.text === text) return structuredClone(cache.config);
  let config: DetectorConfig;
  try {
    config = validateDetectorConfig(parse(text)).config ?? disabled(sibling);
  } catch {
    config = disabled(sibling);
  }
  cache = { path: sibling, text, config };
  return structuredClone(config);
}
