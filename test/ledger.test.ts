import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  appendJsonLine, DEFAULT_KEEP_ROTATED_BYTES, DEFAULT_ROTATE_AT_BYTES, flushTelemetry, isCount, setLedgerFs, setLedgerNoteSink, telemetrySource, type LedgerFs,
} from '../src/client/ledger.js';
import { scratchDir } from './support/scratch.js';

/** A write-path fake must still return the size and mtime rotation reads. */
async function statShape(fs: LedgerFs): Promise<void> {
  const info = await fs.stat('unused');
  assert.equal(typeof info.size, 'number');
  assert.equal(typeof info.mtimeMs, 'number');
}

const scratch = (): string => join(scratchDir('jev-ledger-'), 'sub', 'calls.jsonl');

test('appendJsonLine creates a private directory and file and appends one JSON line per call', async () => {
  const path = scratch();
  appendJsonLine(path, { ts: '2026-09-23T01:00:00.000Z', request_bytes: 100, input_tokens: 3 });
  appendJsonLine(path, { ts: '2026-09-23T02:00:00.000Z', request_bytes: 100, input_tokens: 4 });
  await flushTelemetry();
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.input_tokens), [3, 4]);
});

test('a write failure is swallowed and never blocks: a directory sink is refused, not opened', async () => {
  // The ledger is write-only telemetry: nothing reads it back to gate a call. The
  // append is asynchronous, so a sink that cannot be written is a skipped row, and a
  // non-regular-file sink is refused before any open (opening a FIFO would block).
  const path = join(scratchDir('jev-ledger-'), 'as-a-directory');
  mkdirSync(path);
  setLedgerNoteSink(() => {}); // a directory sink is refused with a note; keep the TAP stream clean
  try {
    assert.doesNotThrow(() => appendJsonLine(path, { ts: 'x' }));
    await flushTelemetry();
  } finally {
    setLedgerNoteSink(undefined);
  }
});

test('a FIFO sink with no reader is refused promptly, and nothing waits on it', async () => {
  const dir = scratchDir('jev-ledger-');
  const fifo = join(dir, 'calls.jsonl');
  execFileSync('mkfifo', [fifo]);
  const notes: string[] = [];
  setLedgerNoteSink(message => void notes.push(message));
  try {
    const started = Date.now();
    appendJsonLine(fifo, { ts: 'x' });
    appendJsonLine(fifo, { ts: 'y' });
    const elapsed = Date.now() - started;
    await flushTelemetry(); // the refusal is asynchronous now; wait for both notes
    assert.ok(elapsed < 250, `refusing a FIFO must not block (${elapsed} ms)`);
    assert.equal(notes.length, 1, 'one note per refused sink, not one per attempt');
    assert.match(notes[0]!, /non-regular-file/);
    assert.equal(statSync(fifo).isFIFO(), true, 'the FIFO is still a FIFO: it was never opened for writing');
  } finally {
    setLedgerNoteSink(undefined);
  }
});

