import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { PIN_CLASSES, type PinClass } from '../core/pins.js';
import type { CoreOptions } from '../core/prune.js';

export interface JevConfig {
  api: {
    /** Omitted keeps the established TypeSafe client. Local is explicit opt-in. */
    backend?: 'typesafe' | 'local';
    /** Retirement-only route; omitted preserves the existing shared asker. */
    charterBackend?: 'typesafe' | 'local' | 'openai-decisions';
    openaiDecisionsEndpoint?: string;
    /** Exact model identity pin, not a free-form model selector. */
    openaiDecisionsModel?: 'gpt-6-luna';
    /** Environment variable NAME only; the key is read at call time. */
    openaiDecisionsKeyEnv?: string;
    openaiDecisionsTimeoutMs?: number;
    /** Four-way relation admission thresholds; required for the Decisions charter gate. */
    charterReplaceMin?: number;
    charterDefersMax?: number;
    localEndpoint?: string;
    localModel?: string;
    /** Local requests in flight at once (the service batches them). Absent = 1. */
    localMaxInflight?: number;
    /** One local request's limit, queueing included. Absent = min(timeoutMs, retryBudgetMs, 180s). */
    localTimeoutMs?: number;
    /** After a local service failure (network, timeout, HTTP error), retry the compaction once on TypeSafe. */
    fallback?: 'typesafe' | 'none';
    /** When set, every local answer must come from this exact service revision (model identity pin). */
    localRevision?: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
    retryBackoffMaxMs: number;
    retryJitter: number;
    retryBudgetMs: number;
  };
  telemetry: { path: string };
  compaction: {
    enabled: boolean;
    maxShare: number;
    maxAfterShare: number;
    keepThreshold: number;
    borderline: number;
    thresholdSchedule: number[];
    pins: PinClass[];
    modifyTools: string[];
    /** Tool calls whose whole call+result is pinned `decision`; the names rule of modifyTools. */
    decisionTools: string[];
    pinGenerations: number;
    /** Generations a decision pin survives, independent of pinGenerations. */
    decisionPinGenerations: number;
    /** Cap on the stored size of a retained decision answer. */
    decisionPinMaxChars: number;
    /** Tool calls that can be pinned `instruction`. The names rule of modifyTools. */
    instructionTools: string[];
    /** Basenames whose read is an instruction read, matched case-sensitively. */
    instructionFiles: string[];
    /**
     * Path prefixes whose read is an instruction read. Empty by default: the fleet's
     * policy root is operator config, added to config/jev.toml in the commit that
     * enables the class, never a default baked into this code.
     */
    instructionPaths: string[];
    /** Whether an instruction read's body contributes references for later reads. */
    instructionFollowReferences: boolean;
    /** Generations an instruction pin survives, independent of pinGenerations. */
    instructionPinGenerations: number;
    /** Cap on the rendered size of retained instruction reads. */
    instructionPinMaxChars: number;
    truncateHeadChars: number;
    maxStateTokens: number;
    maxRequestTokens: number;
    /**
     * RPC only: how long the failure prompt waits before cancelling. TUI waits as long as
     * the operator. Optional by design: when absent, RPC does not prompt at all (it would
     * hang an unattended client) and cancels exactly like a headless run. The schema adds
     * this key in a follow-up commit, after every live session has reloaded onto the code
     * that tolerates its absence, so the PREVIOUS code never reads an unknown compaction key.
     */
    promptTimeoutMs: number | undefined;
    /**
     * Session charter (spec: pi-jev-compact-cachelane, Design > Charter): every operator
     * message and answer before the compaction point is carried verbatim. Those segments are not
     * rendered in the pool and cost it nothing, but stay in the judge's view. Optional in the
     * schema, default on, so the previous code never reads an unknown key during rollout;
     * `charter = false` is the rollback.
     */
    charter: boolean;
    /**
     * Live-context stubs (spec: Live context). `stub_writes` defaults on: it passed the win rule on
     * the known set (tokens -14.0% vs charter, recall CI [+0.00, +0.00]) and on the win-rule set
     * (-12.9%, [+0.00, +0.00]). `stub_edit_chars` stays off when absent: at 1,500 it lost a
     * reference on the known set (CI [-7.50, +0.00]).
     */
    stubWrites: boolean;
    stubEditChars: number | undefined;
    /** Backfill: judged-out segments come back while the budget has room. Optional; measured before any default. */
    backfill: boolean;
    backfillMin: number;
    backfillActiveReads: boolean;
    /**
     * Touched paths: every path a tool call named, listed after Pi's file lists (src/core/touched.ts).
     * On by default: known set +2 references at +2.6% tokens (CI [+0.00, +10.34]), win-rule set +4 at
     * +2.4% (CI [+0.00, +19.67]), references per 1K tokens up on both, no session lower.
     */
    touchedPaths: boolean;
    /** Also paths that ls/glob/find/grep results listed. Off: it lost one reference on each set (they crowd out the argument paths under the cap). */
    touchedListings: boolean;
  };
  render: { maxArgChars: number; maxArgCharsPinned: number; maxFileListEntries: number };
  eval: { sampleSize: number; recallMargin: number };
}

