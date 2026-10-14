import { rebuildCharterPrefix, readCharterRecords } from '../src/core/charter-records.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfigPath, loadConfig } from '../src/client/config.js';
import { CHARTER_HEADER } from '../src/core/charter.js';
import { handleCompact, register, runCompactionPass, type HookResult } from '../src/pi/extension.js';
import { JevError } from '../src/client/jev-client.js';
import { EXPAND_TOOL_NAME } from '../src/pi/expand-tool.js';
import { allZero, FakeAsker } from './support/fake-asker.js';
import { testConfig } from './support/config.js';
import { piCtx, piEvent, piUser, testDeps } from './support/pi-event.js';

const compactionOf = (result: HookResult) => {
  assert.ok(result && 'compaction' in result, `expected a compaction, got ${JSON.stringify(result)}`);
  return result.compaction;
};
const T0 = '1970-01-01T00:00:00.000Z';
const entry = (id: string, message: unknown) => ({ type: 'message', id, parentId: null, timestamp: T0, message });
const RULE = 'Never use node-a, node-b or gpu-node-3 as dev fallbacks; the primary build VM only.';
const ASK = 'Fix the failing auth test in src/auth/session.ts.';
const PASTED = Array.from({ length: 14 }, (_, i) => `2026-09-29T10:${String(i).padStart(2, '0')}:00Z ERROR worker ${i} crashed`).join('\n');
const branch = [
  entry('u0', piUser(RULE)),
  { type: 'compaction', id: 'c1', parentId: null, timestamp: T0, summary: 'an older Pi summary that lost the rule', firstKeptEntryId: 'u1', tokensBefore: 1 },
  entry('u1', piUser(`${ASK}\nHere is the log:\n${PASTED}\nstill failing`)),
  entry('q', { role: 'assistant', content: [{ type: 'toolCall', id: 'ask1', name: 'ask_user_question', arguments: { questions: [{ question: 'Which branch?' }] } }], timestamp: 0 }),
  entry('qr', { role: 'toolResult', toolCallId: 'ask1', toolName: 'ask_user_question', content: [{ type: 'text', text: 'User answered: main' }], isError: false, timestamp: 0 }),
];
const charterOn = () => testDeps({ config: testConfig(c => { c.compaction.maxAfterShare = 0.5; c.compaction.charter = true; }) });

test('the committed config leaves the charter on by default', () => {
  const loaded = loadConfig(defaultConfigPath());
  assert.ok(loaded.ok);
  assert.equal(loaded.config.compaction.charter, true);
  assert.equal(loaded.config.compaction.stubWrites, true, 'stubbing pinned writes is on by default');
  assert.equal(loaded.config.compaction.stubEditChars, undefined, 'stubbing large edits stays off');
  assert.equal(loaded.config.compaction.touchedPaths, true, 'touched paths are listed by default');
  assert.equal(loaded.config.compaction.backfill, false, 'backfill stays off: +70% tokens for 10 references');
});

test('the charter carries every operator message and answer before the compaction point, verbatim, however old', async () => {
  const deps = charterOn();
  const c = compactionOf(await handleCompact(piEvent({ branchEntries: branch }), piCtx(), deps));
  assert.ok(c.summary.startsWith(CHARTER_HEADER));
  assert.ok(c.summary.includes(RULE), 'a message from before an earlier compaction is still there');
  assert.ok(c.summary.includes(`${ASK}\nHere is the log:\n[pasted log: 14 lines`));
  assert.ok(c.summary.includes('\nstill failing'));
  assert.ok(!c.summary.includes('worker 3 crashed'), 'the pasted log is a marker');
  assert.ok(c.summary.includes('Q: Which branch?\nA: User answered: main'));
  assert.ok(!c.summary.includes('Continue.'), 'the kept tail is not charter');
  assert.equal(c.summary.split(ASK).length - 1, 1, 'operator text appears once: the pool does not repeat it');
  assert.deepEqual(c.details.jev.charter, { version: 1, retired: {} });
  const savedRecords = readCharterRecords(c.details.jev.charter_records, c.summary);
  assert.ok(savedRecords);
  assert.equal(savedRecords.entries.length, 3);
  assert.equal(rebuildCharterPrefix(c.details.jev.charter_records, c.summary), c.summary.slice(0, c.summary.indexOf('<compacted-conversation>')));
  assert.equal(c.details.jev.charter_stats.said, 2);
  assert.equal(c.details.jev.charter_stats.answered, 1);
  assert.equal(c.details.jev.charter_stats.pasted, 1);
});

