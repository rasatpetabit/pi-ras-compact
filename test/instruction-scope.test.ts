import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { loadConfig, defaultConfigPath, coreOptions } from '../src/client/config.js';
import { spanToSegments, validateCarry, type Carry, type Segment } from '../src/core/segments.js';
import { compactSpan } from '../src/core/prune.js';
import { renderSegment } from '../src/core/render.js';
import { call } from './support/span.js';
import { FakeAsker, allZero } from './support/fake-asker.js';

const loaded = loadConfig(defaultConfigPath());
if (!loaded.ok) throw new Error('config invalid');
const base = { ...coreOptions(loaded.config), charter: true,
  pins: new Set(['instruction'] as const), instructionPaths: ['/opt/policy/'] };
const instruction = { tools: base.instructionTools, files: base.instructionFiles, paths: base.instructionPaths,
  followReferences: true, instructionRefs: [], cwd: '/tmp/project' };
const opts = { pins: base.pins, modifyTools: base.modifyTools, decisionTools: base.decisionTools,
  instruction, maxStoredChars: base.maxArgCharsPinned, gen: 1, hash: base.hash };
const read = (path: string, result: string, gen = 1): Segment => ({ kind: 'call', text: '', pin: 'instruction', gen,
  readPath: path, call: { tool: 'read', input: { path }, result, isError: false, resultTruncated: false } });
const cost = (s: Segment) => renderSegment(s, 'keep', base).length + 2;
const run = (segments: Segment[], patch = {}) => compactSpan({ previous: { version: 1, generation: 2, segments },
  span: [], goal: '', budgetTokens: 1_000_000, suffixChars: 0, demotedUnknown: 0 }, { ...base, ...patch }, new FakeAsker(allZero));

test('root and broad directory tokens never propagate to unrelated scratch reads', () => {
  for (const token of ['/', '/.', '/tmp/', '/tmp', '/var/tmp/', homedir(), '~/', '~/.config/', '/workspace/', '/etc/', '../../', './']) {
    const segments = spanToSegments([
      ...call('a', 'read', { path: '/tmp/project/AGENTS.md' }, `see ${token}`),
      ...call('b', 'read', { path: '/tmp/b3.txt' }, 'scratch'),
      ...call('c', 'read', { path: '/tmp/project/unrelated.txt' }, 'scratch'),
    ], opts);
    assert.deepEqual(segments.map(s => s.pin), ['instruction', null, null], token);
  }
});

test('prompt roots and absolute directories are rejected but exact files and configured prefixes work', () => {
  const segments = spanToSegments([
    ...call('a', 'read', { path: '/tmp/b3.txt' }, 'scratch'),
    ...call('b', 'read', { path: '/opt/docs/other.md' }, 'unmentioned'),
    ...call('c', 'read', { path: '/opt/docs/named.md' }, 'named'),
    ...call('d', 'read', { path: '/opt/policy/working.md' }, 'configured'),
  ], { ...opts, instruction: { ...instruction, instructionRefs: ['/', '/tmp/', '/opt/docs/', '/opt/docs/named.md'] } });
  assert.deepEqual(segments.map(s => s.pin), [null, null, 'instruction', 'instruction']);
  const configured = spanToSegments(call('e', 'read', { path: '/tmp/b3.txt' }, 'configured'),
    { ...opts, instruction: { ...instruction, paths: ['/tmp/'] } });
  assert.equal(configured[0]!.pin, 'instruction', 'explicit config retains prefix semantics');
});

test('legacy root-poisoned carry is reclassified before it can seed fresh reads', async () => {
  const segments = [read('/tmp/AGENTS.md', 'see /. and /tmp/'), read('/tmp/b3.txt', 'see /tmp/b4.txt')];
  const previous: Carry = { version: 1, generation: 2, segments };
  const outcome = await compactSpan({ previous, span: call('n', 'read', { path: '/tmp/b4.txt' }, 'scratch'),
    goal: '', budgetTokens: 1_000_000, suffixChars: 0, demotedUnknown: 0 }, base, new FakeAsker(allZero));
  assert.deepEqual(outcome.carry.segments.slice(0, 2).map(s => s.pin), ['instruction', null]);
  assert.equal(outcome.stats.pinnedByClass.instruction, 1);
});

test('charter keeps followed references whole with no size cap, configured files included', async () => {
  const root = read('/tmp/AGENTS.md', 'see /tmp/old.md /tmp/new.md');
  const old = read('/tmp/old.md', 'x'.repeat(100));
  const newer = read('/tmp/new.md', 'y'.repeat(100), 2);
  const configured = read('/opt/policy/working.md', 'z'.repeat(1000), 2);
  const outcome = await run([newer, root, old, configured], { instructionPinMaxChars: cost(newer) });
  assert.deepEqual(outcome.carry.segments.map(s => s.pin), ['instruction', 'instruction', 'instruction', 'instruction']);
  assert.equal(outcome.stats.demotedCap, 0);
  assert.equal(outcome.carry.segments[3]!.call!.result.length, 1000);
  const roundtrip = validateCarry(JSON.parse(JSON.stringify(outcome.carry)))!;
  const next = await run(roundtrip.carry.segments, { instructionPinMaxChars: cost(newer) });
  assert.equal(next.stats.pinnedByClass.instruction, 4);
});

