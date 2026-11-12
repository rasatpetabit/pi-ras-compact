import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileNote } from '../../src/pi/expand-tool.js';

/**
 * Child half of the path-swap regression: the pathname stat is made to report the regular file
 * the call saw, while the path itself is now a FIFO with no reader. The pre-fix `fileNote`
 * trusted that stat and then opened the path blocking, so it hung forever; the fix opens
 * non-blocking and inspects the descriptor, so it returns a skipped-comparison note at once.
 */
const target = process.argv[2];
if (!target) throw new Error('usage: file-note-pathswap-child <path>');

const realStat = fs.statSync;
fs.statSync = ((path: fs.PathLike, ...rest: unknown[]) => {
  if (path === target) return { isFile: () => true, size: 0 } as fs.Stats;
  return (realStat as (...args: unknown[]) => fs.Stats)(path, ...rest);
}) as typeof fs.statSync;
syncBuiltinESMExports();

const note = fileNote('read', { path: target }, 'anything', undefined);
process.stdout.write(`${note}\n`);
