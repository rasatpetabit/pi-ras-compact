import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalDecisionClient } from '../src/client/local-client.js';
import { EXPAND_TOOL_NAME } from '../src/pi/expand-tool.js';
import { handleCompact, register, type HookResult } from '../src/pi/extension.js';
import { testConfig } from './support/config.js';
import { piCall, piCtx, piEvent, piUser, testDeps } from './support/pi-event.js';
import { scratchDir } from './support/scratch.js';

/**
 * Offline counterpart of a native compaction chain. `piEvent` is the hook's supported
 * `readInput` preparation seam. This file does not start Pi, does not drive an installed
 * SDK `session_before_compact`, and does not claim that preparation was produced by Pi.
 * Answers below are authored constants. They are not scores from the production judge.
 */

const T0 = '1970-01-01T00:00:00.000Z';
const INSTRUCTION = 'Bind the relay to 127.0.0.1 only, and never treat a failed question as approval.';
const CONTINUE = 'Continue the relay work without widening the bind address.';
const ANSWERED_Q = 'Which port should the relay bind?';
const ANSWERED_A = 'User answered: 127.0.0.1:18443 only';
const ERRORED_Q = 'Delete the production database now?';
const ERRORED_A = 'ask_user_question is not available in this mode';
const EMPTY_Q = 'Which retry budget should the relay use?';
const WRITE_TOKEN = 'HISTORICAL_WRITE_BYTES_7c2e';
const RESULT_TOKEN = 'HISTORICAL_RESULT_BYTES_4ab1';
const DROPPED = 'UNRELATED_DROPPED_9e0d';
const OPAQUE = 'OPAQUE_PREVIOUS_SUMMARY_MUST_NOT_RENDER';
const REVISION = 'fixture-rev-20261112';
const WRITE_BODY = [
  'export function bindRelay() {',
  '  // historical module kept for the relay',
  '  const host = "127.0.0.1";',
  '  const port = 18443;',
  '  return { host, port };',
  '}',
  `// ${WRITE_TOKEN}`,
  ...Array.from({ length: 12 }, (_, i) => `// pad ${i} the body must exceed the stub threshold`),
].join('\n');
const RESULT = `DIAG_HEAD relay socket table\n${'row\n'.repeat(110)}${RESULT_TOKEN}\n`;
const DROPPED_BODY = `${DROPPED}\n${'noise\n'.repeat(4)}${DROPPED}`;

/** Authored distribution for a five-level staleness score. Not derived at runtime. */
const STALE = {
  type: 'score',
  score: 4,
  confidence: 1,
  probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 },
} as const;

const entry = (id: string, message: unknown) => ({ type: 'message', id, parentId: null, timestamp: T0, message });
const compactionOf = (result: HookResult) => {
  assert.ok(result && 'compaction' in result, `expected a compaction, got ${JSON.stringify(result)}`);
  return result.compaction;
};