export type ConfigResult =
  | { ok: true; config: JevConfig; hash: string }
  | { ok: false; errors: string[] };

/**
 * Where compaction telemetry goes when the config itself cannot be loaded. It is
 * a failure-path invariant: the configured `telemetry.path` wins whenever the
 * config is valid.
 */
export const DEFAULT_TELEMETRY_DIR = '~/.local/state/jev';

/**
 * Where the base config comes from, most specific first:
 * 1. `JEV_CONFIG_PATH` when set to a non-blank value (operator override, resolved);
 * 2. `<repo>/config/jev.toml` when this file sits inside the source checkout at
 *    `<repo>/pi-jev/src/client/config.ts` (the monorepo layout, preserved exactly);
 * 3. otherwise the bundled `<package>/config/jev.toml` shipped beside this source
 *    tree (a standalone install of the published package).
 */
export function defaultConfigPath(): string {
  if (process.env.JEV_CONFIG_PATH && process.env.JEV_CONFIG_PATH.trim().length > 0) {
    return resolve(process.env.JEV_CONFIG_PATH.trim());
  }
  const monorepoConfig = resolve(dirname(fileURLToPath(import.meta.url)), '../../../config/jev.toml');
  if (existsSync(monorepoConfig)) return monorepoConfig;
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../config/jev.toml');
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

type Rule = { optional?: boolean } & (
  | { kind: 'int'; min: number; max: number }
  | { kind: 'num'; min: number; max: number; openMin?: boolean }
  | { kind: 'bool' }
  | { kind: 'model' }
  | { kind: 'backend' }
  | { kind: 'charter-backend' }
  | { kind: 'decisions-endpoint' }
  | { kind: 'decisions-model' }
  | { kind: 'env-name' }
  | { kind: 'local-endpoint' }
  | { kind: 'local-model' }
  | { kind: 'fallback' }
  | { kind: 'revision' }
  | { kind: 'path' }
  | { kind: 'schedule' }
  | { kind: 'pins' }
  | { kind: 'names' }
);

const SCHEMA: Record<string, Record<string, Rule>> = {
  api: {
    backend: { kind: 'backend', optional: true },
    charter_backend: { kind: 'charter-backend', optional: true },
    charter_replace_min: { kind: 'num', min: 0, max: 1, optional: true },
    charter_defers_max: { kind: 'num', min: 0, max: 1, optional: true },
    openai_decisions_endpoint: { kind: 'decisions-endpoint', optional: true },
    openai_decisions_model: { kind: 'decisions-model', optional: true },
    openai_decisions_key_env: { kind: 'env-name', optional: true },
    openai_decisions_timeout_ms: { kind: 'int', min: 1000, max: 900_000, optional: true },
    local_endpoint: { kind: 'local-endpoint', optional: true },
    local_model: { kind: 'local-model', optional: true },
    local_max_inflight: { kind: 'int', min: 1, max: 16, optional: true },
    local_timeout_ms: { kind: 'int', min: 1000, max: 900_000, optional: true },
    fallback: { kind: 'fallback', optional: true },
    local_revision: { kind: 'revision', optional: true },
    model: { kind: 'model' },
    timeout_ms: { kind: 'int', min: 1000, max: 120_000 },
    max_retries: { kind: 'int', min: 0, max: 10 },
    retry_backoff_ms: { kind: 'int', min: 0, max: 60_000 },
    retry_backoff_max_ms: { kind: 'int', min: 0, max: 120_000 },
    retry_jitter: { kind: 'num', min: 0, max: 1 },
    retry_budget_ms: { kind: 'int', min: 1000, max: 600_000 },
  },
  telemetry: { path: { kind: 'path' } },
  compaction: {
    enabled: { kind: 'bool' },
    max_share: { kind: 'num', min: 0, max: 1, openMin: true },
    max_after_share: { kind: 'num', min: 0, max: 1, openMin: true },
    keep_threshold: { kind: 'num', min: 0, max: 1, openMin: true },
    borderline: { kind: 'num', min: 0, max: 0.5 },
    threshold_schedule: { kind: 'schedule' },
    pins: { kind: 'pins' },
    modify_tools: { kind: 'names' },
    // Absent is valid: the loader fills the decision defaults below, so a config written
    // before these keys existed keeps working (spec: Part 1 item 6).
    decision_tools: { kind: 'names', optional: true },
    pin_generations: { kind: 'int', min: 1, max: 100 },
    decision_pin_generations: { kind: 'int', min: 1, max: 100, optional: true },
    decision_pin_max_chars: { kind: 'int', min: 1000, max: 1_000_000, optional: true },
    // Absent is valid: the loader fills the instruction defaults below. These keys, and
    // `instruction` in `pins`, are added to config/jev.toml only after every live session
    // has reloaded onto this code. The previous code rejects an unknown compaction key and
    // an unknown pin, and that rejection cancels the compaction (see prompt_timeout_ms).
    instruction_tools: { kind: 'names', optional: true },
    instruction_files: { kind: 'names', optional: true },
    instruction_paths: { kind: 'names', optional: true },
    instruction_follow_references: { kind: 'bool', optional: true },
    instruction_pin_generations: { kind: 'int', min: 1, max: 100, optional: true },
    instruction_pin_max_chars: { kind: 'int', min: 1000, max: 1_000_000, optional: true },
    truncate_head_chars: { kind: 'int', min: 0, max: 10_000 },
    max_state_tokens: { kind: 'int', min: 1000, max: 200_000 },
    max_request_tokens: { kind: 'int', min: 1000, max: 250_000 },
    // Absent is valid: RPC then cannot prompt and cancels like a headless run. The key
    // is added to config/jev.toml only in the follow-up commit that also removes [budget],
    // so this code and the previous code both accept the committed config during rollout.
    prompt_timeout_ms: { kind: 'int', min: 1000, max: 600_000, optional: true },
    charter: { kind: 'bool', optional: true },
    stub_writes: { kind: 'bool', optional: true },
    stub_edit_chars: { kind: 'int', min: 200, max: 1_000_000, optional: true },
    backfill: { kind: 'bool', optional: true },
    backfill_min: { kind: 'num', min: 0, max: 1, optional: true },
    backfill_active_reads: { kind: 'bool', optional: true },
    touched_paths: { kind: 'bool', optional: true },
    touched_listings: { kind: 'bool', optional: true },
  },
  render: {
    max_arg_chars: { kind: 'int', min: 20, max: 100_000 },
    max_arg_chars_pinned: { kind: 'int', min: 20, max: 1_000_000 },
    max_file_list_entries: { kind: 'int', min: 1, max: 10_000 },
  },
  eval: {
    sample_size: { kind: 'int', min: 10, max: 10_000 },
    recall_margin: { kind: 'num', min: 0, max: 0.5, openMin: true },
  },
};

const MODEL = /^jev-\d+\.\d+\.\d+$/;

/** Exact literals only: no DNS, URL normalization aliases, credentials or alternate routes. */
export function isLocalDecisionEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/v1\/systemone-local$/.exec(value);
  return match !== null && Number(match[1]) <= 65535;
}

