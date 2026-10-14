import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { readFileSync } from 'node:fs';
import { defaultConfigPath, loadConfig, validateConfig, coreOptions } from '../src/client/config.js';
import { compactSpan, tokensForChars, type CompactInput, type CoreOptions } from '../src/core/prune.js';
import { renderSegment } from '../src/core/render.js';
import { instructionReader, promptReferences, INSTRUCTION_REF_LIMIT } from '../src/core/instruction.js';
import { spanToSegments, validateCarry, type Carry, type SegmentOptions } from '../src/core/segments.js';
import { allOnes, allZero, FakeAsker } from './support/fake-asker.js';
import { call, user } from './support/span.js';
import { createHash } from 'node:crypto';

const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

const loaded = loadConfig(defaultConfigPath());
if (!loaded.ok) throw new Error('committed config is invalid');
const base: CoreOptions = {
  ...coreOptions(loaded.config),
  // The fleet prefix is operator config, absent until the class is enabled. Tests that exercise
  // prefix matching supply it here; the committed default stays empty.
  instructionPaths: ['/opt/policy/'],
  pins: new Set(['user', 'error', 'modify', 'boundary', 'decision', 'instruction'] as const),
  modifyTools: new Set(['edit', 'write']),
  decisionTools: new Set(['ask_user_question']),
  pinGenerations: 3,
  keepThreshold: 0.5,
  borderline: 0.1,
  truncateHeadChars: 300,
  thresholdSchedule: [0.5, 0.65, 0.8],
};
const HUGE = 10_000_000;
const input = (patch: Partial<CompactInput>): CompactInput => ({
  previous: undefined, span: [], goal: 'fix auth', budgetTokens: HUGE, suffixChars: 0, demotedUnknown: 0, ...patch,
});
const instruction = (patch: Partial<NonNullable<SegmentOptions['instruction']>> = {}): NonNullable<SegmentOptions['instruction']> => ({
  tools: base.instructionTools,
  files: base.instructionFiles,
  paths: ['/opt/policy/'],
  followReferences: base.instructionFollowReferences,
  instructionRefs: [],
  ...patch,
});
const segOptions = (patch: Partial<SegmentOptions> = {}): SegmentOptions => ({
  pins: base.pins,
  modifyTools: base.modifyTools,
  decisionTools: base.decisionTools,
  instruction: instruction(),
  maxStoredChars: base.maxArgCharsPinned,
  gen: 1,
  hash: sha12,
  ...patch,
});

test('an instruction read is pinned only when instruction is configured', () => {
  const span = call('a', 'read', { path: '/tmp/proj/AGENTS.md' }, 'rule one');
  const pinned = spanToSegments(span, segOptions());
  assert.equal(pinned[0]!.pin, 'instruction');
  const off = spanToSegments(span, segOptions({ pins: new Set(['user', 'error', 'modify', 'boundary', 'decision']) }));
  assert.equal(off[0]!.pin, null);
});

test('basename, prefix, prompt reference and an unreferenced md read', () => {
  const cwd = '/tmp/proj';
  const cases: Array<[string, string | null]> = [
    ['docs/SKILL.md', 'instruction'],
    ['/opt/policy/working.md', 'instruction'],
    ['notes/ordinary.md', null],
    ['/opt/docs/setup.md', 'instruction'],
  ];
  for (const [path, pin] of cases) {
    const [segment] = spanToSegments(
      call('a', 'read', { path }, 'body'),
      segOptions({ instruction: instruction({ cwd, instructionRefs: ['/opt/docs/setup.md'] }) }),
    );
    assert.equal(segment!.pin, pin, path);
  }
});

