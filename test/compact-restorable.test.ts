import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { flushTelemetry } from '../src/client/ledger.js';
import { CHARTER_HEADER } from '../src/core/charter.js';
import { expand, EXPAND_DEFAULT_LIMIT, EXPAND_MAX_LIMIT } from '../src/core/expand.js';
import { compactSpan } from '../src/core/prune.js';
import { renderSegment, stubCounts } from '../src/core/render.js';
import { PENDING_RESULT } from '../src/core/segments.js';
import { branchMessages } from '../src/pi/branch.js';
import { EXPAND_TOOL_NAME, fileNote } from '../src/pi/expand-tool.js';
import { handleCompact, register, type HookResult } from '../src/pi/extension.js';
import { entryMarker, markerFor, markerLines } from '../src/pi/marker.js';
import { testConfig } from './support/config.js';
import { allOnes, allZero, FakeAsker } from './support/fake-asker.js';
import { piAssistantEntry, piCtx, piEvent, piUser, testDeps } from './support/pi-event.js';

const T0 = '1970-01-01T00:00:00.000Z';
const h = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const entry = (id: string, message: unknown) => ({ type: 'message', id, parentId: null, timestamp: T0, message });

const compactionOf = (result: HookResult) => {
  assert.ok(result && 'compaction' in result, `expected a compaction, got ${JSON.stringify(result)}`);
  return result.compaction;
};

// ---------------------------------------------------------------------------------------------
// Suite 1: Full-Spectrum End-to-End Compaction Restorable Elements
// ---------------------------------------------------------------------------------------------