/** Credential-bearing route: exact public endpoint or literal loopback test server only. */
export function isOpenAIDecisionsEndpoint(value: unknown): value is string {
  if (value === 'https://api.openai.com/v1/decisions') return true;
  if (typeof value !== 'string') return false;
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/v1\/decisions$/.exec(value);
  return match !== null && Number(match[1]) <= 65535;
}

export function effectiveAskerModel(config: JevConfig): string {
  if (config.api.backend !== 'local') return config.api.model;
  if (!['clm', 'openjev', 'anyjev'].includes(config.api.localModel ?? '')) throw new Error('Local decision model is not configured');
  return config.api.localModel!;
}

/** Filled in for an absent decision key (spec: Part 1 item 6), so old config files keep working. */
const DECISION_DEFAULTS = { tools: ['ask_user_question'], pinGenerations: 20, maxChars: 40_000 } as const;

/**
 * Filled in for an absent instruction key (spec: Part 3 item 2). `paths` is empty on purpose:
 * a host-specific prefix belongs in config/jev.toml, which is not changed until the class is
 * enabled. Basename, prompt and body matching work without it.
 */
const INSTRUCTION_DEFAULTS = {
  tools: ['read'],
  files: ['SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'INTENT.md'],
  paths: [] as string[],
  followReferences: true,
  pinGenerations: 20,
  maxChars: 60_000,
} as const;

/** smol-toml tables have a null prototype, so test the shape, not the prototype. */
function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function check(rule: Rule, value: unknown): boolean {
  switch (rule.kind) {
    case 'int':
      return Number.isInteger(value) && (value as number) >= rule.min && (value as number) <= rule.max;
    case 'num':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (rule.openMin ? value > rule.min : value >= rule.min) &&
        value <= rule.max
      );
    case 'bool':
      return typeof value === 'boolean';
    case 'model':
      return typeof value === 'string' && MODEL.test(value);
    case 'backend':
      return value === 'typesafe' || value === 'local';
    case 'charter-backend':
      return value === 'typesafe' || value === 'local' || value === 'openai-decisions';
    case 'decisions-endpoint':
      return isOpenAIDecisionsEndpoint(value);
    case 'decisions-model':
      return value === 'gpt-6-luna';
    case 'env-name':
      return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
    case 'local-endpoint':
      return isLocalDecisionEndpoint(value);
    case 'revision':
      return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
    case 'fallback':
      return value === 'typesafe' || value === 'none';
    case 'local-model':
      return value === 'clm' || value === 'openjev' || value === 'anyjev';
    case 'path':
      // Absolute or home-relative only: a relative path would follow each process's cwd,
      // splitting one day's spend across several ledgers.
      return typeof value === 'string' && (value.startsWith('/') || value.startsWith('~/'));
    case 'schedule':
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (v, i) => typeof v === 'number' && v > 0 && v <= 1 && (i === 0 || v > (value[i - 1] as number)),
        )
      );
    case 'pins':
      return (
        Array.isArray(value) &&
        value.every(v => (PIN_CLASSES as readonly unknown[]).includes(v)) &&
        new Set(value).size === value.length
      );
    case 'names':
      return (
        Array.isArray(value) &&
        value.every(v => typeof v === 'string' && v.trim().length > 0) &&
        new Set(value).size === value.length
      );
  }
}