test('a stalled filesystem cannot block appendJsonLine: it returns before any await', async () => {
  const never = new Promise<never>(() => {});
  // Rotation's rename, readdir and unlink sit on the same chain as the append, so a stall
  // in any of them must not hold the call any more than a stalled stat, mkdir or append does.
  setLedgerFs({
    stat: () => never,
    mkdir: () => never,
    appendFile: () => never,
    rename: () => never,
    readdir: () => never,
    unlink: () => never,
  });
  try {
    const started = Date.now();
    assert.doesNotThrow(() => appendJsonLine(scratch(), { ts: 'x' }, { rotateAtBytes: 1 }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 50, `appendJsonLine must return at once (${elapsed} ms)`);
  } finally {
    setLedgerFs(undefined); // abandon the stalled writes so a later flush terminates
  }
});

test('appendJsonLine performs no synchronous filesystem work (source guard)', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/client/ledger.ts', import.meta.url)), 'utf8');
  assert.ok(!/from ['"]node:fs['"]/.test(source), 'the ledger may import node:fs/promises only, never node:fs');
  assert.ok(!/\b(?:statSync|mkdirSync|appendFileSync|openSync|writeSync|existsSync)\s*\(/.test(source),
    'the ledger must not call a synchronous fs function');
  assert.ok(!/\bconsole\./.test(source), 'the ledger must not write diagnostics through console, which can block');
});

test('a refused sink writes no diagnostic anywhere by default, so a stalled stderr cannot hold a worker', async () => {
  const touched: string[] = [];
  // stat's size and mtimeMs are required: rotation reads both, and a write-path fake
  // that omits them is not a LedgerFs even when it never rotates.
  const fs = {
    stat: async () => ({ isFile: () => false, size: 0, mtimeMs: 0 }),
    mkdir: async path => (touched.push(`mkdir ${path}`), undefined),
    appendFile: async path => void touched.push(`append ${path}`),
  } satisfies LedgerFs;
  setLedgerFs(fs);
  setLedgerNoteSink(undefined);
  try {
    await statShape(fs);
    appendJsonLine(join(tmpdir(), `jev-ledger-refused-default-${process.pid}`), { ok: true });
    await flushTelemetry();
    assert.deepEqual(touched, [], 'a refused sink does no filesystem work, not even a note');
  } finally {
    setLedgerFs(undefined);
  }
});

test('isCount accepts only finite non-negative numbers', () => {
  for (const value of [0, 1, 1_000_000, 1.5]) assert.equal(isCount(value), true, String(value));
  for (const value of [-1, Number.NaN, Infinity, -Infinity, '3', null, undefined, {}]) {
    assert.equal(isCount(value), false, String(value));
  }
});

/** A rotated sibling is `<base>.<UTC timestamp compact>.<pid>.jsonl`, never the live file. */
const rotatedName = (base: string): RegExp => new RegExp(`^${base}\\.\\d{8}T\\d{9}Z\\.\\d+\\.\\d+\\.jsonl(?:\\.gz)?$`);

test('rotation renames a file at the size limit and keeps appending to a new live file', async () => {
  const dir = scratchDir('jev-ledger-rotate-');
  const path = join(dir, 'decisions.jsonl');
  const row = { n: 0 };
  const one = `${JSON.stringify(row)}\n`;
  // The first row only creates the file: the check runs before the append, so a file
  // that does not exist yet cannot be at the limit. The next row finds it there.
  appendJsonLine(path, row, { rotateAtBytes: one.length * 2 });
  await flushTelemetry();
  appendJsonLine(path, { n: 1 }, { rotateAtBytes: one.length * 2 });
  appendJsonLine(path, { n: 2 }, { rotateAtBytes: one.length * 2 });
  await flushTelemetry();
  const names = readdirSync(dir);
  const rotated = names.filter(name => rotatedName('decisions').test(name)).sort();
  assert.ok(rotated.length >= 1, `expected a rotated file, got ${names.join(', ')}`);
  assert.ok(names.includes('decisions.jsonl'), 'the live file is recreated after the rename');
  const lines = names.flatMap(name => readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean));
  assert.deepEqual(lines.map(line => JSON.parse(line).n).sort((a: number, b: number) => a - b), [0, 1, 2]);
  assert.equal(lines.length, 3, 'every row lands in exactly one file');
});

test('two processes both rotate and every row lands in exactly one file', async () => {
  const dir = scratchDir('jev-ledger-rotate-mp-');
  const path = join(dir, 'decisions.jsonl');
  const perProcess = 40;
  const child = fileURLToPath(new URL('./support/ledger-rotate-child.ts', import.meta.url));
  const run = (id: string) => new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', child, path, id, String(perProcess), '20'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', chunk => { err += chunk; });
    proc.on('error', reject);
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`child ${id} exited ${code}: ${err}`)));
  });
  await Promise.all([run('a'), run('b')]);
  const files = readdirSync(dir);
  const rotated = files.filter(name => rotatedName('decisions').test(name));
  assert.ok(rotated.length >= 1, `expected rotation, got ${files.join(', ')}`);
  const seen = new Map<string, number>();
  for (const name of files) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line) continue;
      seen.set(line, (seen.get(line) ?? 0) + 1);
    }
  }
  const expected = new Set<string>();
  for (const id of ['a', 'b']) {
    for (let n = 0; n < perProcess; n++) expected.add(JSON.stringify({ id, n, pad: 'x'.repeat(n), source: 'live' }));
  }
  const missing = [...expected].filter(line => !seen.has(line));
  const duplicated = [...seen].filter(([, count]) => count !== 1);
  const extra = [...seen.keys()].filter(line => !expected.has(line));
  assert.deepEqual({ missing, duplicated, extra }, { missing: [], duplicated: [], extra: [] });
});

