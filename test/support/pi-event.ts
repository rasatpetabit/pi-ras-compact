import { join } from 'node:path';
import type { JevConfig } from '../../src/client/config.js';
import { compactSpan } from '../../src/core/prune.js';
import type { Deps, HookContext } from '../../src/pi/extension.js';
import { testConfig } from './config.js';
import { allOnes, FakeAsker } from './fake-asker.js';
import { fakeEstimator } from './estimator.js';
import { scratchDir } from './scratch.js';

export const TEST_MODEL = { provider: 'test-provider', id: 'test-model' };

export const piUser = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 });
export const piCall = (id: string, name: string, args: Record<string, unknown>, result: string, isError = false) => [
  { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], timestamp: 0 },
  { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text: result }], isError, timestamp: 0 },
];

export const SPAN = [
  piUser('Fix the failing auth test in src/auth/session.ts.'),
  ...piCall('t1', 'read', { path: 'src/auth/session.ts' }, 'line\n'.repeat(400)),
  ...piCall('t2', 'bash', { command: 'npm test -- auth' }, 'FAIL session.test.ts: TypeError at session.ts:88', true),
  ...piCall('t3', 'edit', { path: 'src/auth/session.ts', edits: [{ oldText: 'token.expiresAt', newText: 'token?.expiresAt' }] }, 'Applied 1 edit'),
];

const T0 = '1970-01-01T00:00:00.000Z';

export const piAssistantEntry = (id: string, parentId: string | null, tokens: number) => ({
  type: 'message',
  id,
  parentId,
  timestamp: T0,
  tokens,
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 },
    stopReason: 'stop',
    timestamp: 0,
  },
});

/** Every array branch ends with this: the compactable span's cost on a response from the current model, then the kept turn. With fakeEstimator at 120,000 tokens before: E = 105,000, O = 15,000, F = 20,000, A = 67,500, room 47,500. */
export const BRANCH_TAIL = [
  piAssistantEntry('a0', null, 100_000),
  { type: 'message', id: 'keep-1', parentId: 'a0', timestamp: T0, tokens: 5_000, message: piUser('Continue.') },
];

export function piEvent(patch: { preparation?: Record<string, unknown>; [key: string]: unknown } = {}) {
  const { preparation, ...rest } = patch;
  const given = (rest as { branchEntries?: unknown }).branchEntries;
  const branchEntries = Array.isArray(given) ? [...given, ...BRANCH_TAIL] : given === undefined ? [...BRANCH_TAIL] : given;
  return {
    type: 'session_before_compact',
    preparation: {
      firstKeptEntryId: 'keep-1',
      tokensBefore: 120_000,
      messagesToSummarize: SPAN,
      turnPrefixMessages: [],
      isSplitTurn: false,
      previousSummary: undefined as string | undefined,
      fileOps: { read: new Set(['src/auth/token.ts']), written: new Set<string>(), edited: new Set(['src/auth/session.ts']) },
      settings: { enabled: true, reserveTokens: 50_000, keepRecentTokens: 20_000 },
      ...preparation,
    },
    reason: 'manual',
    willRetry: false,
    signal: new AbortController().signal,
    ...rest,
    branchEntries,
  };
}

export function piCtx(
  notes: string[] = [],
  contextWindow = 1_048_576,
  status: Map<string, string | undefined> = new Map(),
  opts: {
    mode?: string;
    hasUI?: boolean;
    select?: (title: string, options: string[], dialog?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
  } = {},
): HookContext {
  return {
    model: { contextWindow, provider: TEST_MODEL.provider, id: TEST_MODEL.id },
    mode: opts.mode,
    hasUI: opts.hasUI,
    ui: {
      notify: message => void notes.push(message),
      setStatus: (key, text) => void status.set(key, text),
      ...(opts.select ? { select: opts.select } : {}),
    },
  };
}

export function testDeps(patch: Partial<Deps> & { config?: JevConfig } = {}): Deps & { config: JevConfig } {
  const { config: given, ...rest } = patch;
  // An explicit share, so the budget arithmetic in the tests does not move when the committed
  // config is retuned.
  const config = given ?? testConfig(c => { c.compaction.maxAfterShare = 0.5; });
  return {
    loadConfig: () => ({ ok: true, config, hash: 'feedc0ffee00' }),
    makeAsker: () => new FakeAsker(allOnes),
    estimator: async () => fakeEstimator(),
    compact: compactSpan,
    notified: new Set(),
    fallbackLogDir: scratchDir('jev-fallback-log-'),
    now: Date.now,
    stderr: () => {},
    ...rest,
    config,
  };
}