test('an oversized newest followed read stays whole under the charter', async () => {
  const root = read('/tmp/AGENTS.md', 'see /tmp/huge.md');
  const huge = read('/tmp/huge.md', 'h'.repeat(1000), 2);
  const outcome = await run([root, huge], { instructionPinMaxChars: 100 });
  assert.deepEqual(outcome.carry.segments.map(s => s.pin), ['instruction', 'instruction']);
  assert.equal(outcome.stats.demotedCap, 0);
});

test('reference provenance survives without its source, uncapped under the charter', async () => {
  const reference = { ...read('/tmp/named.md', 'n'.repeat(500)), instructionSource: 'reference' as const };
  const checked = validateCarry(JSON.parse(JSON.stringify({ version: 1, generation: 2, segments: [reference] })))!;
  assert.equal(checked.carry.segments[0]!.instructionSource, 'reference');
  const within = await run(checked.carry.segments, { instructionPinMaxChars: cost(reference) });
  assert.equal(within.carry.segments[0]!.pin, 'instruction');
  const over = await run(checked.carry.segments, { instructionPinMaxChars: cost(reference) - 1 });
  assert.equal(over.carry.segments[0]!.pin, 'instruction');
});

test('the charter keeps every followed reference, oldest and largest included', async () => {
  const oldest = { ...read('/tmp/small.md', 's', 1), instructionSource: 'reference' as const };
  const middle = { ...read('/tmp/large.md', 'l'.repeat(1000), 2), instructionSource: 'reference' as const };
  const newest = { ...read('/tmp/new.md', 'n', 2), instructionSource: 'reference' as const };
  const outcome = await run([oldest, middle, newest], { instructionPinMaxChars: cost(oldest) });
  assert.deepEqual(outcome.carry.segments.map(s => s.pin), ['instruction', 'instruction', 'instruction']);
  assert.equal(outcome.stats.demotedCap, 0);
});

test('a claimed file provenance is revalidated, not trusted', async () => {
  const fake = { ...read('/tmp/scratch.log', 's'.repeat(500)), instructionSource: 'file' as const };
  const invalid = await run([fake]);
  assert.equal(invalid.carry.segments[0]!.pin, null);
  assert.equal(invalid.stats.demoted, 1);
  const malformed = validateCarry({ version: 1, generation: 2, segments: [{ ...fake, instructionSource: 'root' }] })!;
  assert.equal(malformed.carry.segments[0]!.instructionSource, undefined);
});

test('an absolute reference is followed as an exact path; only the root is rejected', () => {
  const segments = spanToSegments([
    ...call('a', 'read', { path: '/srv' }, 'named exactly'),
    ...call('b', 'read', { path: '/srv/other.txt' }, 'unrelated'),
  ], { ...opts, instruction: { ...instruction, instructionRefs: ['/srv', '/', '/srv/'] } });
  assert.deepEqual(segments.map(s => s.pin), ['instruction', null]);
});

test('relative climbs to the root never widen scope, with no excluded-directory list', () => {
  const segments = spanToSegments([
    ...call('a', 'read', { path: '/srv/handbook/AGENTS.md' }, 'see ../.. and docs/'),
    ...call('b', 'read', { path: '/srv/other.txt' }, 'unrelated'),
    ...call('c', 'read', { path: '/srv/handbook/docs/rule.md' }, 'rule'),
  ], opts);
  assert.deepEqual(segments.map(s => s.pin), ['instruction', null, 'instruction']);
});


test('a cwd-less bare instruction filename follows its local reference directory', () => {
  const segments = spanToSegments([
    ...call('a', 'read', { path: 'SKILL.md' }, 'see references/'),
    ...call('b', 'read', { path: 'references/x.md' }, 'rule'),
  ], { ...opts, instruction: { ...instruction, cwd: undefined } });
  assert.deepEqual(segments.map(s => s.pin), ['instruction', 'instruction']);
});

test('a legacy cwd-less bare instruction filename seeds local reference directories', async () => {
  const outcome = await compactSpan({
    previous: { version: 1, generation: 2, segments: [{ ...read('SKILL.md', 'see references/'), readPath: undefined }] },
    span: call('b', 'read', { path: 'references/x.md' }, 'rule'),
    goal: '', budgetTokens: 1_000_000, suffixChars: 0, demotedUnknown: 0,
  }, base, new FakeAsker(allZero));
  assert.deepEqual(outcome.carry.segments.map(s => s.pin), ['instruction', 'instruction']);
});

test('a directory reference normalised back onto the source directory cannot pin a sibling', () => {
  const segments = spanToSegments([
    ...call('a', 'read', { path: '/srv/skills/foo/SKILL.md' }, 'see x/../'),
    ...call('b', 'read', { path: '/srv/skills/foo/sibling.md' }, 'unrelated'),
  ], opts);
  assert.deepEqual(segments.map(s => s.pin), ['instruction', null]);
});

test('a descendant directory starting with dots is not a parent traversal', () => {
  const segments = spanToSegments([
    ...call('a', 'read', { path: '/srv/skills/foo/SKILL.md' }, 'see ..notes/'),
    ...call('b', 'read', { path: '/srv/skills/foo/..notes/x.md' }, 'rule'),
  ], opts);
  assert.deepEqual(segments.map(s => s.pin), ['instruction', 'instruction']);
});

test('a bare home token at the external reference seam is rejected before expansion', () => {
  const segments = spanToSegments(call('a', 'read', { path: homedir() }, 'unrelated'),
    { ...opts, instruction: { ...instruction, instructionRefs: ['~'] } });
  assert.equal(segments[0]!.pin, null);
});