test('references from an earlier read, a carried pin, a directory, and transitivity', async () => {
  const cwd = '/tmp/proj';
  const span = [
    ...call('a', 'read', { path: 'skills/foo/SKILL.md' }, 'see references/runtime.md and `references/` and /etc/hosts.conf'),
    ...call('b', 'read', { path: 'skills/foo/references/runtime.md' }, 'then see extra/deep.md'),
    ...call('c', 'read', { path: 'skills/foo/references/extra/deep.md' }, 'leaf'),
    ...call('d', 'read', { path: 'skills/foo/references/other.md' }, 'under dir'),
    ...call('e', 'read', { path: 'skills/foo/SKILL.md' }, 'before'),
  ];
  // The earlier SKILL.md is the one that names the references; the later one is a re-read and must
  // not be required for the earlier matches. Place the naming read first.
  const segments = spanToSegments(span, segOptions({ instruction: instruction({ cwd }) }));
  assert.deepEqual(segments.map(s => s.pin), ['instruction', 'instruction', 'instruction', 'instruction', 'instruction']);

  const carried: Carry = {
    version: 1,
    generation: 1,
    segments: [{
      kind: 'call', text: '', pin: 'instruction', gen: 1,
      call: { tool: 'read', input: { path: '/tmp/proj/skills/bar/SKILL.md' }, result: 'see references/from-carry.md', isError: false, resultTruncated: false },
    }],
  };
  const outcome = await compactSpan(
    input({ previous: carried, span: call('z', 'read', { path: 'skills/bar/references/from-carry.md' }, 'carried-ref'), cwd }),
    base,
    new FakeAsker(allZero),
  );
  assert.equal(outcome.carry.segments.at(-1)!.pin, 'instruction');
});

test('an errored instruction read is pinned error', () => {
  const [segment] = spanToSegments(call('a', 'read', { path: 'AGENTS.md' }, 'ENOENT', true), segOptions({ cwd: '/tmp/proj' }));
  assert.equal(segment!.pin, 'error');
});

test('instruction pins expire by instruction_pin_generations', async () => {
  const opts = { ...base, pinGenerations: 2, decisionPinGenerations: 2, instructionPinGenerations: 4 };
  const previous: Carry = {
    version: 1, generation: 1,
    segments: [{
      kind: 'call', text: '', pin: 'instruction', gen: 1,
      call: { tool: 'read', input: { path: '/tmp/AGENTS.md' }, result: 'rules', isError: false, resultTruncated: false },
    }],
  };
  const young = await compactSpan(input({ previous, span: [] }), opts, new FakeAsker(allOnes));
  assert.equal(young.carry.generation, 2);
  assert.equal(young.carry.segments[0]!.pin, 'instruction');
  let carry = young.carry;
  for (let g = 3; g <= 5; g++) {
    const outcome = await compactSpan(input({ previous: carry, span: [] }), opts, new FakeAsker(allOnes));
    carry = outcome.carry;
  }
  assert.equal(carry.generation, 5);
  assert.equal(carry.segments[0]!.pin, 'instruction', 'age 4 is still inside instruction_pin_generations');
  const expired = await compactSpan(input({ previous: carry, span: [] }), opts, new FakeAsker(allOnes));
  assert.equal(expired.carry.segments[0]!.pin, null);
  assert.equal(expired.stats.demoted, 1);
});

test('caps are per class and a re-read demotes the older pin', async () => {
  const read = (gen: number, path: string, result: string): Carry['segments'][number] => ({
    kind: 'call', text: '', pin: 'instruction', gen,
    call: { tool: 'read', input: { path }, result, isError: false, resultTruncated: false },
  });
  const decision = (gen: number, id: string, result: string): Carry['segments'][number] => ({
    kind: 'call', text: '', pin: 'decision', gen,
    call: { tool: 'ask_user_question', input: { id }, result, isError: false, resultTruncated: false },
  });
  const one = read(1, '/tmp/AGENTS.md', 'a'.repeat(80));
  const cost = renderSegment(one, 'keep', {
    maxArgChars: base.maxArgChars, maxArgCharsPinned: base.maxArgCharsPinned,
    modifyTools: base.modifyTools, truncateHeadChars: base.truncateHeadChars,
  }).length + 2;
  const opts = {
    ...base,
    instructionPaths: [] as string[],
    instructionPinMaxChars: cost + 5,
    decisionPinMaxChars: cost + 5,
  };
  const previous: Carry = {
    version: 1, generation: 1,
    segments: [read(1, '/tmp/AGENTS.md', 'a'.repeat(80)), decision(1, 'd1', 'd'.repeat(80)), decision(1, 'd2', 'e'.repeat(80))],
  };
  const outcome = await compactSpan(
    input({ previous, span: call('n', 'read', { path: '/tmp/SKILL.md' }, 'b'.repeat(80)), cwd: '/tmp' }),
    opts,
    new FakeAsker(allZero),
  );
  const pins = outcome.carry.segments.map(s => [s.call!.input.path ?? s.call!.input.id, s.pin]);
  // The instruction cap holds the newest read; the older instruction pin is the one demoted.
  // The decision cap holds the newest decision and demotes the older one, on its own budget.
  assert.deepEqual(pins, [['/tmp/AGENTS.md', null], ['d1', null], ['d2', 'decision'], ['/tmp/SKILL.md', 'instruction']]);
  assert.equal(outcome.stats.demotedCap, 2);
  assert.equal(outcome.carry.segments.at(-1)!.call!.result, 'b'.repeat(80));

  const dup = await compactSpan(
    input({
      previous: { version: 1, generation: 1, segments: [read(1, `${homedir()}/proj/AGENTS.md`, 'old')] },
      span: call('r', 'read', { path: '~/proj/AGENTS.md' }, 'new'),
    }),
    { ...base, instructionPinMaxChars: 1_000_000 },
    new FakeAsker(allZero),
  );
  assert.equal(dup.stats.demotedDuplicate, 1);
  assert.equal(dup.stats.demotedCap, 0);
  assert.equal(dup.carry.segments.filter(s => s.pin === 'instruction').length, 1);
});

