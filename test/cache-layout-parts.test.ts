import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactSpan } from '../src/core/prune.js';
import { coreOptions } from '../src/client/config.js';
import { testConfig } from './support/config.js';
import { FakeAsker, allOnes } from './support/fake-asker.js';
import { say, user, call } from './support/span.js';
const options = coreOptions(testConfig());
const run = (previous: any, span: any[], charter = false) => compactSpan({ previous, span, goal: '', budgetTokens: 100000, suffixChars: 0 }, { ...options, charter }, new FakeAsker(allOnes));
test('duplicate occurrences keep distinct IDs and unchanged carry keeps ID', async () => {
 const a = await run(undefined, [say('same'), say('same')]);
 assert.equal(new Set(a.carry.segments.map(s => s.layoutId)).size, 2);
 assert.ok(a.carry.segments.every(s => typeof s.layoutId === 'string'));
 const b = await run(a.carry, []);
 assert.deepEqual(b.carry.segments.map(s => s.layoutId), a.carry.segments.map(s => s.layoutId));
});
test('rendered parts are exact final-carry slices and omit charter copies', async () => {
 const a = await run(undefined, [user('direct'), ...call('c', 'read', {path:'x'}, 'paired'), say('answer')], true);
 assert.ok(a.renderedParts);
 for (const p of a.renderedParts!) { assert.ok(a.summary.includes(p.text)); assert.notEqual(a.carry.segments[p.segmentIndex].kind, 'user'); }
 assert.equal(a.renderedParts!.length, 2);
});
