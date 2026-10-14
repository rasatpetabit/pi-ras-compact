import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * sha256 over one line per entry under `root`, the lines sorted as strings and
 * joined with NUL, which no file name can contain: `dir path`, `file path digest`
 * or `link path digest`, where the digest is the sha256 of the file's bytes or of
 * a symlink's target. Symlinks are hashed as links, never followed. Any
 * added, removed, renamed, retargeted or edited file, link or directory changes
 * the result.
 */
export function treeHash(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, dirent.name);
      const rel = relative(root, path).split(sep).join('/');
      if (dirent.isDirectory()) {
        entries.push(`dir ${rel}`);
        walk(path);
      } else if (dirent.isSymbolicLink()) entries.push(`link ${rel} ${sha256(readlinkSync(path))}`);
      else entries.push(`file ${rel} ${sha256(readFileSync(path))}`);
    }
  };
  walk(root);
  return sha256(entries.sort().join('\0'));
}
