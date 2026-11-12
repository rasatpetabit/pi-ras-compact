import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const CHILD = resolve(HERE, 'support', 'file-note-pathswap-child.ts');

// Regression: `fileNote` used to stat the pathname and then open it blocking. A concurrent swap
// of the path for a FIFO between those two calls hung the whole tool. The child deterministically
// models that swap (its pathname stat still reports the regular file) and must now return at once.
test('fileNote cannot hang when the path is swapped for a FIFO after the check', { timeout: 20_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-filenote-pathswap-'));
  try {
    const fifo = join(dir, 'answer-pipe');
    const made = spawnSync('mkfifo', [fifo]);
    assert.equal(made.status, 0, 'mkfifo available');

    const child = spawnSync(process.execPath, ['--import', 'tsx', CHILD, fifo], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 5_000,
    });

    assert.equal(child.signal, null,
      `the child must not be killed by the timeout (signal ${child.signal}); stderr: ${child.stderr}`);
    assert.equal(child.status, 0, `the child failed: ${child.stderr}`);
    assert.equal(
      (child.stdout ?? '').trim(),
      `NOTE: ${fifo} is not a regular file; it was not compared with what this call saw; re-read it before any edit.`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