function fixedReply(body: string): string {
  const req = JSON.parse(body) as {
    model: string;
    questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, unknown> | unknown[] }>;
  };
  const dropAll = new Set<string>();
  const dropResult = new Set<string>();
  for (const [id, question] of Object.entries(req.questions)) {
    const suffix = id.split('_').slice(1).join('_');
    const instructions = question.instructions ?? '';
    if (instructions.includes(DROPPED)) dropAll.add(suffix);
    else if (instructions.includes(RESULT_TOKEN)) dropResult.add(suffix);
  }
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    const suffix = id.split('_').slice(1).join('_');
    if (question.type === 'noul') {
      const noul = dropAll.has(suffix) || (dropResult.has(suffix) && id.startsWith('result_')) ? 0 : 1;
      answers[id] = { type: 'noul', noul };
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length !== 5) throw new Error(`unexpected score shape for ${id}`);
      answers[id] = STALE;
    } else if (question.type === 'choice' && question.criteria && !Array.isArray(question.criteria)) {
      const labels = Object.keys(question.criteria);
      if (labels.length < 2) throw new Error(`unexpected choice shape for ${id}`);
      const choice = labels.includes('none') ? 'none' : labels[0]!;
      answers[id] = {
        type: 'choice',
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? 1 : 0])),
      };
    } else {
      throw new Error(`unexpected question ${id}`);
    }
  }
  return JSON.stringify({ model: req.model, revision: REVISION, answers });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function loopback(handler: (body: string, res: ServerResponse) => void) {
  const server = createServer(async (req, res) => {
    try {
      handler(await readBody(req), res);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'stub failed');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone-local`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function withLoopbackOnly(fn: () => Promise<void>): Promise<string[]> {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    let host = '';
    try { host = new URL(url).hostname; } catch { host = 'unparsed'; }
    if (host !== '127.0.0.1') throw new Error(`refusing non-loopback fetch (${host})`);
    return real(input, init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return urls;
}

function facts(summary: string, stats: { answered: number; said: number }, said: number) {
  const charter = summary.split('## Why the current work')[0] ?? summary;
  assert.equal(charter.split(INSTRUCTION).length - 1, 1, 'the charter carries the operator instruction once');
  assert.equal(summary.split(`Q: ${ANSWERED_Q}\nA: ${ANSWERED_A}`).length - 1, 1, 'the answered round appears once');
  assert.ok(summary.includes(ERRORED_Q), 'the errored question stays visible');
  assert.ok(summary.includes(ERRORED_A), 'the error result stays visible');
  assert.equal(summary.includes(`Q: ${ERRORED_Q}\nA:`), false, 'a failed question is not an approval');
  assert.equal(summary.includes(`A: ${ERRORED_A}`), false, 'the error text is not an answer line');
  assert.ok(summary.includes(EMPTY_Q), 'the empty round stays visible');
  assert.equal(summary.includes(`Q: ${EMPTY_Q}\nA:`), false, 'an empty round is not an approval');
  assert.equal(summary.includes(DROPPED), false, 'dropped content is not rendered');
  assert.equal(summary.includes(WRITE_TOKEN), false, 'the write stub is not the historical body');
  assert.equal(summary.includes(RESULT_TOKEN), false, 'the truncated result is not the historical bytes');
  assert.match(summary, /jev_expand\("writeBind", part="input"\)/);
  assert.match(summary, /jev_expand\("keepDiag"\)/);
  assert.equal(/jev_expand\("dropNoise"/.test(summary), false, 'the dropped call is not a recovery id');
  assert.equal(stats.answered, 1);
  assert.equal(stats.said, said);
}

test('two compactions through a loopback LocalDecisionClient keep failed questions and restore exact bytes', async () => {
  assert.ok(WRITE_BODY.length > 400);
  assert.ok(RESULT.length > 420);
  const span = [
    piUser(INSTRUCTION),
    ...piCall('askOk', 'ask_user_question', { questions: [{ question: ANSWERED_Q }] }, ANSWERED_A),
    ...piCall('askErr', 'ask_user_question', { questions: [{ question: ERRORED_Q }] }, ERRORED_A, true),
    ...piCall('askEmpty', 'ask_user_question', { questions: [{ question: EMPTY_Q }] }, ''),
    ...piCall('writeBind', 'write', { path: 'src/relay/bind.ts', content: WRITE_BODY }, 'Wrote the relay bind module.'),
    ...piCall('keepDiag', 'read', { path: 'diag/relay.txt' }, RESULT),
    ...piCall('dropNoise', 'read', { path: 'tmp/noise.txt' }, DROPPED_BODY),
    { role: 'assistant', content: [{ type: 'text', text: 'The bind module is written. Keep the diagnostic read.' }], timestamp: 0 },
  ];
  const branch = span.map((message, i) => entry(`g1-${i}`, message));
  const stub = await loopback((body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(fixedReply(body));
  });
  const urls = await withLoopbackOnly(async () => {
    const config = testConfig(c => {
      c.compaction.maxAfterShare = 0.5;
      c.compaction.charter = true;
      c.compaction.stubWrites = true;
      c.api.backend = 'local';
      c.api.localModel = 'openjev';
      c.api.localEndpoint = stub.url;
      c.api.localRevision = REVISION;
      c.api.fallback = 'none';
      c.api.maxRetries = 0;
      c.api.timeoutMs = 5000;
      c.api.retryBudgetMs = 5000;
      c.api.localTimeoutMs = 5000;
    });
    const deps = testDeps({
      config,
      now: () => 0,
      makeAsker: (c, hash, signal, context) => new LocalDecisionClient({ config: c, configHash: hash, caller: 'compact-boundary', context }, signal),
    });
    try {
      const first = compactionOf(await handleCompact(
        piEvent({ branchEntries: branch, preparation: { messagesToSummarize: span } }),
        piCtx(),
        deps,
      ));
      facts(first.summary, first.details.jev.charter_stats, 1);
      assert.equal(JSON.stringify(first.details.jev.carry).includes(DROPPED), false, 'the dropped read is not in the carry');
      assert.equal(first.details.jev.backend, 'local');
      assert.equal(first.details.jev.fallback_from, undefined);

      const file = join(scratchDir('jev-boundary-'), 'gen1.json');
      writeFileSync(file, JSON.stringify({
        type: 'compaction',
        id: 'c-gen1',
        parentId: null,
        timestamp: T0,
        fromHook: true,
        summary: first.summary,
        firstKeptEntryId: first.firstKeptEntryId,
        tokensBefore: first.tokensBefore,
        details: first.details,
      }));
      const persisted = JSON.parse(readFileSync(file, 'utf8')) as {
        summary: string;
        details: { jev: { carry: unknown } };
      };
      assert.equal(persisted.summary, first.summary);
      assert.equal(JSON.stringify(persisted.details.jev.carry).includes(DROPPED), false);

      const next = [piUser(CONTINUE)];
      const secondEvent = piEvent({
        branchEntries: [...branch, persisted, ...next.map((message, i) => entry(`g2-${i}`, message))],
        preparation: { messagesToSummarize: next, previousSummary: OPAQUE },
      });
      const second = compactionOf(await handleCompact(secondEvent, piCtx(), deps));
      facts(second.summary, second.details.jev.charter_stats, 2);
      assert.ok(second.summary.includes(CONTINUE), 'the new instruction is carried');
      assert.equal(second.summary.includes(OPAQUE), false, 'the reloaded structured carry is used, not the opaque summary');
      assert.equal(JSON.stringify(second.details.jev.carry).includes(DROPPED), false, 'dropped content does not return in the next carry');
      assert.equal(second.details.jev.backend, 'local');

      const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { ok: boolean } }> }> = [];
      register({ on: () => {}, appendEntry: () => {}, registerEntryRenderer: () => {}, registerTool: (tool: never) => void tools.push(tool) } as never, deps);
      const tool = tools.find(candidate => candidate.name === EXPAND_TOOL_NAME);
      assert.ok(tool, 'jev_expand is the registered public tool');
      const expandCtx = { sessionManager: { getBranch: () => secondEvent.branchEntries } };
      const written = await tool.execute('expand-write', { id: 'writeBind', part: 'input' }, undefined, undefined, expandCtx);
      assert.equal(written.details.ok, true);
      assert.ok(written.content[0]!.text.endsWith(`\n\n${WRITE_BODY}`), 'write bytes restore exactly');
      const diagnosed = await tool.execute('expand-result', { id: 'keepDiag' }, undefined, undefined, expandCtx);
      assert.equal(diagnosed.details.ok, true);
      assert.ok(diagnosed.content[0]!.text.endsWith(`\n\n${RESULT}`), 'result bytes restore exactly');
      const answered = await tool.execute('expand-answer', { id: 'a:askOk' }, undefined, undefined, expandCtx);
      assert.equal(answered.details.ok, true);
      assert.ok(answered.content[0]!.text.endsWith(`\n\n${ANSWERED_A}`));
    } finally {
      await stub.close();
    }
  });
  assert.ok(urls.length > 0, 'the client reached the loopback service');
  assert.ok(urls.every(url => url === stub.url), `fetch left the stub: ${urls.join(' ')}`);
});
