import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'smol-toml';
import { captureCharter, readCharterState } from '../src/core/charter.js';
import { retireCorrected, DEFAULT_RETIRE_OPTIONS, type ChoiceAsker } from '../src/core/charter-judge.js';
import { OpenAIDecisionsClient } from '../src/client/openai-decisions-client.js';
import { defaultConfigPath, validateConfig } from '../src/client/config.js';
import { flushTelemetry } from '../src/client/ledger.js';
import { routePolicyRevision } from '../src/client/decision-routes.js';
import { testConfig } from './support/config.js';
import { stubServer, type Reply } from './support/stub-server.js';
import { FakeAsker } from './support/fake-asker.js';
import { handleCompact } from '../src/pi/extension.js';
import { piEvent, piCtx, piUser, testDeps } from './support/pi-event.js';

const KEY = 'PRIVATE-GATE-MOCK-KEY';
const thresholds = { replaceMin: .68, defersMax: .14 };
const raw = () => parse(readFileSync(defaultConfigPath(), 'utf8')) as any;
const configured = () => ({
  charter_backend: 'openai-decisions',
  openai_decisions_endpoint: 'https://api.openai.com/v1/decisions',
  openai_decisions_model: 'gpt-6-luna',
  openai_decisions_key_env: 'GATE_TEST_KEY',
  charter_replace_min: .68,
  charter_defers_max: .14,
});

const proposer = (pick = 'E1', p = .97, still = .05): ChoiceAsker => ({
  async ask(_s, qs) {
    return {
      answers: qs.corrects
        ? { corrects: { choice: pick, probabilities: { [pick]: p } } }
        : { still_applies: { noul: still } },
    };
  },
});

const entries = (message: string, candidate = 'Always run tests before committing.') => captureCharter([
  { entryId: 'old', role: 'user', text: candidate, toolCalls: [] },
  { entryId: 'new', role: 'user', text: message, toolCalls: [] },
], { decisionTools: new Set(), hash: t => t, pasteMinLines: 12, toolOutputMinChars: 600 });

const reply = (answers: unknown, model = 'gpt-6-luna'): Reply => ({ status: 200, body: JSON.stringify({ model, answers }) });

function scriptedFourWay(r: number, d: number, bad?: string) {
  return (hit: { body: string }): Reply => {
    if (bad === 'timeout') return 'hang';
    if (bad === 'http') return { status: 503, body: KEY };

    const body = JSON.parse(hit.body);
    const qs = body.questions;
    assert.equal(qs.length, 1);
    const q = qs[0];

    if (bad === 'refusal') {
      return reply([{ name: q.name, type: 'refusal' }]);
    }

    const label = q.name.replace(/_relation$/, '');
    const repLabel = `${label}_replaces_as_whole`;
    const defLabel = `${label}_announces_change_but_defers_specification`;
    const addLabel = `${label}_adds_without_replacing`;

    const pRep = r;
    const pDef = d;
    const pAdd = 0;
    const pNone = Math.max(0, Number((1 - pRep - pDef - pAdd).toFixed(8)));

    const probMap: Record<string, number> = {
      none: pNone,
      [repLabel]: pRep,
      [addLabel]: pAdd,
      [defLabel]: pDef,
    };

    let probEntries = Object.entries(probMap).map(([value, probability]) => ({ value, probability }));

    if (bad === 'missing') {
      probEntries = probEntries.filter(e => e.value !== defLabel);
    } else if (bad === 'duplicate') {
      probEntries.push({ value: repLabel, probability: pRep });
    } else if (bad === 'unknown') {
      probEntries.push({ value: 'unknown_option', probability: 0.1 });
    } else if (bad === 'malformed') {
      (probEntries[0] as any).probability = 'not-a-number';
    }

    let topChoice = repLabel;
    let topProb = -1;
    for (const [k, v] of Object.entries(probMap)) {
      if (v > topProb) {
        topProb = v;
        topChoice = k;
      }
    }

    const answers = [
      {
        type: 'choice',
        name: q.name,
        choice: bad === 'unknown' ? 'unknown_option' : topChoice,
        confidence: Number.isFinite(topProb) && topProb >= 0 ? Math.min(1, Math.max(0, topProb)) : 1,
        probabilities: probEntries,
      },
    ];

    return reply(answers, bad === 'model' ? 'other-model' : undefined);
  };
}