/** Checks every section and key; errors name fields only, never their values. */
export function validateConfig(raw: unknown): { config?: JevConfig; errors: string[] } {
  if (!isTable(raw)) return { errors: ['(root)'] };
  const errors: string[] = [];
  for (const section of Object.keys(raw)) {
    // Transitional compatibility, one direction only. This code ignores a leftover
    // [budget] table, but the previous code REQUIRED it: without it the old extension
    // sees invalid config and falls back to Pi's summary on its own. So land the code
    // first, reload or restart every session, verify, and only then remove [budget]
    // from jev.toml.
    if (section === 'budget') continue;
    if (!Object.hasOwn(SCHEMA, section)) errors.push(`${section} (unknown)`);
  }
  for (const [section, rules] of Object.entries(SCHEMA)) {
    const table = raw[section];
    if (!isTable(table)) {
      errors.push(`${section} (missing)`);
      continue;
    }
    for (const key of Object.keys(table)) {
      if (!Object.hasOwn(rules, key)) errors.push(`${section}.${key} (unknown)`);
    }
    for (const [key, rule] of Object.entries(rules)) {
      if (!Object.hasOwn(table, key)) {
        if (rule.optional !== true) errors.push(`${section}.${key} (missing)`);
      } else if (!check(rule, table[key])) errors.push(`${section}.${key}`);
    }
  }
  if (isTable(raw.api) && (raw.api.backend === 'local' || raw.api.charter_backend === 'local')) {
    if (!Object.hasOwn(raw.api, 'local_endpoint')) errors.push('api.local_endpoint (required for local backend)');
    if (!Object.hasOwn(raw.api, 'local_model')) errors.push('api.local_model (required for local backend)');
  }
  if (isTable(raw.api) && raw.api.charter_backend === 'openai-decisions') {
    for (const key of ['openai_decisions_endpoint', 'openai_decisions_model', 'openai_decisions_key_env',
      'charter_replace_min', 'charter_defers_max']) {
      if (!Object.hasOwn(raw.api, key)) errors.push(`api.${key} (required for Decisions charter gate)`);
    }
  }
  if (errors.length > 0) return { errors };

  const get = (section: string, key: string): unknown => (raw[section] as Record<string, unknown>)[key];
  const num = (section: string, key: string): number => get(section, key) as number;
  const config: JevConfig = {
    api: {
      backend: (get('api', 'backend') as 'typesafe' | 'local' | undefined) ?? 'typesafe',
      ...(Object.hasOwn(raw.api as object, 'charter_replace_min') ? { charterReplaceMin: num('api', 'charter_replace_min') } : {}),
      ...(Object.hasOwn(raw.api as object, 'charter_defers_max') ? { charterDefersMax: num('api', 'charter_defers_max') } : {}),
      ...(Object.hasOwn(raw.api as object, 'charter_backend') ? { charterBackend: get('api', 'charter_backend') as JevConfig['api']['charterBackend'] } : {}),
      ...(Object.hasOwn(raw.api as object, 'openai_decisions_endpoint') ? { openaiDecisionsEndpoint: get('api', 'openai_decisions_endpoint') as string } : {}),
      ...(Object.hasOwn(raw.api as object, 'openai_decisions_model') ? { openaiDecisionsModel: get('api', 'openai_decisions_model') as 'gpt-6-luna' } : {}),
      ...(Object.hasOwn(raw.api as object, 'openai_decisions_key_env') ? { openaiDecisionsKeyEnv: get('api', 'openai_decisions_key_env') as string } : {}),
      ...(Object.hasOwn(raw.api as object, 'openai_decisions_timeout_ms') ? { openaiDecisionsTimeoutMs: get('api', 'openai_decisions_timeout_ms') as number } : {}),
      localEndpoint: get('api', 'local_endpoint') as string | undefined,
      localModel: get('api', 'local_model') as string | undefined,
      localMaxInflight: get('api', 'local_max_inflight') as number | undefined,
      localTimeoutMs: get('api', 'local_timeout_ms') as number | undefined,
      fallback: (get('api', 'fallback') as 'typesafe' | 'none' | undefined) ?? 'none',
      localRevision: get('api', 'local_revision') as string | undefined,
      model: get('api', 'model') as string,
      timeoutMs: num('api', 'timeout_ms'),
      maxRetries: num('api', 'max_retries'),
      retryBackoffMs: num('api', 'retry_backoff_ms'),
      retryBackoffMaxMs: num('api', 'retry_backoff_max_ms'),
      retryJitter: num('api', 'retry_jitter'),
      retryBudgetMs: num('api', 'retry_budget_ms'),
    },
    telemetry: { path: get('telemetry', 'path') as string },
    compaction: {
      enabled: get('compaction', 'enabled') as boolean,
      maxShare: num('compaction', 'max_share'),
      maxAfterShare: num('compaction', 'max_after_share'),
      keepThreshold: num('compaction', 'keep_threshold'),
      borderline: num('compaction', 'borderline'),
      thresholdSchedule: [...(get('compaction', 'threshold_schedule') as number[])],
      pins: [...(get('compaction', 'pins') as PinClass[])],
      modifyTools: [...(get('compaction', 'modify_tools') as string[])],
      decisionTools: [...((get('compaction', 'decision_tools') as string[] | undefined) ?? DECISION_DEFAULTS.tools)],
      pinGenerations: num('compaction', 'pin_generations'),
      decisionPinGenerations:
        (get('compaction', 'decision_pin_generations') as number | undefined) ?? DECISION_DEFAULTS.pinGenerations,
      decisionPinMaxChars: (get('compaction', 'decision_pin_max_chars') as number | undefined) ?? DECISION_DEFAULTS.maxChars,
      instructionTools: [...((get('compaction', 'instruction_tools') as string[] | undefined) ?? INSTRUCTION_DEFAULTS.tools)],
      instructionFiles: [...((get('compaction', 'instruction_files') as string[] | undefined) ?? INSTRUCTION_DEFAULTS.files)],
      instructionPaths: [...((get('compaction', 'instruction_paths') as string[] | undefined) ?? INSTRUCTION_DEFAULTS.paths)],
      instructionFollowReferences:
        (get('compaction', 'instruction_follow_references') as boolean | undefined) ?? INSTRUCTION_DEFAULTS.followReferences,
      instructionPinGenerations:
        (get('compaction', 'instruction_pin_generations') as number | undefined) ?? INSTRUCTION_DEFAULTS.pinGenerations,
      instructionPinMaxChars:
        (get('compaction', 'instruction_pin_max_chars') as number | undefined) ?? INSTRUCTION_DEFAULTS.maxChars,
      truncateHeadChars: num('compaction', 'truncate_head_chars'),
      maxStateTokens: num('compaction', 'max_state_tokens'),
      maxRequestTokens: num('compaction', 'max_request_tokens'),
      promptTimeoutMs: get('compaction', 'prompt_timeout_ms') as number | undefined,
      charter: (get('compaction', 'charter') as boolean | undefined) ?? true,
      stubWrites: (get('compaction', 'stub_writes') as boolean | undefined) ?? true,
      stubEditChars: get('compaction', 'stub_edit_chars') as number | undefined,
      backfill: (get('compaction', 'backfill') as boolean | undefined) ?? false,
      backfillMin: (get('compaction', 'backfill_min') as number | undefined) ?? 0,
      backfillActiveReads: (get('compaction', 'backfill_active_reads') as boolean | undefined) ?? false,
      touchedPaths: (get('compaction', 'touched_paths') as boolean | undefined) ?? true,
      touchedListings: (get('compaction', 'touched_listings') as boolean | undefined) ?? false,
    },
    render: {
      maxArgChars: num('render', 'max_arg_chars'),
      maxArgCharsPinned: num('render', 'max_arg_chars_pinned'),
      maxFileListEntries: num('render', 'max_file_list_entries'),
    },
    eval: { sampleSize: num('eval', 'sample_size'), recallMargin: num('eval', 'recall_margin') },
  };
  if (config.compaction.maxRequestTokens <= config.compaction.maxStateTokens) {
    errors.push('compaction.max_request_tokens (must exceed max_state_tokens)');
  }
  if (config.render.maxArgCharsPinned < config.render.maxArgChars) {
    errors.push('render.max_arg_chars_pinned (below max_arg_chars)');
  }
  return errors.length > 0 ? { errors } : { config, errors };
}