test('the judge reads the same conversation with the charter on as off: operator messages stay in its view', async () => {
  // Regression (win-rule set, 2026-09-30): taking operator messages out of the pool also took them
  // out of the judge's state, and the judge kept less of what the work needed.
  const pool = (a: FakeAsker) => a.requests.filter(r => Object.keys(r.questions).every(n => /^(call|result|staleness|keep)_/.test(n)));
  const off = new FakeAsker();
  const on = new FakeAsker();
  compactionOf(await handleCompact(piEvent({ branchEntries: branch }), piCtx(), testDeps({ config: testConfig(c => { c.compaction.maxAfterShare = 0.5; }), makeAsker: () => off })));
  const c = compactionOf(await handleCompact(piEvent({ branchEntries: branch }), piCtx(), testDeps({ config: testConfig(c => { c.compaction.maxAfterShare = 0.5; c.compaction.charter = true; }), makeAsker: () => on })));
  assert.ok(pool(off).length > 0, 'the pool was judged');
  assert.deepEqual(pool(on).map(r => r.state), pool(off).map(r => r.state));
  assert.ok(JSON.stringify(pool(on)[0]!.state).includes(ASK), 'the judge sees what the operator asked');
  assert.equal(c.summary.split(ASK).length - 1, 1, 'the operator message is rendered once, in the charter');
});

test('when the judge drops everything, the operator messages still survive', async () => {
  const deps = testDeps({ config: testConfig(c => { c.compaction.maxAfterShare = 0.5; c.compaction.charter = true; }), makeAsker: () => new FakeAsker(allZero) });
  const c = compactionOf(await handleCompact(piEvent({ branchEntries: branch }), piCtx(), deps));
  assert.ok(c.summary.includes(RULE));
  assert.ok(c.summary.includes(ASK));
});

test('with the charter off the summary is as before: no charter, operator text in the pool', async () => {
  const deps = testDeps();
  const c = compactionOf(await handleCompact(piEvent({ branchEntries: branch }), piCtx(), deps));
  assert.ok(!c.summary.includes(CHARTER_HEADER));
  assert.ok(!c.summary.includes(RULE));
  assert.ok(c.summary.includes(ASK));
  assert.equal(c.details.jev.charter, undefined);
  assert.equal(c.details.jev.charter_records, undefined);
});

test('a stub carried from before the id existed keeps the old advice', async () => {
  const { truncatedResult } = await import('../src/core/render.js');
  assert.match(truncatedResult('x'.repeat(1000), false, 300), /re-run the tool if needed\]$/);
  assert.match(truncatedResult('x'.repeat(1000), true, 300, 't9'), /\(error\); jev_expand\("t9"\) restores it exactly\]$/);
});