test('the reference set bound still lets a span body pin a later read', () => {
  // Four thousand distinct tokens of noise, then the same token repeated, then the real
  // reference. The scan sees more than 5,000 matches; the per-source cap keeps 5,000, and the
  // repeated token costs only one of them, so the real reference is inside the cap.
  const noise = `${Array.from({ length: 4000 }, (_, i) => `/n/${i}`).join(' ')} ${'/n/0 '.repeat(2000)}`;
  const [first, second] = spanToSegments(
    [
      ...call('a', 'read', { path: '/tmp/AGENTS.md' }, `${noise} see /tmp/real/setup.md`),
      ...call('b', 'read', { path: '/tmp/real/setup.md' }, 'kept'),
    ],
    segOptions({
      instruction: instruction({ instructionRefs: Array.from({ length: 5000 }, (_, i) => `/opt/prompt/${i}.md`) }),
    }),
  );
  assert.equal(first!.pin, 'instruction');
  assert.equal(second!.pin, 'instruction');
});

test('a relative reference resolves against the file, and an unresolved source stays literal', () => {
  const named = 'see references/runtime.md';
  const [skill, runtime] = spanToSegments(
    [
      ...call('a', 'read', { path: 'skills/foo/SKILL.md' }, named),
      ...call('b', 'read', { path: 'references/runtime.md' }, 'bare'),
    ],
    segOptions({ instruction: instruction({ cwd: undefined }) }),
  );
  assert.equal(skill!.pin, 'instruction');
  assert.equal(runtime!.pin, 'instruction', 'the reference as written matches the bare read');
  const [resolved, bare] = spanToSegments(
    [
      ...call('a', 'read', { path: 'skills/foo/SKILL.md' }, named),
      ...call('b', 'read', { path: 'references/runtime.md' }, 'bare'),
    ],
    segOptions({ instruction: instruction({ cwd: '/tmp/proj' }) }),
  );
  assert.equal(resolved!.pin, 'instruction');
  assert.equal(bare!.pin, null, 'a resolved source does not match the unresolved bare read');
});

test('an errored instruction read is still instruction when error is not configured', () => {
  const [segment] = spanToSegments(
    call('a', 'read', { path: '/tmp/AGENTS.md' }, 'ENOENT', true),
    segOptions({ pins: new Set(['instruction']), instruction: instruction({ paths: [] }) }),
  );
  assert.equal(segment!.pin, 'instruction');
});

test('prompt references ignore relative tokens that fill the raw match window', () => {
  // 5,000 distinct relative tokens come first. Filtering after the cap would drop the absolute
  // reference that follows them; the eligible token has to survive.
  const relative = Array.from({ length: INSTRUCTION_REF_LIMIT }, (_, i) => `docs/noise-${i}.md`).join(' ');
  const refs = promptReferences(`${relative} see /opt/docs/setup.md`);
  assert.deepEqual(refs, ['/opt/docs/setup.md']);
});

