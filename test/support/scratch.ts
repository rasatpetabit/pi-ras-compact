import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/**
 * A fresh directory under the system temp dir, removed when this process exits. The test runner
 * gives every test file its own process, so a file's scratch lives exactly as long as the file.
 */
export function scratchDir(prefix: string): string {
  if (created.length === 0) process.once('exit', removeAll);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function removeAll(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
