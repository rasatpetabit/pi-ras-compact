import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHash } from './support/tree-hash.js';
import { scratchDir } from './support/scratch.js';

const root = fileURLToPath(new URL('../src/vendor/pi-jev/', import.meta.url));
const vendoredMd = fileURLToPath(new URL('../VENDORED.md', import.meta.url));

test('the vendored tree matches the hash recorded in VENDORED.md', () => {
  assert.ok(existsSync(vendoredMd), 'VENDORED.md is missing');
  const recorded = /^Tree sha256: `([0-9a-f]{64})`$/m.exec(readFileSync(vendoredMd, 'utf8'))?.[1];
  assert.ok(recorded, 'VENDORED.md has no "Tree sha256: `<hex>`" line');
  assert.equal(treeHash(root), recorded, 'vendored files changed without updating VENDORED.md');
});

test('the tree hash changes when a vendored file changes by one byte or is renamed', () => {
  const copy = join(scratchDir('jev-vendor-'), 'tree');
  cpSync(root, copy, { recursive: true });
  const before = treeHash(copy);
  const file = join(copy, 'compaction', 'convert.ts');
  const bytes = readFileSync(file);
  bytes[0] = bytes[0]! ^ 1;
  writeFileSync(file, bytes);
  const edited = treeHash(copy);
  assert.notEqual(edited, before);
  renameSync(file, join(copy, 'compaction', 'convert2.ts'));
  assert.notEqual(treeHash(copy), edited);
});