test('jev_expand is registered and restores the exact pasted bytes and tool results from the branch', async () => {
  const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { ok: boolean } }> }> = [];
  const fake = { on: () => {}, appendEntry: () => {}, registerEntryRenderer: () => {}, registerTool: (t: never) => void tools.push(t) };
  register(fake as never, testDeps());
  const tool = tools.find(t => t.name === EXPAND_TOOL_NAME);
  assert.ok(tool);
  const text = `${ASK}\nHere is the log:\n${PASTED}\nstill failing`;
  const start = text.indexOf(PASTED);
  const ctx = { sessionManager: { getBranch: () => branch } };
  const pasted = await tool.execute('call', { id: 'u:u1', offset: start, limit: PASTED.length }, undefined, undefined, ctx);
  assert.ok(pasted.details.ok);
  assert.ok(pasted.content[0]!.text.endsWith(`\n\n${PASTED}`));
  assert.match(pasted.content[0]!.text, /^Historical snapshot/);
  const answer = await tool.execute('call', { id: 'a:ask1' }, undefined, undefined, ctx);
  assert.ok(answer.content[0]!.text.endsWith('\n\nUser answered: main'));
  const missing = await tool.execute('call', { id: 'nope' }, undefined, undefined, ctx);
  assert.equal(missing.details.ok, false);
  const badPart = await tool.execute('call', { id: 'ask1', part: 'x' }, undefined, undefined, ctx);
  assert.equal(badPart.details.ok, false);
});

test('a confirmed correction retires the earlier entry; the chain names the request the work serves', async () => {
  const STEP = 'I am patching session.ts to guard token.expiresAt, because the failing auth test dereferences an expired token.';
  const corrected = [
    ...branch,
    entry('a1', { role: 'assistant', content: [{ type: 'text', text: `Short.\n\n${STEP}` }], timestamp: 0 }),
    entry('u2', piUser('Correction: node-b is fine for builds after all.')),
  ];
  const pick = (criteria: Record<string, string | null>, needle: string, p: number) => {
    const label = Object.entries(criteria).find(([, v]) => typeof v === 'string' && v.includes(needle))?.[0] ?? 'none';
    return { choice: label, confidence: p, probabilities: { [label]: p } };
  };
  const asker = {
    async ask(state: { new_operator_message?: string }, questions: Record<string, { type: string; criteria?: Record<string, string | null> }>) {
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) {
        // Only the correcting message names the rule it corrects.
        if (id === 'corrects') answers[id] = String(state.new_operator_message).startsWith('Correction') ? pick(q.criteria!, 'Never use node-a', 0.95) : { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } };
        else if (id === 'still_applies') answers[id] = { noul: 0.02 };
        else if (id === 'serves') answers[id] = pick(q.criteria!, 'Fix the failing auth test', 0.9);
        else if (id === 'step') answers[id] = pick(q.criteria!, 'guard token.expiresAt', 0.9);
        else if (id.startsWith('done_')) answers[id] = { noul: 0.1 };
        else answers[id] = id.startsWith('staleness_') ? { score: 0, confidence: 1, probabilities: {} } : { noul: 1 };
      }
      return { answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
  const deps = testDeps({ config: testConfig(c => { c.compaction.maxAfterShare = 0.5; c.compaction.charter = true; }), makeAsker: () => asker as never });
  const c = compactionOf(await handleCompact(piEvent({ branchEntries: corrected }), piCtx(), deps));
  assert.deepEqual(c.details.jev.charter.retired, { 'u:u0': { reason: 'corrected', by: 'u:u2', gen: 1 } });
  const charterPart = c.summary.slice(0, c.summary.indexOf('## Why the current work'));
  // Retired as corrected, the earlier entry stays as verbatim history before its correction
  // (keep-corrected rendering); only dropped/done/superseded are omitted.
  assert.ok(charterPart.includes(`[operator u:u0]\n${RULE}\n`), 'the corrected rule stays visible with its id');
  assert.ok(charterPart.indexOf(RULE) < charterPart.indexOf('Correction: node-b is fine'));
  assert.ok(!charterPart.includes('earlier entry was retired'), 'nothing omitted, so no notice');
  assert.ok(c.summary.includes('Current work serves the operator request [u:u1]'));
  assert.ok(c.summary.includes(`(compaction 1) ${STEP}`));
  assert.equal(c.details.jev.chain.current, 'u:u1');
});

test('runCompactionPass carries a singleton chain with local-client choice validation', async () => {
  const STEP = 'I am patching session.ts to guard token.expiresAt, because the failing auth test dereferences an expired token.';
  const messages = [
    entry('u1', piUser(ASK)),
    entry('a1', { role: 'assistant', content: [{ type: 'text', text: STEP }], timestamp: 0 }),
  ];
  const fake = new FakeAsker();
  const deps = testDeps({
    config: testConfig(c => { c.compaction.maxAfterShare = 0.5; c.compaction.charter = true; }),
    makeAsker: () => ({
      async ask(state, questions) {
        if (Object.values(questions).some(q => q.type === 'choice' && Object.keys(q.criteria).length < 2)) {
          throw new JevError('parse', 'Local decision questions are invalid');
        }
        return fake.ask(state, questions);
      },
    }),
  });
  const pass = await runCompactionPass(piEvent({ branchEntries: messages }), piCtx(), deps, undefined, 'singleton-test');
  assert.ok(pass.ok);
  const c = pass.result.compaction;
  assert.equal(c.details.jev.chain.current, 'u:u1');
  assert.equal(c.details.jev.chain.branches[0]!.steps.length, 1);
  assert.equal(c.details.jev.chain.branches[0]!.steps[0]!.text, STEP);
  assert.ok(c.summary.includes(`(compaction 1) ${STEP}`));
  assert.ok(fake.asked.flat().every(id => id !== 'serves' && id !== 'step'), 'singleton chain choices never reach the client');
});

test('a correction without the confirming no retires nothing', async () => {
  const corrected = [...branch, entry('u2', piUser('Correction: node-b is fine for builds after all.'))];
  const asker = {
    async ask(_s: unknown, questions: Record<string, { criteria?: Record<string, string | null> }>) {
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (id === 'corrects') {
          const label = Object.entries(q.criteria!).find(([, v]) => typeof v === 'string' && v.includes('Never use node-a'))![0];
          answers[id] = { choice: label, confidence: 0.99, probabilities: { [label]: 0.99 } };
        } else if (id === 'still_applies') answers[id] = { noul: 0.5 };
        else answers[id] = { noul: 1 };
      }
      return { answers };
    },
  };
  const deps = testDeps({ config: testConfig(c => { c.compaction.maxAfterShare = 0.5; c.compaction.charter = true; }), makeAsker: () => asker as never });
  const c = compactionOf(await handleCompact(piEvent({ branchEntries: corrected }), piCtx(), deps));
  assert.deepEqual(c.details.jev.charter.retired, {});
  assert.ok(c.summary.includes(RULE));
});