test('pruning deletes oldest rotated files past the byte cap and never a file modified in the last hour', async () => {
  const dir = scratchDir('jev-ledger-prune-');
  const path = join(dir, 'decisions.jsonl');
  const base = 'decisions';
  const hour = 60 * 60 * 1000;
  const aged = Date.now() - 2 * hour;
  const recent = Date.now() - 30 * 60 * 1000;
  const stamp = (when: number, pid: number): string => {
    const name = `${base}.${new Date(when).toISOString().replace(/[-:]/g, '').replace('.', '')}.${pid}.${pid}.jsonl.gz`; // already compressed: this test is about the byte cap
    writeFileSync(join(dir, name), 'x'.repeat(50));
    utimesSync(join(dir, name), when / 1000, when / 1000);
    return name;
  };
  const oldest = stamp(aged, 1); // 50 bytes, two hours old: eligible, deleted first
  const middle = stamp(aged + 1000, 2); // 50 bytes, still old: deleted to meet the cap
  const newestOld = stamp(aged + 2000, 3); // 50 bytes, old, but kept: it fits under the cap
  const young = stamp(recent, 4); // 50 bytes, inside the hour: never deleted, even over the cap
  // The live file stays under the limit, so this append only prunes; it does not rotate.
  appendJsonLine(path, { n: 1 }, { rotateAtBytes: 1_000_000, keepRotatedBytes: 50 });
  await flushTelemetry();
  const left = readdirSync(dir);
  assert.ok(!left.includes(oldest), 'the oldest rotated file past the cap is deleted');
  assert.ok(!left.includes(middle), 'deletion continues oldest-first until the rotated total fits');
  assert.ok(left.includes(newestOld), 'a rotated file inside the cap is kept');
  assert.ok(left.includes(young), 'a rotated file modified within the last hour is never unlinked');
  assert.ok(left.includes(basename(path)), 'pruning never touches the live file');
  const rotatedBytes = left
    .filter(name => rotatedName(base).test(name))
    .filter(name => Date.now() - statSync(join(dir, name)).mtimeMs >= hour)
    .reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  assert.ok(rotatedBytes <= 50, `eligible rotated bytes ${rotatedBytes} exceed the cap`);
});

