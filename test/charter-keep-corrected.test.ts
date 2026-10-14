// Entries retired as 'corrected' stay visible as verbatim operator history (keep-corrected
// rendering). These tests run the real compaction boundary: an installed-Pi SessionManager
// session file, native prepareCompaction, the Jev session_before_compact hook with a scripted
// asker, appendCompaction, a reopen from disk, and the model-visible context Pi rebuilds from
// it. No network, no model, no live service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expand } from '../src/core/expand.js';
import { branchMessages } from '../src/pi/branch.js';
import { productionEstimator } from '../src/pi/context-budget.js';
import { handleCompact, type HookResult } from '../src/pi/extension.js';
import { loadControllerConfig } from '../src/client/controller-config.js';
import { rebuildCharterPrefix } from '../src/core/charter-records.js';
import { testConfig } from './support/config.js';
import { piCtx, testDeps } from './support/pi-event.js';
import { piInstallRoot } from './support/pi-install.js';

// Located from PI_PACKAGE_DIR or the `pi` on PATH; every test here needs the installed SDK.
const root = piInstallRoot();
const skipInstall = !root;
const imp = (p: string) => import(pathToFileURL(join(root!, p)).href);
const sdk = root ? await imp('dist/index.js') : null;
const ai = root ? await imp('node_modules/@earendil-works/pi-ai/dist/index.js') : null;
const { prepareCompaction } = root ? await imp('dist/core/compaction/compaction.js') : { prepareCompaction: undefined };

const PROVIDER = 'charter-proof';
const MODEL = 'fixture';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
const assistant = (text: string, tokens = 100) => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'charter-proof-api', provider: PROVIDER, model: MODEL,
  usage: { input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1, cost }, stopReason: 'stop', timestamp: 1,
});
const SETTINGS = { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 };

/**
 * Scripted judge. `corrections` maps a new operator message to a needle in the earlier entry
 * it retires; the confirming question always says the earlier entry no longer applies, which is
 * exactly the wrong whole-entry call the sibling-clause case needs. Every pruning question keeps.
 */