test('one system prompt spends one reference budget, not one per reference', () => {
  const refs = Array.from({ length: INSTRUCTION_REF_LIMIT + 1 }, (_, i) => `/opt/prompt/${i}.md`);
  const reader = instructionReader(
    instruction({ paths: [], instructionRefs: refs }),
    [],
  );
  assert.equal(
    reader.matches('read', `/opt/prompt/${INSTRUCTION_REF_LIMIT}.md`, false),
    false,
    'reference 5001 is past the one budget a prompt receives',
  );
  assert.equal(reader.matches('read', '/opt/prompt/0.md', false), true);
});

test('a carried relative read keeps the cwd it was resolved under', async () => {
  // The identity is stored when the segment is created. A carry that merely survives a later
  // compaction is not re-resolved: this compaction has no span, so the pin is the one above.
  const created = spanToSegments(
    call('s', 'read', { path: 'skills/foo/SKILL.md' }, 'see /tmp/proj/skills/foo/references/runtime.md'),
    segOptions({ instruction: instruction({ cwd: '/tmp/proj', paths: [] }) }),
  );
  const previous: Carry = { version: 1, generation: 1, segments: created };
  const carried = created[0]!;
  assert.equal(carried.call!.input.path, 'skills/foo/SKILL.md', 'the stored tool input stays as read');
  assert.equal(carried.readPath, '/tmp/proj/skills/foo/SKILL.md');

  // A later compaction whose cwd moved must still resolve the body's reference from the stored
  // identity, and must treat a re-read of that same file as a duplicate.
  const outcome = await compactSpan(
    input({
      previous,
      span: [
        ...call('a', 'read', { path: '/tmp/proj/skills/foo/references/runtime.md' }, 'rules'),
        ...call('b', 'read', { path: '/tmp/proj/skills/foo/SKILL.md' }, 'again'),
      ],
      cwd: '/tmp/elsewhere',
    }),
    { ...base, instructionPaths: [], instructionPinMaxChars: 1_000_000 },
    new FakeAsker(allZero),
  );
  const pins = outcome.carry.segments.map(segment => [segment.call?.input.path, segment.pin]);
  assert.deepEqual(pins, [
    ['skills/foo/SKILL.md', null],
    ['/tmp/proj/skills/foo/references/runtime.md', 'instruction'],
    ['/tmp/proj/skills/foo/SKILL.md', 'instruction'],
  ]);
  assert.equal(outcome.stats.demotedDuplicate, 1);

  // A carry written before readPath exists falls back to the path as stored. An absolute path
  // still matches; a relative one is not re-resolved against the compaction's current cwd.
  const legacy = await compactSpan(
    input({
      previous,
      span: call('c', 'read', { path: 'skills/foo/SKILL.md' }, 'again'),
      cwd: '/tmp/elsewhere',
    }),
    { ...base, instructionPaths: [], instructionPinMaxChars: 1_000_000 },
    new FakeAsker(allZero),
  );
  assert.equal(legacy.stats.demotedDuplicate, 0);
  assert.equal(legacy.carry.segments.filter(segment => segment.pin === 'instruction').length, 2);
});

test('old config without the instruction keys loads the defaults', () => {
  // The committed config sets instruction_paths; strip every instruction key to get the old shape.
  const text = readFileSync(defaultConfigPath(), 'utf8').replace(/^instruction_\w+ = .*\n/gm, '');
  assert.ok(!text.includes('instruction_'));
  const result = validateConfig(parse(text));
  assert.ok(result.config);
  if (!result.config) return;
  assert.deepEqual(result.config.compaction.instructionTools, ['read']);
  assert.deepEqual(result.config.compaction.instructionFiles, ['SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'INTENT.md']);
  assert.deepEqual(result.config.compaction.instructionPaths, []);
  assert.equal(result.config.compaction.instructionFollowReferences, true);
  assert.equal(result.config.compaction.instructionPinGenerations, 20);
  assert.equal(result.config.compaction.instructionPinMaxChars, 60_000);
  assert.ok(loadConfig(defaultConfigPath()).ok, 'the committed config loads');
  const withPrefix = text.replace(/^pins = .*$/m, '$&\ninstruction_paths = ["/opt/policy/"]');
  const loaded = validateConfig(parse(withPrefix));
  assert.deepEqual(loaded.config?.compaction.instructionPaths, ['/opt/policy/']);
  void homedir; void join; void validateCarry; void tokensForChars;
});