test('pruning stops once the eligible total is at the cap, however young the skipped files are', async () => {
  const dir = scratchDir('jev-ledger-prune-eligible-');
  const path = join(dir, 'decisions.jsonl');
  const base = 'decisions';
  const hour = 60 * 60 * 1000;
  const aged = Date.now() - 2 * hour;
  const recent = Date.now() - 30 * 60 * 1000;
  const stamp = (when: number, pid: number, bytes: number): string => {
    const name = `${base}.${new Date(when).toISOString().replace(/[-:]/g, '').replace('.', '')}.${pid}.${pid}.jsonl.gz`; // already compressed: this test is about the byte cap
    writeFileSync(join(dir, name), 'x'.repeat(bytes));
    utimesSync(join(dir, name), when / 1000, when / 1000);
    return name;
  };
  // Three aged files, 30 bytes each: 90 eligible against a 50-byte cap. Deleting the oldest
  // leaves 60, still over, so it goes; deleting the next lands on 30, which is at or under the
  // cap, so that is where pruning stops. The 80-byte file is inside the grace hour. Counting it
  // toward the total would keep deleting aged files until the whole total, grace included,
  // reached the cap, and nothing aged would survive.
  const oldest = stamp(aged, 1, 30);
  const middle = stamp(aged + 1000, 2, 30);
  const newestOld = stamp(aged + 2000, 3, 30);
  const young = stamp(recent, 4, 80);
  appendJsonLine(path, { n: 1 }, { rotateAtBytes: 1_000_000, keepRotatedBytes: 50 });
  await flushTelemetry();
  const left = readdirSync(dir);
  assert.ok(!left.includes(oldest), 'the oldest eligible file is deleted');
  assert.ok(!left.includes(middle), 'deletion continues until the eligible total is at the cap');
  assert.ok(left.includes(newestOld), 'an aged file is kept once the eligible total is within the cap');
  assert.ok(left.includes(young), 'a file inside the grace hour is never unlinked');
  const eligible = left
    .filter(name => rotatedName(base).test(name))
    .filter(name => Date.now() - statSync(join(dir, name)).mtimeMs >= hour)
    .reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  assert.equal(eligible, 30);
});

test('pruning stops once the eligible total is at the cap, and keeps every aged file when already within it', async () => {
  const dir = scratchDir('jev-ledger-prune-exact-');
  const path = join(dir, 'decisions.jsonl');
  const base = 'decisions';
  const aged = Date.now() - 2 * 60 * 60 * 1000;
  const stamp = (when: number, pid: number, bytes: number): string => {
    const name = `${base}.${new Date(when).toISOString().replace(/[-:]/g, '').replace('.', '')}.${pid}.${pid}.jsonl.gz`; // already compressed: this test is about the byte cap
    writeFileSync(join(dir, name), 'x'.repeat(bytes));
    utimesSync(join(dir, name), when / 1000, when / 1000);
    return name;
  };
  const first = stamp(aged, 1, 25);
  const second = stamp(aged + 1000, 2, 25);
  appendJsonLine(path, { n: 1 }, { rotateAtBytes: 1_000_000, keepRotatedBytes: 50 });
  await flushTelemetry();
  const left = readdirSync(dir);
  assert.ok(left.includes(first), 'an aged file is kept when the eligible total already equals the cap');
  assert.ok(left.includes(second), 'pruning does not delete past a total that is already at the cap');
});

test('rows for one file land in call order even when an earlier write is slower', async () => {
  const path = join(tmpdir(), `jev-ledger-order-${process.pid}`, 'calls.jsonl');
  const appended: string[] = [];
  let calls = 0;
  const fs = {
    // The first row's stat takes longer than the second's: without per-path ordering the
    // second row would be appended first.
    stat: at => new Promise<{ isFile(): boolean; size: number; mtimeMs: number }>(resolve =>
      setTimeout(() => resolve({ isFile: () => true, size: 0, mtimeMs: 0 }), at === path && calls++ === 0 ? 30 : 0)),
    mkdir: async () => undefined,
    // Only this test's rows: a straggler from an earlier test may still reach the fake.
    appendFile: async (at, data) => void (at === path && appended.push(data)),
  } satisfies LedgerFs;
  setLedgerFs(fs);
  try {
    await statShape(fs);
    appendJsonLine(path, { n: 1 });
    appendJsonLine(path, { n: 2 });
    await flushTelemetry();
    assert.deepEqual(appended.map(line => JSON.parse(line).n), [1, 2]);
  } finally {
    setLedgerFs(undefined);
  }
});

// --- source marking, eval redirect and long retention ------------------------------------