async function run(
  r: number,
  d: number,
  bad?: string,
  prop = proposer(),
  message = 'Instead of tests, run lint before committing.',
  gateThresholds = thresholds,
  candidate = 'Always run tests before committing.',
) {
  const stub = await stubServer(scriptedFourWay(r, d, bad));
  const config = testConfig(v => {
    v.api.openaiDecisionsEndpoint = stub.url.replace('/v1/systemone', '/v1/decisions');
    v.api.openaiDecisionsKeyEnv = 'GATE_TEST_KEY';
    v.api.openaiDecisionsTimeoutMs = bad === 'timeout' ? 100 : 5000;
  });
  const client = new OpenAIDecisionsClient({ config, configHash: 'test', caller: 'gate-test', env: { GATE_TEST_KEY: KEY } });
  try {
    const out = await retireCorrected(
      entries(message, candidate),
      new Set(['u:new']),
      readCharterState(undefined),
      1,
      prop,
      { ...DEFAULT_RETIRE_OPTIONS, gate: { asker: client as unknown as ChoiceAsker, ...gateThresholds } },
    );
    await flushTelemetry();
    const telemetry = existsSync(config.telemetry.path) ? readFileSync(config.telemetry.path, 'utf8') : '';
    assert.ok(!JSON.stringify(out.log).includes(KEY));
    assert.ok(!telemetry.includes(KEY));
    return { out, hits: stub.hits.map(h => JSON.parse(h.body)), rawHits: stub.hits.map(h => h.body) };
  } finally {
    await stub.close();
  }
}

test('four-way exact inclusive R and D boundaries: R admits at/above R; D admits at/below D', async () => {
  // Test R boundary at fixed D = .14
  for (const [r, d, admit] of [
    [.68, .14, true],           // exact boundary on both admits
    [.68 - 1e-10, .14, false],  // strictly below R rejects
    [.68 + 1e-10, .14, true],   // strictly above R admits
  ] as const) {
    const { out, hits } = await run(r, d);
    assert.equal(Object.keys(out.state.retired).length, admit ? 1 : 0, `r=${r},d=${d}`);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].questions[0].name, 'E1_relation');
    assert.equal(hits[0].questions[0].type, 'choice');
  }

  // Test D boundary at fixed R = .68
  for (const [r, d, admit] of [
    [.68, .14, true],           // exact boundary on both admits
    [.68, .14 + 1e-10, false],  // strictly above D rejects
    [.68, .14 - 1e-10, true],   // strictly below D admits
  ] as const) {
    const { out, hits } = await run(r, d);
    assert.equal(Object.keys(out.state.retired).length, admit ? 1 : 0, `r=${r},d=${d}`);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].questions[0].name, 'E1_relation');
    assert.equal(hits[0].questions[0].type, 'choice');
  }
});