function scriptedAsker(corrections: Record<string, string>) {
  const pick = (criteria: Record<string, string>, needle: string) => Object.entries(criteria).find(([k, v]) => k !== 'none' && v.includes(needle))?.[0];
  return {
    async ask(state: Record<string, unknown>, questions: Record<string, { type: string; criteria?: Record<string, string> }>) {
      const answers: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(questions)) {
        if (name === 'corrects') {
          const needle = corrections[String(state.new_operator_message)];
          const label = needle ? pick(q.criteria!, needle) : undefined;
          answers[name] = label ? { choice: label, confidence: 0.97, probabilities: { [label]: 0.97, none: 0.03 } } : { choice: 'none', confidence: 0.95, probabilities: { none: 0.95 } };
        } else if (name === 'still_applies') answers[name] = { noul: 0.02 };
        else if (q.type === 'choice') {
          const label = Object.keys(q.criteria ?? {})[0] ?? 'none';
          answers[name] = { choice: label, confidence: 0.9, probabilities: { [label]: 0.9 } };
        } else answers[name] = name.startsWith('staleness_') ? { score: 0, confidence: 1, probabilities: {} } : { noul: name.startsWith('done_') ? 0.1 : 1 };
      }
      return { answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

/** One native compaction through the hook, appended to the session file; returns the saved compaction. */
async function compactOnce(manager: any, asker: unknown, layout: boolean) {
  const branch = manager.getBranch();
  const preparation = prepareCompaction(branch, SETTINGS);
  assert.ok(preparation, 'native preparation exists');
  const config = testConfig(c => { c.compaction.maxAfterShare = 0.5; c.compaction.charter = true; });
  const estimator = productionEstimator(sdk.buildSessionProjection, sdk.estimateTokens, ai.getCurrentSystemMessage);
  // layout: the committed controller config (shadow, layout on), as register() loads it in production.
  const controller = loadControllerConfig();
  if (layout) assert.ok(controller.mode !== 'off' && controller.layout, 'committed controller config has layout on');
  const deps = testDeps({ config, makeAsker: () => asker as never, estimator: async () => estimator, ...(layout ? { loadController: () => controller } : {}) });
  const event = { type: 'session_before_compact', preparation, branchEntries: branch, reason: 'manual', willRetry: false, signal: new AbortController().signal };
  const result: HookResult = await handleCompact(event as never, piCtx([], 100_000) as never, deps);
  assert.ok(result && 'compaction' in result, `expected a compaction, got ${JSON.stringify(result)}`);
  const c = result.compaction;
  assert.equal(c.details.jev.layout !== undefined, layout, 'expected layout path');
  assert.ok(rebuildCharterPrefix(c.details.jev.charter_records, c.summary) !== undefined, 'charter records validate');
  manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
  return { compaction: c, preparation };
}

/** Reopen the session file from disk and return the model-visible context text Pi rebuilds from it. */
function reopen(manager: any) {
  const file = manager.getSessionFile();
  assert.ok(file, 'session is persisted');
  const reopened = sdk.SessionManager.open(file, manager.getSessionDir());
  const llm = sdk.convertToLlm(reopened.buildSessionContext().messages);
  const text = llm.map((m: any) => (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('\n') : String(m.content))).join('\n\n');
  return { reopened, text };
}

/** A user-entry id as the charter tags it, found by exact text on the reopened branch. */
function userId(branch: any[], text: string): string {
  const e = branch.find(x => x.type === 'message' && x.message.role === 'user' && x.message.content?.[0]?.text === text);
  assert.ok(e, text);
  return `u:${e.id}`;
}

async function inScratch(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-keep-corrected-'));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const ORIGINAL = 'Proof the rye dough for 45 minutes.';
const CORRECTION = 'Make it 60 minutes instead.';
const SECOND = 'Actually make it 75 minutes instead.';
const SIBLING = 'Proof the rye dough for 45 minutes and score the top before baking.';

function seed(dir: string, operator: string[]) {
  const manager = sdk.SessionManager.create(dir, join(dir, 'sessions'));
  manager.appendModelChange(PROVIDER, MODEL);
  for (const text of operator) {
    manager.appendMessage(user(text));
    manager.appendMessage(assistant("Noted."));
  }
  manager.appendMessage(assistant('Continuing the bake.', 6000));
  manager.appendMessage(user('Continue with the bake plan as it now stands.\n'.repeat(20)));
  return manager;
}

for (const layout of [false, true]) {
const path = layout ? 'layout' : 'legacy';
test(`${path}: a context-dependent correction keeps its target: both entries survive compaction, persistence and reopen, in order`, { skip: skipInstall }, async () => {
  await inScratch(async dir => {
    const manager = seed(dir, [ORIGINAL, CORRECTION]);
    const { compaction } = await compactOnce(manager, scriptedAsker({ [CORRECTION]: 'rye dough' }), layout);
    const { reopened, text } = reopen(manager);
    const branch = reopened.getBranch();
    const original = userId(branch, ORIGINAL), corrected = userId(branch, CORRECTION);
    // The scripted judge did retire it: the fix is in rendering, not in the retirement decision.
    assert.equal(compaction.details.jev.charter.retired[original]?.reason, 'corrected');
    const saved = branch.find((e: any) => e.type === 'compaction');
    assert.equal(saved.details.jev.charter.retired[original]?.reason, 'corrected', 'retirement persisted');
    // Final model-visible context: target (rye dough), action (proof) and latest value (60) recoverable.
    const a = text.indexOf(`[operator ${original}]\n${ORIGINAL}\n`), b = text.indexOf(`[operator ${corrected}]\n${CORRECTION}\n`);
    assert.ok(a >= 0, 'original entry with its id is in the reopened context');
    assert.ok(b > a, 'correction follows it');
    assert.ok(!/superseded|obsolete|retired/i.test(text.slice(a, b + CORRECTION.length + 40)), 'no label on the corrected entry');
    assert.ok(!text.includes('earlier entry was retired'), 'no omission notice: nothing was omitted');
    // ids remain valid for jev_expand on the reopened branch.
    for (const [id, want] of [[original, ORIGINAL], [corrected, CORRECTION]] as const) {
      const r = expand(branchMessages(branch), { id });
      assert.ok(r.ok, id);
      assert.equal(r.text, want);
    }
  });
});

test(`${path}: a wrongly retired entry keeps its unrestated sibling clause visible`, { skip: skipInstall }, async () => {
  await inScratch(async dir => {
    const manager = seed(dir, [SIBLING, CORRECTION]);
    const { compaction } = await compactOnce(manager, scriptedAsker({ [CORRECTION]: 'rye dough' }), layout);
    const { reopened, text } = reopen(manager);
    const original = userId(reopened.getBranch(), SIBLING);
    assert.equal(compaction.details.jev.charter.retired[original]?.reason, 'corrected', 'judge (wrongly) retired the whole entry');
    assert.ok(text.includes('score the top before baking.'), 'the surviving clause is still in the context');
    assert.ok(text.indexOf(SIBLING) < text.indexOf(CORRECTION));
  });
});

test(`${path}: two successive corrections across two compaction generations keep all three entries`, { skip: skipInstall }, async () => {
  await inScratch(async dir => {
    const manager = seed(dir, [ORIGINAL, CORRECTION]);
    const asker = scriptedAsker({ [CORRECTION]: 'rye dough', [SECOND]: '60 minutes' });
    await compactOnce(manager, asker, layout);
    // Generation 2 runs on the reopened session, as a restarted Pi would.
    const { reopened } = reopen(manager);
    reopened.appendMessage(assistant('Proofing now.'));
    reopened.appendMessage(user(SECOND));
    reopened.appendMessage(assistant("Noted."));
    reopened.appendMessage(assistant('Continuing the bake.', 6000));
    reopened.appendMessage(user('Keep going with the bake.\n'.repeat(30)));
    const { compaction: second } = await compactOnce(reopened, asker, layout);
    const { reopened: again, text } = reopen(reopened);
    const branch = again.getBranch();
    const ids = [ORIGINAL, CORRECTION, SECOND].map(t => userId(branch, t));
    assert.equal(second.details.jev.carry.generation, 2);
    assert.deepEqual(Object.fromEntries(Object.entries(second.details.jev.charter.retired).map(([k, v]: [string, any]) => [k, [v.reason, v.by, v.gen]])),
      { [ids[0]!]: ['corrected', ids[1], 1], [ids[1]!]: ['corrected', ids[2], 2] }, 'both retirements persisted with their generations');
    const at = [ORIGINAL, CORRECTION, SECOND].map((t, i) => text.indexOf(`[operator ${ids[i]}]\n${t}\n`));
    assert.ok(at.every(x => x >= 0), `all three entries present: ${at}`);
    assert.ok(at[0]! < at[1]! && at[1]! < at[2]!, 'chronological order');
    for (const [i, t] of [ORIGINAL, CORRECTION, SECOND].entries()) {
      const r = expand(branchMessages(branch), { id: ids[i]! });
      assert.ok(r.ok && r.text === t, ids[i]);
    }
  });
});
}