interface CacheEntry {
  path: string;
  text: string;
  result: ConfigResult;
}
let cache: CacheEntry | undefined;

/**
 * Reads the config at every call and re-validates it whenever its text changes
 * (spec G5). The file is a few hundred bytes, so keying on content costs nothing
 * and cannot miss an edit that keeps size and mtime. Any failure is a
 * `{ ok: false }` result, never a throw, and never falls back to an earlier
 * config: the caller treats it as a compaction failure (cancel or ask), not as
 * an `enabled = false` opt-out.
 */
/**
 * The overlay beside a config file: `jev.toml` -> `jev.overlay.toml`. Only this code reads it, so
 * keys that an older pi-jev still running in a live session would reject (it validates
 * `jev.toml` strictly and cancels the compaction on an unknown key) go here instead.
 */
export function overlayPath(path: string): string {
  return path.replace(/\.toml$/, '') + '.overlay.toml';
}

/**
 * The backend file beside a config file: `jev.toml` -> `jev.backend.toml`, merged after the
 * overlay. Only code with the local backend reads it, so the backend selection and its keys never
 * reach an older pi-jev that validates `jev.toml` and the overlay strictly.
 */
export function backendPath(path: string): string {
  return path.replace(/\.toml$/, '') + '.backend.toml';
}