/** Runs `fn` with the given env vars set (or removed when undefined), then restores them. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const readRows = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('every row carries source "live" by default and "eval" when JEV_TELEMETRY_SOURCE=eval', async () => {
  const path = scratch();
  await withEnv({ JEV_TELEMETRY_SOURCE: undefined }, async () => {
    appendJsonLine(path, { n: 1 });
    await flushTelemetry();
  });
  await withEnv({ JEV_TELEMETRY_SOURCE: 'eval' }, async () => {
    appendJsonLine(path, { n: 2 }); // not the live directory, so it is not redirected
    await flushTelemetry();
  });
  await withEnv({ JEV_TELEMETRY_SOURCE: 'something-else' }, async () => {
    appendJsonLine(path, { n: 3 });
    await flushTelemetry();
  });
  assert.deepEqual(readRows(path).map(row => [row.n, row.source]), [[1, 'live'], [2, 'eval'], [3, 'live']]);
  assert.equal(telemetrySource(), 'live');
});

test('an eval process writing the live directory is redirected to its eval/ subdirectory unless told otherwise', async () => {
  const home = scratchDir('jev-ledger-home-');
  const live = join(home, '.local', 'state', 'jev');
  await withEnv({ HOME: home, JEV_TELEMETRY_SOURCE: 'eval', JEV_TELEMETRY_EVAL_DIR: undefined }, async () => {
    appendJsonLine(join(live, 'compactions.jsonl'), { n: 1 });
    await flushTelemetry();
  });
  assert.deepEqual(readRows(join(live, 'eval', 'compactions.jsonl')).map(row => [row.n, row.source]), [[1, 'eval']]);
  assert.ok(!readdirSync(live).includes('compactions.jsonl'), 'nothing lands in the live ledger');
  const chosen = join(home, 'chosen');
  await withEnv({ HOME: home, JEV_TELEMETRY_SOURCE: 'eval', JEV_TELEMETRY_EVAL_DIR: chosen }, async () => {
    appendJsonLine(join(live, 'calls.jsonl'), { n: 2 });
    await flushTelemetry();
  });
  assert.deepEqual(readRows(join(chosen, 'calls.jsonl')).map(row => row.n), [2]);
  await withEnv({ HOME: home, JEV_TELEMETRY_SOURCE: undefined }, async () => {
    appendJsonLine(join(live, 'calls.jsonl'), { n: 3 }); // a live process is never redirected
    await flushTelemetry();
  });
  assert.deepEqual(readRows(join(live, 'calls.jsonl')).map(row => [row.n, row.source]), [[3, 'live']]);
});

test('every ledger rotates by default, without the caller passing options', async () => {
  // The default threshold is large; a stalled-free fake reports a live file already past it.
  const renamed: string[] = [];
  const appended: string[] = [];
  const path = join(tmpdir(), `jev-ledger-default-rotate-${process.pid}`, 'calls.jsonl');
  setLedgerFs({
    stat: async at => ({ isFile: () => true, size: at === path ? DEFAULT_ROTATE_AT_BYTES : 0, mtimeMs: Date.now() }),
    mkdir: async () => undefined,
    appendFile: async at => void (at === path && appended.push(at)),
    rename: async (from, to) => void (from === path && renamed.push(to)),
    readdir: async () => [],
    unlink: async () => undefined,
  });
  try {
    appendJsonLine(path, { n: 1 });
    await flushTelemetry();
    assert.equal(renamed.length, 1, 'a live file at the default threshold is rotated');
    assert.match(basename(renamed[0]!), rotatedName('calls'));
    assert.equal(appended.length, 1, 'the row is still appended');
  } finally {
    setLedgerFs(undefined);
  }
  assert.ok(DEFAULT_KEEP_ROTATED_BYTES >= 1024 * 1024 * 1024, 'years of data: at least 1 GiB of compressed siblings per ledger');
});

test('rotated siblings older than the grace hour are gzip-compressed losslessly; young ones and the live file are not', async () => {
  const dir = scratchDir('jev-ledger-gzip-');
  const path = join(dir, 'decisions.jsonl');
  const aged = Date.now() - 2 * 60 * 60 * 1000;
  const recent = Date.now() - 10 * 60 * 1000;
  const sibling = (when: number, n: number): string => {
    const name = `decisions.${new Date(when).toISOString().replace(/[-:]/g, '').replace('.', '')}.${n}.${n}.jsonl`;
    writeFileSync(join(dir, name), `${JSON.stringify({ n })}\n`.repeat(100));
    utimesSync(join(dir, name), when / 1000, when / 1000);
    return name;
  };
  const old = sibling(aged, 1);
  const young = sibling(recent, 2);
  writeFileSync(path, '{"live":true}\n');
  appendJsonLine(path, { n: 9 }, { rotateAtBytes: 1_000_000 });
  await flushTelemetry();
  const left = readdirSync(dir);
  assert.ok(!left.includes(old), 'the aged plain sibling is replaced by its compressed copy');
  assert.ok(left.includes(`${old}.gz`), `expected ${old}.gz, got ${left.join(', ')}`);
  assert.ok(left.includes(young), 'a sibling inside the grace hour is left alone');
  assert.ok(!left.some(name => name.includes('.tmp')), 'no temporary file is left behind');
  const restored = gunzipSync(readFileSync(join(dir, `${old}.gz`))).toString('utf8');
  assert.equal(restored, `${JSON.stringify({ n: 1 })}\n`.repeat(100));
  assert.deepEqual(readRows(path).map(row => row.live ?? row.n), [true, 9], 'the live file is only appended to');
});

test('pruning counts compressed siblings and deletes the oldest first, ordered by the rotation stamp', async () => {
  const dir = scratchDir('jev-ledger-prune-gz-');
  const path = join(dir, 'calls.jsonl');
  const aged = Date.now() - 3 * 60 * 60 * 1000;
  const sibling = (stampAt: number, n: number, bytes: number): string => {
    const name = `calls.${new Date(stampAt).toISOString().replace(/[-:]/g, '').replace('.', '')}.${n}.${n}.jsonl.gz`;
    writeFileSync(join(dir, name), 'x'.repeat(bytes));
    utimesSync(join(dir, name), aged / 1000, aged / 1000); // equal mtimes: only the stamp orders them
    return name;
  };
  const first = sibling(aged - 3000, 1, 40);
  const second = sibling(aged - 2000, 2, 40);
  const third = sibling(aged - 1000, 3, 40);
  appendJsonLine(path, { n: 1 }, { rotateAtBytes: 1_000_000, keepRotatedBytes: 80 });
  await flushTelemetry();
  const left = readdirSync(dir);
  assert.ok(!left.includes(first), 'the oldest stamp goes first');
  assert.ok(left.includes(second) && left.includes(third), 'pruning stops once the total fits');
});

test('maintenance removes an aged orphan gzip temporary and never a young one', async () => {
  const dir = scratchDir('jev-ledger-tmp-');
  const path = join(dir, 'calls.jsonl');
  const aged = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  const old = 'calls.20260930T000000000Z.1.0.jsonl.gz.999.tmp';
  const young = 'calls.20260930T000000000Z.1.1.jsonl.gz.998.tmp';
  const foreign = 'other.20260930T000000000Z.1.0.jsonl.gz.999.tmp';
  for (const name of [old, young, foreign]) writeFileSync(join(dir, name), 'x');
  utimesSync(join(dir, old), aged, aged);
  utimesSync(join(dir, foreign), aged, aged);
  appendJsonLine(path, { n: 1 });
  await flushTelemetry();
  const left = readdirSync(dir);
  assert.ok(!left.includes(old), 'an aged temporary of this ledger is reclaimed');
  assert.ok(left.includes(young), 'a temporary inside the grace hour may still be in use');
  assert.ok(left.includes(foreign), 'another ledger’s files are not this ledger’s to delete');
});
