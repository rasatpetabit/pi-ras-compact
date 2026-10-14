import { appendFile, mkdir, open, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/**
 * Appends that have not settled yet. The call path never awaits them; tests and
 * a graceful host may await `flushTelemetry()`. Pending libuv work keeps the
 * process alive, so a fire-and-forget append still lands before exit.
 */
const pending = new Set<Promise<void>>();

/**
 * The asynchronous filesystem surface telemetry uses. Every method returns a
 * promise, so none runs on the caller's stack; `appendJsonLine` only schedules the
 * chain and returns. The work itself runs on libuv's shared worker pool, so a
 * stalled filesystem can still hold a worker and delay process exit; telemetry
 * therefore does no filesystem work beyond the row itself and, when a caller
 * asks for it, rotating that file: a size check, one rename to a unique name,
 * and pruning of old rotated siblings. The seam lets a test substitute a stalled
 * filesystem and prove the request and compaction-result paths never wait on
 * telemetry, rotation included.
 */
export interface LedgerFs {
  stat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  appendFile(path: string, data: string, options: { mode: number }): Promise<void>;
  /** Optional so a test fake of the write path need not invent rotation. */
  rename?(from: string, to: string): Promise<void>;
  readdir?(path: string): Promise<string[]>;
  unlink?(path: string): Promise<void>;
  /**
   * Streams `from` into a gzip file at `to` and gives it `from`'s mtime. Optional, so a
   * fake without it simply never compresses.
   */
  gzip?(from: string, to: string): Promise<void>;
}

async function gzipFile(from: string, to: string): Promise<void> {
  const { atime, mtime } = await stat(from);
  const source = await open(from, 'r');
  let target;
  try {
    target = await open(to, 'wx', 0o600);
  } catch (error) {
    await source.close();
    throw error;
  }
  // Each stream owns and closes its handle when it ends or fails.
  await pipeline(source.createReadStream(), createGzip(), target.createWriteStream());
  await utimes(to, atime, mtime);
}

const realFs: LedgerFs = {
  stat: path => stat(path),
  mkdir: (path, options) => mkdir(path, options),
  appendFile: (path, data, options) => appendFile(path, data, options),
  rename: (from, to) => rename(from, to),
  readdir: path => readdir(path),
  unlink: path => unlink(path),
  gzip: gzipFile,
};

let ledgerFs: LedgerFs = realFs;

/**
 * Tests substitute a stalled filesystem; production leaves the real one. A
 * swapped surface abandons the previous one's in-flight writes, so a stalled
 * test cannot strand a later `flushTelemetry()`.
 */
export function setLedgerFs(next: LedgerFs | undefined): void {
  ledgerFs = next ?? realFs;
  pending.clear();
  tails.clear();
  maintaining.clear();
  maintained.clear();
}

/**
 * Where a row came from. `eval` when the process runs an eval harness, which sets
 * `JEV_TELEMETRY_SOURCE=eval`; anything else is `live`. Read per row, never from config:
 * an older live session validates config keys strictly and would cancel on a new one.
 */
export type TelemetrySource = 'live' | 'eval';

export function telemetrySource(): TelemetrySource {
  return process.env.JEV_TELEMETRY_SOURCE === 'eval' ? 'eval' : 'live';
}

/** The live telemetry directory (`~/.local/state/jev`), resolved against the current HOME. */
export function liveTelemetryDir(): string {
  return join(homedir(), '.local', 'state', 'jev');
}

/**
 * The file a row actually goes to. An eval process never writes the live directory: a row
 * aimed there lands in `JEV_TELEMETRY_EVAL_DIR`, or `<live>/eval/` when that is unset. Any
 * other directory (a harness's own scratch) is used as given. Pure: no filesystem work.
 */
export function ledgerPathFor(path: string, source: TelemetrySource = telemetrySource()): string {
  if (source !== 'eval') return path;
  try {
    if (resolve(dirname(path)) !== resolve(liveTelemetryDir())) return path;
    const evalDir = process.env.JEV_TELEMETRY_EVAL_DIR;
    return join(evalDir && evalDir.length > 0 ? evalDir : join(liveTelemetryDir(), 'eval'), basename(path));
  } catch {
    return path;
  }
}

/**
 * One-time notes for refused telemetry sinks, keyed by path. There is no default
 * destination: writing stderr, synchronously or through the worker pool, can stall
 * on a full pipe, and an optional diagnostic must never hold work. A host that can
 * surface the note safely (a test, a UI) installs a sink.
 */
const refused = new Set<string>();
let noteSink: ((message: string) => void) | undefined;

/** Installs (or with `undefined` removes) the destination for refusal notes. */
export function setLedgerNoteSink(sink: ((message: string) => void) | undefined): void {
  noteSink = sink;
}

function noteOnce(path: string, reason: string): void {
  if (refused.has(path)) return;
  refused.add(path);
  if (!noteSink) return;
  try {
    noteSink(`jev telemetry: refusing ${reason} sink at ${path}; compaction telemetry is disabled`);
  } catch {
    // A note is diagnostic only.
  }
}

/** How far a rotated file may be rotated again, and how much of them to keep. */
export interface RotateOptions {
  /** Rename the live file before appending once its size reaches this many bytes. Defaults to 64 MiB. */
  rotateAtBytes?: number;
  /** Rotated siblings (compressed or not) to keep, oldest deleted first. Defaults to 2 GiB. */
  keepRotatedBytes?: number;
}

/**
 * Every ledger rotates at 64 MiB and keeps 2 GiB of rotated siblings, gzip-compressed once
 * they leave the grace hour. Ledger rows compress roughly 10:1, so this is years of data at
 * the current rate (about 10 MB a day across all ledgers). Code defaults, not config.
 */
export const DEFAULT_ROTATE_AT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_KEEP_ROTATED_BYTES = 2 * 1024 * 1024 * 1024;
const PRUNE_GRACE_MS = 60 * 60 * 1000;

/**
 * `2026-09-26T03:04:05.678Z` becomes `20260926T030405678Z`. The milliseconds stay
 * so a rotated name reads as a UTC time; they are not what makes it unique.
 */
function rotationStamp(when = new Date()): string {
  return when.toISOString().replace(/[-:]/g, '').replace('.', '');
}

/**
 * Rotations this process has performed. Two of them can fall inside one
 * millisecond, and `rename` over an existing name replaces it, so the name also
 * carries this count: the timestamp and the pid alone would not keep both files.
 */
let rotations = 0;

/**
 * Rotates one file inside the caller's per-path chain. A rename that loses the race (ENOENT,
 * or anything else) is swallowed and the row is still appended. Returns whether it rotated.
 */
async function rotateIfNeeded(path: string, limit: number): Promise<boolean> {
  if (!ledgerFs.rename) return false;
  const file = basename(path);
  const base = file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : file;
  try {
    const current = await ledgerFs.stat(path);
    if (current.isFile() && current.size >= limit) {
      const dest = join(dirname(path), `${base}.${rotationStamp()}.${process.pid}.${rotations}.jsonl`);
      try {
        await ledgerFs.rename(path, dest);
        rotations += 1; // only a rename that happened takes a name
        return true;
      } catch {
        // ENOENT: another process renamed it first. Anything else: skip and append.
      }
    }
  } catch {
    // ENOENT (nothing to rotate yet) or a stat that cannot be read.
  }
  return false;
}

/** Paths whose sibling maintenance is running now, and paths this process has maintained. */
const maintaining = new Set<string>();
const maintained = new Set<string>();

/** Orders rotated names by their stamp, then pid and count: the name, not the mtime, is the age. */
function rotationKey(name: string): string {
  const match = /\.(\d{8}T\d{9}Z)\.(\d+)\.(\d+)\.jsonl(?:\.gz)?$/.exec(name);
  return match ? `${match[1]}.${match[2]!.padStart(10, '0')}.${match[3]!.padStart(10, '0')}` : name;
}

/**
 * Compresses and prunes one ledger's rotated siblings. It runs outside the per-path append
 * chain, at most once at a time per path, and only when this process has not looked yet or
 * has just rotated, so an ordinary append costs nothing extra. Every failure is swallowed. It
 * never touches the live file, and never a sibling modified within the last hour, because a
 * late append can still land in a file that was just renamed.
 */
async function maintain(path: string, keep: number): Promise<void> {
  if (!ledgerFs.readdir || !ledgerFs.unlink) return;
  const dir = dirname(path);
  const file = basename(path);
  const base = file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : file;
  let names: string[];
  try {
    names = await ledgerFs.readdir(dir);
  } catch {
    return;
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const rotated = new RegExp('^' + escaped + String.raw`\.\d{8}T\d{9}Z\.\d+\.\d+\.jsonl(?:\.gz)?$`);
  const cutoff = Date.now() - PRUNE_GRACE_MS;
  // A gzip temporary (`<rotated>.gz.<pid>.tmp`) orphaned by a killed process matches nothing
  // else, so it is reclaimed here once it is past the grace hour.
  const orphan = new RegExp('^' + escaped + String.raw`\.\d{8}T\d{9}Z\.\d+\.\d+\.jsonl\.gz\.\d+\.tmp$`);
  for (const name of names) {
    if (!orphan.test(name)) continue;
    try {
      if ((await ledgerFs.stat(join(dir, name))).mtimeMs <= cutoff) await ledgerFs.unlink(join(dir, name));
    } catch {
      // Gone already, or not ours to delete.
    }
  }
  const files: { name: string; path: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!rotated.test(name)) continue;
    try {
      const info = await ledgerFs.stat(join(dir, name));
      if (info.isFile()) files.push({ name, path: join(dir, name), size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Gone between the listing and the stat: another process pruned it.
    }
  }
  // Compress aged plain siblings: write a private temporary, rename it into place, then
  // remove the plain file. A second process doing the same produces the same bytes.
  if (ledgerFs.gzip && ledgerFs.rename) {
    const present = new Set(files.map(entry => entry.name));
    for (const entry of [...files]) {
      if (!entry.name.endsWith('.jsonl') || entry.mtimeMs > cutoff) continue;
      const gz = `${entry.name}.gz`;
      const tmp = join(dir, `${gz}.${process.pid}.tmp`);
      try {
        if (!present.has(gz)) {
          await ledgerFs.gzip(entry.path, tmp);
          await ledgerFs.rename(tmp, join(dir, gz));
        }
        await ledgerFs.unlink(entry.path);
        const info = await ledgerFs.stat(join(dir, gz));
        files.splice(files.indexOf(entry), 1);
        if (!present.has(gz)) files.push({ name: gz, path: join(dir, gz), size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        try {
          await ledgerFs.unlink(tmp);
        } catch {
          // No temporary was made, or it is already gone.
        }
      }
    }
  }
  files.sort((a, b) => (rotationKey(a.name) < rotationKey(b.name) ? -1 : rotationKey(a.name) > rotationKey(b.name) ? 1 : 0));
  // Only files old enough to delete count toward the ceiling. A file inside the
  // grace hour is never unlinked, and its bytes must not keep the total over the
  // cap, or every older file would be deleted to make room for one that stays.
  let total = files.reduce((sum, entry) => sum + (entry.mtimeMs > cutoff ? 0 : entry.size), 0);
  for (const entry of files) {
    if (total <= keep) break;
    if (entry.mtimeMs > cutoff) continue; // a late append may still be landing here
    try {
      await ledgerFs.unlink(entry.path);
      total -= entry.size;
    } catch {
      // Already gone, or not ours to delete. The next maintenance tries again.
    }
  }
}

function scheduleMaintenance(path: string, keep: number, rotatedNow: boolean): void {
  if (maintaining.has(path) || (maintained.has(path) && !rotatedNow)) return;
  maintaining.add(path);
  maintained.add(path);
  const work: Promise<void> = maintain(path, keep).catch(() => {});
  pending.add(work);
  void work.finally(() => {
    pending.delete(work);
    maintaining.delete(path);
  });
}

/**
 * The whole telemetry write, asynchronous from top to bottom. The rotation check,
 * the non-regular-file refusal (checked with `fs/promises.stat`, never opening the
 * sink), the one-time note, the directory creation and the append all live here;
 * every failure is swallowed, so telemetry never fails a call and no call waits on it.
 */
async function writeLine(path: string, value: object, rotate: RotateOptions | undefined, source: TelemetrySource): Promise<void> {
  let line: string;
  try {
    // `source` is added to every row; a row that already names one keeps it.
    line = `${JSON.stringify({ ...value, source: (value as { source?: unknown }).source ?? source })}\n`;
  } catch {
    return; // telemetry never breaks a call
  }
  const rotatedNow = await rotateIfNeeded(path, rotate?.rotateAtBytes ?? DEFAULT_ROTATE_AT_BYTES);
  // A FIFO, a device or a directory is a skipped row, not a sink to open: opening a
  // FIFO with no reader could block, and this asynchronous stat cannot.
  try {
    if (!(await ledgerFs.stat(path)).isFile()) {
      noteOnce(path, 'non-regular-file');
      return;
    }
  } catch {
    // ENOENT (create it) or EACCES (let the append attempt decide).
  }
  try {
    await ledgerFs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    return; // a directory that cannot be created is a skipped row, never a throw
  }
  try {
    await ledgerFs.appendFile(path, line, { mode: 0o600 });
  } catch {
    // A failed append never changes the outcome.
  }
  scheduleMaintenance(path, rotate?.keepRotatedBytes ?? DEFAULT_KEEP_ROTATED_BYTES, rotatedNow);
}

/**
 * Appends one JSON line, creating the directory (0700) and the file (0600) when
 * missing. It returns immediately: the rotation check, the stat refusal, the note,
 * the mkdir and the append all run inside the fire-and-forget chain, and errors are
 * swallowed. No synchronous filesystem work happens before it returns, so a stalled
 * filesystem cannot hold the request or the compaction result.
 *
 * Every row gains `source` (`live`, or `eval` under `JEV_TELEMETRY_SOURCE=eval`), and an
 * eval row aimed at the live directory is redirected (`ledgerPathFor`). The per-path chain
 * renames the file once it reaches `rotateAtBytes` (64 MiB by default), before appending;
 * separately, aged rotated siblings are gzip-compressed and pruned down to
 * `keepRotatedBytes` (2 GiB by default). A rotation that fails is skipped; the row is still
 * appended.
 */
export function appendJsonLine(requested: string, value: object, rotate?: RotateOptions): void {
  let source: TelemetrySource = 'live';
  let path = requested;
  try {
    source = telemetrySource();
    path = ledgerPathFor(requested, source);
  } catch {
    // An unreadable environment leaves the row live and where the caller asked.
  }
  // Rows for one file are written in call order: each write starts after the previous one
  // for that path settles (writeLine never rejects), so its rotation, stat, mkdir and
  // append cannot overtake an earlier row's.
  const write: Promise<void> = (tails.get(path) ?? Promise.resolve()).then(() => writeLine(path, value, rotate, source));
  tails.set(path, write);
  pending.add(write);
  void write.finally(() => {
    pending.delete(write);
    if (tails.get(path) === write) tails.delete(path);
  });
}

/** The latest scheduled write per path, which the next row for that path waits on. */
const tails = new Map<string, Promise<void>>();

/** Awaits every telemetry append scheduled so far. Never called on the call path. */
export async function flushTelemetry(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * True for a count-valued token figure. Telemetry rows carry only counts, so a
 * value that is not a finite non-negative number is not one (an odd usage field
 * must not poison a later read).
 */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