/** Each table of the overlay replaces the same keys of the base's table. */
function mergeOverlay(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    merged[key] = isTable(current) && isTable(value) ? { ...current, ...value } : value;
  }
  return merged;
}

export function loadConfig(path: string = defaultConfigPath(), options: { backend?: boolean } = {}): ConfigResult {
  let base: string;
  try {
    base = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, errors: ['(file missing)'] };
  }
  let overlay = '';
  try {
    overlay = readFileSync(overlayPath(path), 'utf8');
  } catch {
    // No overlay: the base alone is the config.
  }
  let backend = '';
  try {
    // `backend: false` reads base and overlay only (the tests' view of the committed values).
    if (options.backend !== false) backend = readFileSync(backendPath(path), 'utf8');
  } catch {
    // No backend file: the established TypeSafe client.
  }
  // The cache covers every file; the fingerprint below exempts only new inert reference comments.
  const text = (overlay === '' ? base : `${base}\n# overlay\n${overlay}`) + (backend === '' ? '' : `\n# backend\n${backend}`);
  if (cache && cache.path === path && cache.text === text) return structuredClone(cache.result);
  // New inert backend reference comments must not perturb production provenance.
  // Keep legacy raw-text hashing everywhere else; the cache still uses full text.
  const fingerprintBackend = backend.replace(/^# decisions-reference:[^\n]*\n?/gm, '');
  const fingerprintText = (overlay === '' ? base : `${base}\n# overlay\n${overlay}`)
    + (fingerprintBackend === '' ? '' : `\n# backend\n${fingerprintBackend}`);
  let result: ConfigResult;
  try {
    const layered = overlay === '' ? parse(base) : mergeOverlay(parse(base), parse(overlay));
    const parsed = backend === '' ? layered : mergeOverlay(layered, parse(backend));
    const { config, errors } = validateConfig(parsed);
    result = config
      ? { ok: true, config, hash: createHash('sha256').update(fingerprintText).digest('hex').slice(0, 12) }
      : { ok: false, errors };
  } catch {
    result = { ok: false, errors: ['(syntax)'] };
  }
  cache = { path, text, result };
  return structuredClone(result);
}