test('vacuous-D case (D=1.0) and genuine two-signal case (R=.72, D=.14)', async () => {
  // Vacuous-D case: R=.68, D=1.0 admits on replaces alone because defers <= 1.0 is always true
  const vacuous = { replaceMin: .68, defersMax: 1.0 };
  for (const [r, d, admit] of [
    [.68, .32, true],   // at R, any D admits
    [.70, .30, true],   // above R, any D admits
    [.85, .15, true],   // above R, any D admits
    [.679, .10, false], // below R rejects even with low D
    [.679, 0, false],   // below R rejects even with zero D
  ] as const) {
    const { out } = await run(r, d, undefined, proposer(), 'Instead of tests, run lint before committing.', vacuous);
    assert.equal(Object.keys(out.state.retired).length, admit ? 1 : 0, `vacuous: r=${r},d=${d}`);
  }

  // Genuine two-signal case: R=.72, D=.14 requires BOTH signals
  const genuine = { replaceMin: .72, defersMax: .14 };
  for (const [r, d, admit] of [
    [.72, .14, true],   // exact equality on both admits
    [.75, .10, true],   // r >= .72 and d <= .14 admits
    [.75, .15, false],  // d > .14 rejects despite high r
    [.70, .10, false],  // r < .72 rejects despite low d
    [.70, .15, false],  // both fail -> rejects
  ] as const) {
    const { out } = await run(r, d, undefined, proposer(), 'Instead of tests, run lint before committing.', genuine);
    assert.equal(Object.keys(out.state.retired).length, admit ? 1 : 0, `genuine: r=${r},d=${d}`);
  }
});

test('fail closed toward keeping on every abnormal path: refusal, timeout, non-200, missing, duplicate, unknown, model, malformed, thrown', async () => {
  for (const bad of ['refusal', 'timeout', 'http', 'missing', 'duplicate', 'unknown', 'model', 'malformed']) {
    const { out } = await run(.95, .01, bad);
    assert.deepEqual(out.state.retired, {}, `bad path ${bad} must fail closed`);
    assert.equal(out.log[0]?.why, 'gate_kept', `log why must be gate_kept on ${bad}`);
  }

  // Any thrown error from asker also fails closed
  const throwingAsker: ChoiceAsker = {
    async ask() { throw new Error('transport exploded'); },
  };
  const outThrow = await retireCorrected(
    entries('Instead of tests, run lint before committing.'),
    new Set(['u:new']),
    readCharterState(undefined),
    1,
    proposer(),
    { ...DEFAULT_RETIRE_OPTIONS, gate: { asker: throwingAsker, ...thresholds } },
  );
  assert.deepEqual(outThrow.state.retired, {}, 'thrown error must fail closed');
  assert.equal(outThrow.log[0]?.why, 'gate_kept');
});

const goldenPath = new URL('../../docs/design/jev-charter-decisions/four-way/four-way-r1/transitions.jsonl', import.meta.url);
test('golden-request drift: emitted gate request is byte-identical to recorded four-way golden', { skip: !existsSync(goldenPath) }, async () => {
  const goldenRow = JSON.parse(readFileSync(goldenPath, 'utf8').split('\n')[0]);
  const goldenRawRequest = goldenRow.calls[0].raw_request;

  // Run the gate with the golden transition's inputs
  const { hits, rawHits } = await run(
    .97,
    .01,
    undefined,
    proposer('E1', .99, .01),
    goldenRow.new_operator_message,
    thresholds,
    goldenRow.earlier_entry,
  );

  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], goldenRawRequest, 'emitted request parsed structure must match recorded golden');
  assert.equal(rawHits[0], JSON.stringify(goldenRawRequest), 'emitted request wire bytes must be identical to recorded golden');

  // Verify that tampering with instructions or criteria would cause drift detection
  const tampered = structuredClone(goldenRawRequest);
  tampered.questions[0].instructions += ' drift';
  assert.notDeepEqual(hits[0], tampered, 'tampered instruction must be detected as drift');
});

test('confidentiality: key never appears in any captured log, telemetry string, or error', async () => {
  const { out } = await run(.95, .01, 'http');
  assert.ok(!JSON.stringify(out.log).includes(KEY));
});