test('all restorable elements generated in end-to-end /compact resolve byte-exact via jev_expand', async () => {
  const logBlock = Array.from({ length: 15 }, (_, i) =>
    `2026-10-05T12:${String(i).padStart(2, '0')}:00.000Z ERROR worker ${i} crashed with exit code 1`).join('\n');
  const skillBlock = '<skill name="deploy">\nCheck branch status.\nRun tests.\nDeploy to production.\n</skill>';
  const toolResultToEcho = 'DIAGNOSTIC_OUTPUT_HEAD:\n' + 'line of diagnostic data\n'.repeat(50) + 'END_DIAGNOSTIC';
  const writeBody = 'export const serverConfig = {\n' + '  port: 8080,\n  timeoutMs: 30000,\n'.repeat(25) + '};\n';
  const editArgs = {
    path: 'src/server.ts',
    edits: Array.from({ length: 10 }, (_, i) => ({
      oldText: `// block_${i}\nconst x_${i} = ${i};\n`,
      newText: `// block_${i}_updated\nconst x_${i} = ${i * 10};\n`,
    })),
  };
  const longPath = 'src/nested/modules/services/controllers/internal/handlers/' + 'p'.repeat(180) + '/service.ts';
  const truncatedResultText = 'RESULT_HEAD\n' + 'very large result payload line\n'.repeat(200) + 'RESULT_TAIL';
  const cappedResultText = 'CAPPED_HEAD\n[jev-compaction: 2500 more chars not kept]\nCAPPED_TAIL';
  const oldStubResultText = '[jev-compaction truncated 1800 chars of this tool result; re-run the tool if needed]';
  const bashOutput = 'origin/master\n* feature-branch\n';

  const branch = [
    // 1. Regular user rule
    entry('u0', piUser('Never push directly to master without review.')),
    // 2. User message with pasted log
    entry('u1', piUser(`Here is the crash log:\n${logBlock}\nPlease fix it.`)),
    // 3. User message with pasted skill
    entry('u2', piUser(`Here is the skill definition:\n${skillBlock}\nFollow the skill.`)),
    // 4. Tool call producing large result, then operator pasting it back
    entry('a_echo', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_echo', name: 'read', arguments: { path: 'diag.log' } }], timestamp: 0 }),
    entry('t_echo', { role: 'toolResult', toolCallId: 'call_echo', toolName: 'read', content: [{ type: 'text', text: toolResultToEcho }], isError: false, timestamp: 0 }),
    entry('u3', piUser(`The tool returned:\n${toolResultToEcho}\nWhy did this fail?`)),
    // 5. Answered question
    entry('a_q', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_q', name: 'ask_user_question', arguments: { questions: [{ question: 'Deploy to staging first?' }] } }], timestamp: 0 }),
    entry('t_q', { role: 'toolResult', toolCallId: 'call_q', toolName: 'ask_user_question', content: [{ type: 'text', text: 'User answered: Yes, deploy to staging.' }], isError: false, timestamp: 0 }),
    // 6. Pinned write with large body (> 400 chars, stubWrites: true)
    entry('a_w', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_w', name: 'write', arguments: { path: 'src/server.ts', content: writeBody } }], timestamp: 0 }),
    entry('t_w', { role: 'toolResult', toolCallId: 'call_w', toolName: 'write', content: [{ type: 'text', text: 'Wrote 1200 bytes' }], isError: false, timestamp: 0 }),
    // 7. Pinned edit with large edits JSON (> 500 chars, stubEditChars: 500)
    entry('a_e', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_e', name: 'edit', arguments: editArgs }], timestamp: 0 }),
    entry('t_e', { role: 'toolResult', toolCallId: 'call_e', toolName: 'edit', content: [{ type: 'text', text: 'Applied 10 edits' }], isError: false, timestamp: 0 }),
    // 8. Tool call with long arguments (> 160 chars) cut by compactCall
    entry('a_long', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_long', name: 'read', arguments: { path: longPath } }], timestamp: 0 }),
    entry('t_long', { role: 'toolResult', toolCallId: 'call_long', toolName: 'read', content: [{ type: 'text', text: 'file content' }], isError: false, timestamp: 0 }),
    // 9. Tool result truncated
    entry('a_cut', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_cut', name: 'read', arguments: { path: 'big.txt' } }], timestamp: 0 }),
    entry('t_cut', { role: 'toolResult', toolCallId: 'call_cut', toolName: 'read', content: [{ type: 'text', text: truncatedResultText }], isError: false, timestamp: 0 }),
    // 10. Tool result with storage cap marker (kept, so linkCapMarkers links it)
    entry('a_cap', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_cap', name: 'read', arguments: { path: 'capped.txt' } }], timestamp: 0 }),
    entry('t_cap', { role: 'toolResult', toolCallId: 'call_cap', toolName: 'read', content: [{ type: 'text', text: cappedResultText }], isError: false, timestamp: 0 }),
    // 11. Native bash execution
    {
      type: 'message', id: 'b_exec', parentId: 't_cap', timestamp: T0,
      message: { role: 'bashExecution', timestamp: 1728000000, command: 'git branch --list', output: bashOutput, exitCode: 0 },
    },
  ];

  // Configure compaction: charter on, stubWrites on, stubEditChars on, tight budget so call_cut truncates
  const config = testConfig(c => {
    c.compaction.maxAfterShare = 0.5;
    c.compaction.charter = true;
    c.compaction.stubWrites = true;
    c.compaction.stubEditChars = 500;
    c.render.maxArgChars = 160;
    c.render.maxArgCharsPinned = 8000;
    c.render.truncateHeadChars = 300;
  });

  const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { ok: boolean; total?: number; offset?: number; returned?: number } }> }> = [];
  const fake = { on: () => {}, appendEntry: () => {}, registerEntryRenderer: () => {}, registerTool: (t: never) => void tools.push(t) };
  register(fake as never, testDeps({ config }));
  const expandTool = tools.find(t => t.name === EXPAND_TOOL_NAME);
  assert.ok(expandTool, 'jev_expand tool must be registered');

  // Policy: keep calls and results by default, so linkCapMarkers links call_cap
  const policy = (name: string) => {
    if (name.startsWith('staleness_')) return { score: 0, confidence: 1, probabilities: {} };
    return { noul: 1 };
  };

  const deps = testDeps({ config, makeAsker: () => new FakeAsker(policy) });
  const event = piEvent({
    branchEntries: branch,
    preparation: {
      messagesToSummarize: branch.filter(e => e.type === 'message').map(e => e.message),
    },
  });
  const ctx = {
    ...piCtx(),
    sessionManager: { getBranch: () => branch },
  };

  const result = await handleCompact(event, ctx as never, deps);
  const compaction = compactionOf(result);
  const summary = compaction.summary;
  const stats = compaction.details.jev.stats;

  // 1. Verify summary contains charter and restorable elements
  assert.ok(summary.startsWith(CHARTER_HEADER));
  assert.equal(stats.stubbed, 4, 'pool has 4 restorable stubs: write, edit, long arg, and capped result');
  assert.equal(stats.capped, 1, 'pool has 1 capped segment');
  assert.equal(stats.unlinked, 0, 'all stubs must have valid restore ids');

  // 2. Extract every jev_expand call from the generated summary
  const expandLinkRegex = /jev_expand\("([^"]+)"(?:,\s*(?:part="([^"]+)"|offset=(\d+),\s*limit=(\d+)))?\)/g;
  const matches = [...summary.matchAll(expandLinkRegex)];
  assert.equal(matches.length, 7, 'summary has 7 total jev_expand links: 3 in charter, 4 in pool');

  const messages = branchMessages(branch);

  for (const match of matches) {
    const fullCall = match[0];
    const id = match[1]!;
    const part = match[2] as 'input' | 'result' | undefined;
    const offset = match[3] !== undefined ? Number(match[3]) : undefined;
    const limit = match[4] !== undefined ? Number(match[4]) : undefined;

    // Test both direct expand() and tool.execute()
    const expanded = expand(messages, { id, part, offset, limit }, h);
    assert.ok(expanded.ok, `expand() failed for link ${fullCall}: ${(expanded as { error?: string }).error}`);

    const toolResult = await expandTool.execute('test-call', { id, part, offset, limit }, undefined, undefined, ctx);
    assert.ok(toolResult.details.ok, `tool.execute() failed for link ${fullCall}`);
    assert.ok(toolResult.content[0]!.text.includes(expanded.text), `tool output must include expanded text for ${fullCall}`);

    // Verify content matches exact original session source
    if (id === 'u:u1') {
      assert.equal(expanded.text, logBlock);
    } else if (id === 'u:u2') {
      assert.equal(expanded.text, skillBlock);
    } else if (id === 'u:u3') {
      assert.equal(expanded.text, toolResultToEcho);
    } else if (id === 'a:call_q') {
      assert.equal(expanded.text, 'User answered: Yes, deploy to staging.');
    } else if (id === 'call_w' && part === 'input') {
      assert.equal(expanded.text, writeBody);
    } else if (id === 'call_e' && part === 'input') {
      assert.equal(expanded.text, JSON.stringify(editArgs, null, 2));
    } else if (id === 'call_long' && part === 'input') {
      assert.equal(expanded.text, JSON.stringify({ path: longPath }, null, 2));
    } else if (id === 'call_cut' && (!part || part === 'result')) {
      assert.equal(expanded.text, truncatedResultText);
    } else if (id === 'call_cap' && (!part || part === 'result')) {
      assert.equal(expanded.text, cappedResultText);
    }
  }

  // 3. Verify native bashExecution restorable elements
  const bashInput = expand(messages, { id: 'bashexec_1728000000', part: 'input' });
  assert.ok(bashInput.ok);
  assert.equal(bashInput.text, JSON.stringify({ command: 'git branch --list' }, null, 2));
  const bashResult = expand(messages, { id: 'bashexec_1728000000' });
  assert.ok(bashResult.ok);
  assert.equal(bashResult.text, bashOutput);

  // 4. Verify compaction marker presentation with restorable stats
  const savedEntry = {
    type: 'compaction',
    id: 'c_test',
    summary,
    tokensBefore: 120_000,
    estimatedTokensAfter: 60_000,
    details: compaction.details,
  };
  const markerData = entryMarker(savedEntry);
  assert.equal(markerData.stats?.stubbed, stats.stubbed);
  assert.equal(markerData.stats?.capped, stats.capped);
  assert.equal(markerData.stats?.unlinked, 0);

  // Collapsed view
  const collapsed = markerLines(markerData, false, 120).join('\n');
  assert.match(collapsed, new RegExp(`${stats.capped} capped · ${stats.stubbed} restorable · jev_expand`));

  // Expanded view
  const detailed = markerLines(markerData, true, 120).join('\n');
  assert.match(detailed, new RegExp(`Recoverable: ${stats.stubbed} stubs restorable with jev_expand`));
  assert.doesNotMatch(detailed, /! \d+ stubs without a restore id/);

  // Responsive widths
  for (const width of [40, 60, 80, 120]) {
    const lines = markerLines(markerData, false, width);
    assert.ok(lines.every(line => line.length <= width), `no line should exceed width ${width}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Suite 2: Multi-Generation Compaction Chains
// ---------------------------------------------------------------------------------------------

test('multi-generation compaction chains preserve and expand restorable elements across generations', async () => {
  const writeBody1 = 'export const v1 = {\n' + '  data: "v1",\n'.repeat(50) + '};\n';
  const writeBody2 = 'export const v2 = {\n' + '  data: "v2",\n'.repeat(50) + '};\n';

  // Gen 1 branch
  const branchGen1 = [
    entry('u0', piUser('Initial directive for generation 1.')),
    entry('a_w1', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_w1', name: 'write', arguments: { path: 'v1.ts', content: writeBody1 } }], timestamp: 0 }),
    entry('t_w1', { role: 'toolResult', toolCallId: 'call_w1', toolName: 'write', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 }),
  ];

  const config = testConfig(c => {
    c.compaction.maxAfterShare = 0.5;
    c.compaction.charter = true;
    c.compaction.stubWrites = true;
  });

  const deps1 = testDeps({ config });
  const event1 = piEvent({
    branchEntries: branchGen1,
    preparation: { messagesToSummarize: branchGen1.filter(e => e.type === 'message').map(e => e.message) },
  });
  const res1 = await handleCompact(event1, piCtx() as never, deps1);
  const comp1 = compactionOf(res1);

  assert.ok(comp1.summary.includes('jev_expand("call_w1", part="input")'));
  assert.equal(comp1.details.jev.stats.unlinked, 0);

  // Gen 2 branch includes compaction 1 entry + new messages
  const comp1Entry = {
    type: 'compaction',
    id: 'c1',
    parentId: 't_w1',
    timestamp: T0,
    fromHook: true,
    summary: comp1.summary,
    firstKeptEntryId: 'u_gen2',
    tokensBefore: 100_000,
    estimatedTokensAfter: 50_000,
    details: comp1.details,
  };

  const branchGen2 = [
    ...branchGen1,
    comp1Entry,
    entry('u_gen2', piUser('Directive added in generation 2.')),
    entry('a_w2', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_w2', name: 'write', arguments: { path: 'v2.ts', content: writeBody2 } }], timestamp: 0 }),
    entry('t_w2', { role: 'toolResult', toolCallId: 'call_w2', toolName: 'write', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 }),
  ];

  const deps2 = testDeps({ config });
  const event2 = piEvent({
    branchEntries: branchGen2,
    preparation: {
      firstKeptEntryId: 'keep-1',
      messagesToSummarize: [
        branchGen2.find(e => e.id === 'u_gen2')!.message,
        branchGen2.find(e => e.id === 'a_w2')!.message,
        branchGen2.find(e => e.id === 't_w2')!.message,
      ],
      previousSummary: comp1.summary,
    },
  });

  const res2 = await handleCompact(event2, piCtx() as never, deps2);
  const comp2 = compactionOf(res2);

  // Both restorable write stubs must be present
  assert.ok(comp2.summary.includes('jev_expand("call_w1", part="input")'), 'gen 1 restorable stub carried forward');
  assert.ok(comp2.summary.includes('jev_expand("call_w2", part="input")'), 'gen 2 restorable stub added');
  assert.equal(comp2.details.jev.stats.unlinked, 0);

  // Verify that expanding both from the full branch restores byte-exact
  const allMessages = branchMessages(branchGen2);
  const restoreW1 = expand(allMessages, { id: 'call_w1', part: 'input' });
  assert.ok(restoreW1.ok);
  assert.equal(restoreW1.text, writeBody1);

  const restoreW2 = expand(allMessages, { id: 'call_w2', part: 'input' });
  assert.ok(restoreW2.ok);
  assert.equal(restoreW2.text, writeBody2);
});

// ---------------------------------------------------------------------------------------------
// Suite 3: Retired Charter Entries Restoration
// ---------------------------------------------------------------------------------------------

test('retired charter entries remain restorable by id after being superseded or corrected', async () => {
  const RULE_V1 = 'Always run tests with --verbose flag.';
  const RULE_V2 = 'Correction: do not use --verbose flag, it is too noisy.';
  const ASK = 'Implement new authentication provider.';

  const branch = [
    entry('u0', piUser(RULE_V1)),
    entry('u1', piUser(ASK)),
    entry('a1', { role: 'assistant', content: [{ type: 'text', text: 'I am planning the auth provider implementation.' }], timestamp: 0 }),
    entry('u2', piUser(RULE_V2)),
  ];

  const pick = (criteria: Record<string, string | null>, needle: string, p: number) => {
    const label = Object.entries(criteria).find(([, v]) => typeof v === 'string' && v.includes(needle))?.[0] ?? 'none';
    return { choice: label, confidence: p, probabilities: { [label]: p } };
  };

  const asker = {
    async ask(state: { new_operator_message?: string }, questions: Record<string, { criteria?: Record<string, string | null> }>) {
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (id === 'corrects') answers[id] = String(state.new_operator_message).startsWith('Correction') ? pick(q.criteria!, 'Always run tests', 0.95) : { choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } };
        else if (id === 'still_applies') answers[id] = { noul: 0.01 };
        else if (id === 'serves') answers[id] = pick(q.criteria!, 'Implement new authentication', 0.9);
        else if (id === 'step') answers[id] = pick(q.criteria!, 'planning the auth', 0.9);
        else if (id.startsWith('done_')) answers[id] = { noul: 0.1 };
        else answers[id] = { noul: 1 };
      }
      return { answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };

  const config = testConfig(c => {
    c.compaction.maxAfterShare = 0.5;
    c.compaction.charter = true;
  });

  const deps = testDeps({ config, makeAsker: () => asker as never });
  const event = piEvent({
    branchEntries: branch,
    preparation: { messagesToSummarize: branch.filter(e => e.type === 'message').map(e => e.message) },
  });

  const res = await handleCompact(event, piCtx() as never, deps);
  const compaction = compactionOf(res);

  // Verify retirement recorded in details and summary
  assert.equal(compaction.details.jev.charter.retired['u:u0']?.reason, 'corrected');
  // A corrected entry stays rendered with its id (keep-corrected rendering).
  assert.ok(compaction.summary.includes(`[operator u:u0]\n${RULE_V1}\n`));
  assert.ok(!compaction.summary.includes('earlier entry was retired'));

  // Verify that jev_expand on the retired entry still restores the full original text
  const messages = branchMessages(branch);
  const restored = expand(messages, { id: 'u:u0' });
  assert.ok(restored.ok);
  assert.equal(restored.text, RULE_V1);
  assert.match(restored.header, /operator message u0/);
});

// ---------------------------------------------------------------------------------------------
// Suite 4: Legacy Hash Resolution Edge Cases
// ---------------------------------------------------------------------------------------------

test('legacy hash resolution handles both input and result, identical duplicates, and collisions', () => {
  const branch = [
    entry('a1', { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'same.ts' } }], timestamp: 0 }),
    entry('r1', { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'exact content' }], isError: false, timestamp: 0 }),
    // Second identical call
    entry('a2', { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'same.ts' } }], timestamp: 0 }),
    entry('r2', { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [{ type: 'text', text: 'exact content' }], isError: false, timestamp: 0 }),
  ];

  const messages = branchMessages(branch);
  const targetHash = h(JSON.stringify(['read', { path: 'same.ts' }, 'exact content']));

  // Identical duplicate calls: resolves without collision error
  const resResult = expand(messages, { id: `h:${targetHash}` }, h);
  assert.ok(resResult.ok);
  assert.equal(resResult.text, 'exact content');

  const resInput = expand(messages, { id: `h:${targetHash}`, part: 'input' }, h);
  assert.ok(resInput.ok);
  assert.equal(resInput.text, JSON.stringify({ path: 'same.ts' }, null, 2));

  // Hash collision with different content
  const collidingBranch = [
    entry('a1', { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'file1.ts' } }], timestamp: 0 }),
    entry('r1', { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'content 1' }], isError: false, timestamp: 0 }),
    entry('a2', { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'file2.ts' } }], timestamp: 0 }),
    entry('r2', { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [{ type: 'text', text: 'content 2' }], isError: false, timestamp: 0 }),
  ];
  const collidingMessages = branchMessages(collidingBranch);
  // Force a fake colliding hash function
  const collidingHashFn = () => 'collide12345';
  const collisionResult = expand(collidingMessages, { id: 'h:collide12345' }, collidingHashFn);
  assert.equal(collisionResult.ok, false);
  assert.match((collisionResult as { error: string }).error, /no single call in this session matches "h:collide12345"/);

  // Missing hash
  const missingResult = expand(messages, { id: 'h:000000000000' }, h);
  assert.equal(missingResult.ok, false);
  assert.match((missingResult as { error: string }).error, /no single call in this session matches "h:000000000000"/);
});

// ---------------------------------------------------------------------------------------------
// Suite 5: fileNote Disk Comparison for Restorable File Calls
// ---------------------------------------------------------------------------------------------

test('fileNote handles matching, changed, deleted, unreadable files and @ prefixes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-filenote-test-'));
  try {
    const filePath = join(dir, 'app.ts');
    const writeContent = 'export const app = 1;\n';
    writeFileSync(filePath, writeContent);

    // 1. Write call: matching disk
    const noteWriteMatch = fileNote('write', { path: 'app.ts', content: writeContent }, 'ok', dir);
    assert.equal(noteWriteMatch, 'NOTE: app.ts on disk still matches what this call saw.');

    // 2. Write call: changed on disk
    writeFileSync(filePath, 'export const app = 2;\n');
    const noteWriteChanged = fileNote('write', { path: 'app.ts', content: writeContent }, 'ok', dir);
    assert.equal(noteWriteChanged, 'NOTE: app.ts on disk has changed since this call, or cannot be shown to match it; re-read it before any edit.');

    // 3. Write call: deleted from disk
    rmSync(filePath);
    const noteWriteDeleted = fileNote('write', { path: 'app.ts', content: writeContent }, 'ok', dir);
    assert.equal(noteWriteDeleted, 'NOTE: app.ts no longer exists on disk.');

    // 4. Path with @ prefix (common tool syntax)
    writeFileSync(filePath, writeContent);
    const noteAtPrefix = fileNote('write', { path: '@app.ts', content: writeContent }, 'ok', dir);
    assert.equal(noteAtPrefix, 'NOTE: app.ts on disk still matches what this call saw.');

    // 5. Read call: file contains result text
    const noteReadMatch = fileNote('read', { path: 'app.ts' }, 'export const app = 1;', dir);
    assert.equal(noteReadMatch, 'NOTE: app.ts on disk still matches what this call saw.');

    // 6. Read call: file changed, does not contain result
    const noteReadChanged = fileNote('read', { path: 'app.ts' }, 'completely different text', dir);
    assert.equal(noteReadChanged, 'NOTE: app.ts on disk has changed since this call, or cannot be shown to match it; re-read it before any edit.');

    // 7. Non-file tool (e.g. bash): returns undefined
    assert.equal(fileNote('bash', { command: 'git status' }, 'clean', dir), undefined);

    // 8. Tool call without path argument: returns undefined
    assert.equal(fileNote('read', {}, 'some text', dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Suite 6: Paging, Clamping, and Error Handling in jev_expand
// ---------------------------------------------------------------------------------------------

test('jev_expand handles paging, limit clamping, empty and invalid arguments', () => {
  const content = '0123456789'.repeat(100); // 1000 chars
  const branch = [
    entry('a1', { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'test.txt' } }], timestamp: 0 }),
    entry('r1', { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: content }], isError: false, timestamp: 0 }),
  ];
  const messages = branchMessages(branch);

  // Paging with offset and limit
  const page1 = expand(messages, { id: 'c1', offset: 0, limit: 300 });
  assert.ok(page1.ok);
  assert.equal(page1.returned, 300);
  assert.equal(page1.total, 1000);
  assert.equal(page1.text, content.slice(0, 300));
  assert.ok(page1.header.includes('More remains: call again with offset=300.'));

  const page2 = expand(messages, { id: 'c1', offset: 300, limit: 700 });
  assert.ok(page2.ok);
  assert.equal(page2.returned, 700);
  assert.equal(page2.total, 1000);
  assert.equal(page2.text, content.slice(300, 1000));
  assert.ok(!page2.header.includes('More remains:'), 'final page should not announce more remains');

  // Clamping: negative offset clamped to 0
  const negOffset = expand(messages, { id: 'c1', offset: -50, limit: 100 });
  assert.ok(negOffset.ok);
  assert.equal(negOffset.offset, 0);

  // Clamping: zero or negative limit clamped to default
  const zeroLimit = expand(messages, { id: 'c1', offset: 0, limit: 0 });
  assert.ok(zeroLimit.ok);
  assert.equal(zeroLimit.returned, 1000); // less than EXPAND_DEFAULT_LIMIT (20,000)

  // Clamping: excessive limit clamped to EXPAND_MAX_LIMIT
  const hugeContent = 'x'.repeat(150_000);
  const hugeBranch = [
    entry('a_huge', { role: 'assistant', content: [{ type: 'toolCall', id: 'c_huge', name: 'read', arguments: { path: 'huge.txt' } }], timestamp: 0 }),
    entry('r_huge', { role: 'toolResult', toolCallId: 'c_huge', toolName: 'read', content: [{ type: 'text', text: hugeContent }], isError: false, timestamp: 0 }),
  ];
  const hugeMessages = branchMessages(hugeBranch);
  const hugeLimit = expand(hugeMessages, { id: 'c_huge', offset: 0, limit: 1_000_000 });
  assert.ok(hugeLimit.ok);
  assert.equal(hugeLimit.returned, EXPAND_MAX_LIMIT); // clamped to 100,000

  // Errors: empty or whitespace id
  assert.equal(expand(messages, { id: '' }).ok, false);
  assert.equal(expand(messages, { id: '   ' }).ok, false);

  // Errors: unknown id
  const unknownCall = expand(messages, { id: 'nonexistent_call', part: 'input' });
  assert.equal(unknownCall.ok, false);
  assert.match((unknownCall as { error: string }).error, /no call with id "nonexistent_call"/);

  const unknownEntry = expand(messages, { id: 'nonexistent_call' });
  assert.equal(unknownEntry.ok, false);
  assert.match((unknownEntry as { error: string }).error, /no entry with id "nonexistent_call"/);

  const unknownUser = expand(messages, { id: 'u:nonexistent_user' });
  assert.equal(unknownUser.ok, false);
  assert.match((unknownUser as { error: string }).error, /no entry with id "u:nonexistent_user"/);
});

// ---------------------------------------------------------------------------------------------
// Suite 7: Expansion Telemetry Ledger Recording
// ---------------------------------------------------------------------------------------------

test('expansion telemetry ledger records id_kind, seg_hash, compaction linkage, and no private data', async () => {
  const secretContent = 'SECRET_PASSWORD_12345';
  const branch = [
    entry('u1', piUser('My secret note: DO_NOT_LEAK')),
    entry('a1', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_secret', name: 'write', arguments: { path: 'secret.txt', content: secretContent } }], timestamp: 0 }),
    entry('r1', { role: 'toolResult', toolCallId: 'call_secret', toolName: 'write', content: [{ type: 'text', text: 'wrote secret' }], isError: false, timestamp: 0 }),
    {
      type: 'compaction', id: 'c_ledger', parentId: 'r1', timestamp: T0, fromHook: true,
      summary: 'compaction summary', firstKeptEntryId: 'keep', tokensBefore: 1000,
      details: { jev: { attempt_id: 'attempt-xyz-789' } },
    },
  ];

  const tools: Array<{ name: string; execute: (...a: unknown[]) => Promise<{ details: { ok: boolean } }> }> = [];
  const config = testConfig();
  const fake = { on: () => {}, appendEntry: () => {}, registerEntryRenderer: () => {}, registerTool: (t: never) => void tools.push(t) };
  register(fake as never, testDeps({ config }));
  const tool = tools.find(t => t.name === EXPAND_TOOL_NAME)!;
  const ctx = {
    sessionManager: { getBranch: () => branch, getSessionId: () => 'session-telemetry-test' },
  };

  // Expand call input
  await tool.execute('x_input', { id: 'call_secret', part: 'input' }, undefined, undefined, ctx);
  // Expand call result
  await tool.execute('x_result', { id: 'call_secret' }, undefined, undefined, ctx);
  // Expand user entry
  await tool.execute('x_user', { id: 'u:u1' }, undefined, undefined, ctx);
  // Expand empty id
  await tool.execute('x_empty', { id: '' }, undefined, undefined, ctx);
  // Expand unknown call
  await tool.execute('x_unknown', { id: 'bad_id' }, undefined, undefined, ctx);

  await flushTelemetry();
  const ledgerPath = join(dirname(config.telemetry.path), 'expansions.jsonl');
  const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

  assert.equal(rows.length, 5);

  const [rowInput, rowResult, rowUser, rowEmpty, rowUnknown] = rows;

  // Verify id_kind classification
  assert.equal(rowInput.id_kind, 'call_input');
  assert.equal(rowInput.part, 'input');
  assert.equal(rowInput.compaction_entry_id, 'c_ledger');
  assert.equal(rowInput.attempt_id, 'attempt-xyz-789');

  assert.equal(rowResult.id_kind, 'tool_result');
  assert.equal(rowResult.part, 'result');

  assert.equal(rowUser.id_kind, 'user_entry');
  assert.equal(rowUser.seg_hash, h('My secret note: DO_NOT_LEAK'));

  assert.equal(rowEmpty.id_kind, 'invalid');
  assert.equal(rowEmpty.ok, false);

  assert.equal(rowUnknown.id_kind, 'tool_result');
  assert.equal(rowUnknown.ok, false);

  // Assert no secret payload was leaked in the telemetry ledger
  const rawLedgerText = readFileSync(ledgerPath, 'utf8');
  assert.ok(!rawLedgerText.includes(secretContent), 'secret content must never appear in telemetry ledger');
  assert.ok(!rawLedgerText.includes('DO_NOT_LEAK'), 'user secret must never appear in telemetry ledger');
});

// ---------------------------------------------------------------------------------------------
// Suite 8: Pinned Argument Caps and Compact Argument Cuts
// ---------------------------------------------------------------------------------------------

test('pinned call argument caps link part=input and expand to complete arguments', () => {
  const hugeInput = {
    path: 'huge-file.ts',
    content: 'const a = 1;\n'.repeat(800), // ~10,400 chars > 8000
  };
  const branch = [
    entry('a_huge_in', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_huge_in', name: 'write', arguments: hugeInput }], timestamp: 0 }),
    entry('r_huge_in', { role: 'toolResult', toolCallId: 'call_huge_in', toolName: 'write', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 }),
  ];
  const messages = branchMessages(branch);

  const segment = {
    kind: 'call' as const,
    text: '',
    pin: 'modify' as const,
    gen: 1,
    call: {
      id: 'call_huge_in',
      tool: 'write',
      input: hugeInput,
      result: 'ok',
      isError: false,
      resultTruncated: false,
    },
  };

  // Render with stubWrites: false so pinnedCall renders the cap
  const options = {
    maxArgChars: 160,
    maxArgCharsPinned: 8000,
    modifyTools: new Set(['write', 'edit']),
    truncateHeadChars: 300,
    stubWrites: false,
  };

  const rendered = renderSegment(segment, 'keep', options);
  assert.match(
    rendered,
    /\[jev-compaction: \d+ more chars not kept; jev_expand\("call_huge_in", part="input"\) restores the full arguments\]/,
  );
  const counts = stubCounts(rendered);
  assert.equal(counts.capped, 1);
  assert.equal(counts.stubbed, 1);
  assert.equal(counts.unlinked, 0);

  // Expand restores the full content
  const restored = expand(messages, { id: 'call_huge_in', part: 'input' });
  assert.ok(restored.ok);
  assert.equal(restored.text, hugeInput.content);
});

// ---------------------------------------------------------------------------------------------
// Suite 9: Truncated Error Results with Restorable Links
// ---------------------------------------------------------------------------------------------

test('truncated error results link restore id, include error note, and indicate error in expand header', () => {
  const errorTrace = 'Error: connection refused at socket.connect\n' + '  at run (/app/worker.ts:42:15)\n'.repeat(100);
  const branch = [
    entry('a_err', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_err', name: 'bash', arguments: { command: 'connect' } }], timestamp: 0 }),
    entry('r_err', { role: 'toolResult', toolCallId: 'call_err', toolName: 'bash', content: [{ type: 'text', text: errorTrace }], isError: true, timestamp: 0 }),
  ];
  const messages = branchMessages(branch);

  const segment = {
    kind: 'call' as const,
    text: '',
    pin: null,
    gen: 1,
    call: {
      id: 'call_err',
      tool: 'bash',
      input: { command: 'connect' },
      result: errorTrace,
      isError: true,
      resultTruncated: false,
    },
  };

  const options = {
    maxArgChars: 160,
    maxArgCharsPinned: 8000,
    modifyTools: new Set(['write', 'edit']),
    truncateHeadChars: 300,
  };

  const rendered = renderSegment(segment, 'truncate', options);
  assert.match(rendered, /\[jev-compaction truncated \d+ chars of this tool result \(error\); jev_expand\("call_err"\) restores it exactly\]/);
  const counts = stubCounts(rendered);
  assert.equal(counts.capped, 0);
  assert.equal(counts.stubbed, 1);
  assert.equal(counts.unlinked, 0);

  const restored = expand(messages, { id: 'call_err' });
  assert.ok(restored.ok);
  assert.equal(restored.text, errorTrace);
  assert.match(restored.header, /\(an error\)/);
});

// ---------------------------------------------------------------------------------------------
// Suite 10: Carryover Legacy Stub Upgrades
// ---------------------------------------------------------------------------------------------

test('carried-over legacy stubs are upgraded to jev_expand via restoreHint and resolve against branch', () => {
  const originalResult = 'ORIGINAL_DATA_LINE\n'.repeat(100);
  const branch = [
    entry('a_legacy', { role: 'assistant', content: [{ type: 'toolCall', id: 'call_legacy', name: 'read', arguments: { path: 'legacy.txt' } }], timestamp: 0 }),
    entry('r_legacy', { role: 'toolResult', toolCallId: 'call_legacy', toolName: 'read', content: [{ type: 'text', text: originalResult }], isError: false, timestamp: 0 }),
  ];
  const messages = branchMessages(branch);

  const oldStub = 'ORIGINAL_DATA_LINE\n[jev-compaction truncated 1700 chars of this tool result; re-run the tool if needed]';

  // 1. With call ID: upgraded to jev_expand("call_legacy")
  const segmentWithId = {
    kind: 'call' as const,
    text: '',
    pin: null,
    gen: 1,
    call: {
      id: 'call_legacy',
      tool: 'read',
      input: { path: 'legacy.txt' },
      result: oldStub,
      isError: false,
      resultTruncated: true,
    },
  };
  const options = {
    maxArgChars: 160,
    maxArgCharsPinned: 8000,
    modifyTools: new Set(['write', 'edit']),
    truncateHeadChars: 300,
  };

  const renderedId = renderSegment(segmentWithId, 'keep', options);
  assert.ok(renderedId.includes('jev_expand("call_legacy") restores it exactly]'));
  assert.ok(!renderedId.includes('re-run the tool if needed'));
  assert.equal(stubCounts(renderedId).unlinked, 0);
  assert.equal(stubCounts(renderedId).stubbed, 1);

  const restoredId = expand(messages, { id: 'call_legacy' });
  assert.ok(restoredId.ok);
  assert.equal(restoredId.text, originalResult);

  // 2. Without call ID, with valid srcHash: upgraded to jev_expand("h:<srcHash>")
  const targetHash = h(JSON.stringify(['read', { path: 'legacy.txt' }, originalResult]));
  const segmentWithHash = {
    ...segmentWithId,
    srcHash: targetHash,
    call: { ...segmentWithId.call, id: undefined },
  };

  const renderedHash = renderSegment(segmentWithHash, 'keep', options);
  assert.ok(renderedHash.includes(`jev_expand("h:${targetHash}") restores it exactly]`));
  assert.equal(stubCounts(renderedHash).unlinked, 0);
  assert.equal(stubCounts(renderedHash).stubbed, 1);

  const restoredHash = expand(messages, { id: `h:${targetHash}` }, h);
  assert.ok(restoredHash.ok);
  assert.equal(restoredHash.text, originalResult);

  // 3. Without ID and without valid srcHash: remains unlinked
  const segmentUnlinked = {
    ...segmentWithId,
    srcHash: undefined,
    call: { ...segmentWithId.call, id: undefined },
  };
  const renderedUnlinked = renderSegment(segmentUnlinked, 'keep', options);
  assert.ok(renderedUnlinked.includes('re-run the tool if needed]'));
  assert.equal(stubCounts(renderedUnlinked).unlinked, 1);
  assert.equal(stubCounts(renderedUnlinked).stubbed, 0);
});

// ---------------------------------------------------------------------------------------------
// Suite 11: stubCounts Classification Matrix
// ---------------------------------------------------------------------------------------------

test('stubCounts accurately classifies all restorable and unlinked variants', () => {
  // Linked cap
  assert.deepEqual(
    stubCounts('[jev-compaction: 500 more chars not kept; jev_expand("call1") restores it exactly]'),
    { capped: 1, stubbed: 1, unlinked: 0 },
  );
  // Bare cap
  assert.deepEqual(
    stubCounts('[jev-compaction: 500 more chars not kept]'),
    { capped: 1, stubbed: 0, unlinked: 1 },
  );
  // Linked truncation
  assert.deepEqual(
    stubCounts('[jev-compaction truncated 500 chars of this tool result; jev_expand("call1") restores it exactly]'),
    { capped: 0, stubbed: 1, unlinked: 0 },
  );
  // Unlinked truncation
  assert.deepEqual(
    stubCounts('[jev-compaction truncated 500 chars of this tool result; re-run the tool if needed]'),
    { capped: 0, stubbed: 0, unlinked: 1 },
  );
  // Linked argument cut
  assert.deepEqual(
    stubCounts('read(path=very/long…) [args cut; jev_expand("call1", part="input") restores the full arguments]'),
    { capped: 0, stubbed: 1, unlinked: 0 },
  );
  // Unlinked argument cut
  assert.deepEqual(
    stubCounts('read(path=very/long…) [args cut; no restore id]'),
    { capped: 0, stubbed: 0, unlinked: 1 },
  );
  // Stubbed write
  assert.deepEqual(
    stubCounts('write path=app.ts [body stubbed: 50 lines, 2000 chars; the file is on disk, and jev_expand("w", part="input") restores exactly what was written. First lines:]\nline1'),
    { capped: 0, stubbed: 1, unlinked: 0 },
  );
  // Stubbed edit
  assert.deepEqual(
    stubCounts('edit path=app.ts [5 edits stubbed: 1500 chars; jev_expand("e", part="input") restores the exact old and new text]'),
    { capped: 0, stubbed: 1, unlinked: 0 },
  );
  // Plain text
  assert.deepEqual(
    stubCounts('This is normal assistant response text without any stubs or compaction markers.'),
    { capped: 0, stubbed: 0, unlinked: 0 },
  );
});