/** The core's view of the config. The core itself never reads the config file. */
export function coreOptions(config: JevConfig): CoreOptions {
  const { compaction, render } = config;
  return {
    // Off here: only the Pi adapter, which has the branch to build the charter from, turns the
    // pool filter on, and only for a compaction whose charter was actually built.
    charter: false,
    stubWrites: compaction.stubWrites,
    backfill: compaction.backfill,
    backfillMin: compaction.backfillMin,
    backfillActiveReads: compaction.backfillActiveReads,
    ...(compaction.stubEditChars !== undefined ? { stubEditChars: compaction.stubEditChars } : {}),
    pins: new Set(compaction.pins),
    modifyTools: new Set(compaction.modifyTools),
    decisionTools: new Set(compaction.decisionTools),
    pinGenerations: compaction.pinGenerations,
    decisionPinGenerations: compaction.decisionPinGenerations,
    decisionPinMaxChars: compaction.decisionPinMaxChars,
    instructionTools: new Set(compaction.instructionTools),
    instructionFiles: new Set(compaction.instructionFiles),
    instructionPaths: [...compaction.instructionPaths],
    instructionFollowReferences: compaction.instructionFollowReferences,
    instructionPinGenerations: compaction.instructionPinGenerations,
    instructionPinMaxChars: compaction.instructionPinMaxChars,
    keepThreshold: compaction.keepThreshold,
    borderline: compaction.borderline,
    thresholdSchedule: [...compaction.thresholdSchedule],
    truncateHeadChars: compaction.truncateHeadChars,
    maxStateTokens: compaction.maxStateTokens,
    maxRequestTokens: compaction.maxRequestTokens,
    maxArgChars: render.maxArgChars,
    maxArgCharsPinned: render.maxArgCharsPinned,
    hash: text => createHash('sha256').update(text).digest('hex').slice(0, 12),
  };
}