test('end-to-end retireCorrected: deferred-specification keeps, genuine replacement retires, ambiguous keeps', async () => {
  for (const [message, r, d, expectedWhy, expectedRetires] of [
    // Deferred specification: announces change but withholds details -> keeps
    ['Use different crates for those; I will tell you which ones later.', .07, .84, 'gate_kept', 0],
    // Genuine replacement: replaces old rule -> retires
    ['Instead of tests, run lint before committing.', .95, .01, 'retired', 1],
    // Ambiguous: unrelated or low replaces -> keeps
    ['Maybe lint is enough?', .20, .10, 'gate_kept', 0],
  ] as const) {
    const { out } = await run(r, d, undefined, proposer(), message);
    assert.equal(Object.keys(out.state.retired).length, expectedRetires, `message: ${message}`);
    assert.equal(out.log[0]?.why, expectedWhy, `message: ${message}`);
  }
});

test('only confirmed production proposals reach gate: recovery cannot exist', async () => {
  for (const p of [proposer('none'), proposer('E1', .849), proposer('E1', .97, .151)]) {
    let calls = 0;
    const out = await retireCorrected(
      entries('Replace tests with lint.'),
      new Set(['u:new']),
      readCharterState(undefined),
      1,
      p,
      { ...DEFAULT_RETIRE_OPTIONS, gate: { ...thresholds, asker: { async ask() { calls++; throw new Error('not reached'); } } } },
    );
    assert.equal(calls, 0);
    assert.deepEqual(out.state.retired, {});
  }
  for (const key of ['charter_recovery', 'charter_recovery_enabled']) {
    const r = raw();
    Object.assign(r.api, configured(), { [key]: true });
    assert.ok(validateConfig(r).errors.some(e => e === `api.${key} (unknown)`));
  }
});

test('configured gate requires explicit model/endpoint/key-name/thresholds; values never enter errors', () => {
  const r = raw();
  Object.assign(r.api, configured());
  const valid = validateConfig(r);
  assert.ok(valid.config, valid.errors.join(','));
  assert.equal(valid.config.api.charterReplaceMin, .68);
  assert.equal(valid.config.api.charterDefersMax, .14);

  // Missing any required field fails
  for (const field of Object.keys(configured()).filter(k => k !== 'charter_backend')) {
    const absent = structuredClone(r);
    delete absent.api[field];
    assert.equal(validateConfig(absent).config, undefined, `missing ${field} must fail`);
  }

  // Old fields are rejected as unknown
  for (const oldField of ['charter_confidence_min', 'charter_adds_max']) {
    const old = structuredClone(r);
    old.api[oldField] = .5;
    const out = validateConfig(old);
    assert.ok(out.errors.some(e => e === `api.${oldField} (unknown)`), `old field ${oldField} must be unknown`);
  }

  // Threshold mutation changes routePolicyRevision; invalid values rejected without leaking KEY
  for (const field of ['charter_replace_min', 'charter_defers_max']) {
    const changed = structuredClone(valid.config);
    changed.api[({ charter_replace_min: 'charterReplaceMin', charter_defers_max: 'charterDefersMax' } as const)[field]] += .01;
    assert.notEqual(routePolicyRevision(changed), routePolicyRevision(valid.config));

    for (const value of [-.01, 1.01, KEY]) {
      const bad = structuredClone(r);
      bad.api[field] = value;
      const out = validateConfig(bad);
      assert.equal(out.config, undefined);
      assert.ok(!JSON.stringify(out.errors).includes(KEY));
    }
  }
});