test('jev_expand says whether the file a call named still matches on disk', async () => {
  const { fileNote } = await import('../src/pi/expand-tool.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'jev-note-'));
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  assert.match(fileNote('write', { path: 'a.ts', content: 'export const a = 1;\n' }, 'ok', dir)!, /still matches/);
  assert.match(fileNote('write', { path: 'a.ts', content: 'export const a = 2;\n' }, 'ok', dir)!, /has changed/);
  assert.match(fileNote('read', { path: join(dir, 'a.ts') }, 'export const a = 1;', undefined)!, /still matches/);
  assert.match(fileNote('read', { path: 'gone.ts' }, 'x', dir)!, /no longer exists/);
  assert.equal(fileNote('bash', { command: 'ls' }, 'x', dir), undefined);
});

test('a charter larger than half the window is still carried whole; nothing is cut to fit', async () => {
  const huge = 'Keep this rule in mind at all times while you work on the repository. '.repeat(400);
  const big = [entry('u0', piUser(huge)), ...branch.slice(1)];
  const deps = charterOn();
  const result = await handleCompact(piEvent({ branchEntries: big }), piCtx([], 12_000), deps);
  const small = compactionOf(result);
  assert.ok(small.summary.startsWith(CHARTER_HEADER));
  assert.ok(small.summary.includes(huge.trim()));
  const ok = compactionOf(await handleCompact(piEvent({ branchEntries: big }), piCtx(), charterOn()));
  assert.ok(ok.summary.startsWith(CHARTER_HEADER), 'the same charter fits a 1M window and is carried whole');
  assert.ok(ok.summary.includes(huge.trim()));
});