test('route unset is byte-inert even with Decisions settings; hook routes only gate, records revision/counts', async () => {
  const stub = await stubServer(scriptedFourWay(.10, .80));
  const envBefore = process.env.GATE_TEST_KEY;
  process.env.GATE_TEST_KEY = KEY;
  try {
    const config = testConfig(c => {
      c.compaction.charter = true;
      c.compaction.maxAfterShare = .5;
      Object.assign(c.api, {
        openaiDecisionsEndpoint: stub.url.replace('/v1/systemone', '/v1/decisions'),
        openaiDecisionsModel: 'gpt-6-luna',
        openaiDecisionsKeyEnv: 'GATE_TEST_KEY',
        charterReplaceMin: .68,
        charterDefersMax: .14,
      });
    });
    const old = 'Always run tests before committing.';
    const branch = ['old', 'new'].map((id, i) => ({ type: 'message', id, message: piUser(i ? 'Also run lint before committing.' : old) }));
    const event = piEvent({ branchEntries: branch });
    const asker = () => new FakeAsker(name => name === 'corrects' ? { choice: 'E1', confidence: 1, probabilities: { E1: .97 } } : { noul: 0 });
    const runHook = async () => {
      const result = await handleCompact(event, piCtx(), testDeps({ config, makeAsker: asker, now: () => 0 }));
      assert.ok(result && 'compaction' in result);
      return result.compaction;
    };
    const before = await runHook();
    const saved = structuredClone(config.api);
    for (const key of Object.keys(config.api)) {
      if (key.startsWith('openaiDecisions') || key.startsWith('charter')) delete config.api[key];
    }
    const bare = await runHook();
    assert.equal(before.summary, bare.summary);
    assert.deepEqual(before.details.jev.charter, bare.details.jev.charter);
    assert.equal(stub.hits.length, 0);
    assert.equal(before.details.jev.route_policy_revision, undefined);

    Object.assign(config.api, saved, { charterBackend: 'openai-decisions' });
    const gated = await runHook();
    assert.deepEqual(gated.details.jev.charter.retired, {});
    assert.equal(stub.hits.length, 1); // exactly ONE four-way choice call!
    assert.equal(gated.details.jev.route_policy_revision, routePolicyRevision(config));
    assert.equal(gated.details.jev.backend_requests['openai-decisions'], 1);
    assert.ok(!JSON.stringify(gated).includes(KEY));
  } finally {
    if (envBefore === undefined) delete process.env.GATE_TEST_KEY;
    else process.env.GATE_TEST_KEY = envBefore;
    await flushTelemetry();
    await stub.close();
  }
});

test('kept proposals stay in the live sequential candidate pool; no recovery queries', async () => {
  const all = entries('Also run lint.');
  const extra = { ...all[1]!, id: 'u:later', entryId: 'later', order: all[1]!.order + 1, text: 'Instead, only run lint.' };
  let proposal = 0;
  const p: ChoiceAsker = {
    async ask(_state, qs) {
      if (qs.corrects) {
        proposal++;
        return { answers: { corrects: { choice: proposal === 1 ? 'E1' : 'E2', probabilities: { [proposal === 1 ? 'E1' : 'E2']: .97 } } } };
      }
      return { answers: { still_applies: { noul: .05 } } };
    },
  };
  let gateCalls = 0;
  const gate: ChoiceAsker = {
    async ask(_state, qs) {
      gateCalls++;
      const qname = Object.keys(qs)[0]!;
      const label = qname.replace(/_relation$/, '');
      const rep = gateCalls === 1 ? .1 : .9;
      const def = gateCalls === 1 ? .8 : .02;
      const none = 1 - rep - def;
      return {
        answers: {
          [qname]: {
            type: 'choice',
            choice: rep > def ? `${label}_replaces_as_whole` : `${label}_announces_change_but_defers_specification`,
            confidence: Math.max(rep, def),
            probabilities: {
              none,
              [`${label}_replaces_as_whole`]: rep,
              [`${label}_adds_without_replacing`]: 0,
              [`${label}_announces_change_but_defers_specification`]: def,
            },
          },
        },
      };
    },
  };
  const out = await retireCorrected(
    [...all, extra],
    new Set(['u:new', 'u:later']),
    readCharterState(undefined),
    1,
    p,
    { ...DEFAULT_RETIRE_OPTIONS, gate: { asker: gate, ...thresholds } },
  );
  assert.equal(gateCalls, 2);
  assert.deepEqual(out.log.map(l => l.why), ['gate_kept', 'retired']);
  assert.deepEqual(Object.keys(out.state.retired), ['u:old']);
});
