/**
 * Public-release exporter: copies a clean, standalone source snapshot of this package
 * to a target directory, from an explicit inclusion manifest only. Anything not named
 * by the manifest stays behind, and the excluded-name rules below are enforced again
 * over the finished output as a sweep, so an internal artefact can never ride along.
 *
 * The exported package.json gets the standalone test command (this file and its
 * verifier ship in the snapshot, so the export is closed under its own manifest).
 *
 * Usage: node --import tsx scripts/export-public-release.mts --out <dir>
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Files copied verbatim. Every entry must exist; a missing entry is an error, not a skip. */
export const MANIFEST_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  '.gitignore',
  'LICENSE',
  'README.md',
  'VENDORED.md',
  'config/jev.toml',
  'config/jev.controller.toml',
  'decision-service/server.py',
  'decision-service/candidates.py',
  'decision-service/clm_schema.py',
  'decision-service/CLM-LICENSE',
  'decision-service/test_server.py',
  'decision-service/test_candidates.py',
  'decision-service/test_threads.py',
  'decision-service/README.md',
  'docs/backend-label-samples.txt',
  'scripts/backend-label-samples.mts',
  'scripts/tree-hash.ts',
  'scripts/export-public-release.mts',
  'scripts/verify-public-release.mts',
];

/** Directories copied whole (recursively), filtered entry by entry by the rules below. */
export const MANIFEST_DIRS: readonly string[] = ['src', 'test'];

/**
 * The test command written into the exported package.json: the snapshot carries its own
 * test tree, so `npm test` runs standalone with no external archives or helper scripts.
 */
export const STANDALONE_TEST_SCRIPT = 'node --import tsx --test test/*.test.ts';

/** Built from fragments so this file itself never contains the artefact suffix it bans. */
const PYC_SUFFIX = ['.p', 'yc'].join('');

/**
 * Test files that exercise internal evaluation or tooling infrastructure which does not
 * ship (the excluded `eval/` tree, or `scripts/` helpers absent from the manifest). They
 * keep running in the development tree's suite; the public snapshot carries only tests
 * whose subjects are part of it, so the standalone suite never imports a missing module.
 */
const INTERNAL_TEST_FILES: ReadonlySet<string> = new Set([
  'test/active-fit.test.ts',
  'test/charter-decisions-harness.test.ts',
  'test/charter-predicates.test.ts',
  'test/controller-native.test.ts',
  'test/drained-trial-safety.test.ts',
  'test/external-compact.test.ts',
  'test/jev-ledger-writer.test.ts',
  'test/jev-ledger.test.ts',
  'test/local-eval.test.ts',
  'test/replay-generations.test.ts',
  'test/shadow-replay.test.ts',
  'test/warrant-eval.test.ts',
]);

/**
 * Why a path may not enter the snapshot, or `null` when it may. Segment matches are exact,
 * so a file merely named like a banned word still passes; only real internal locations fail.
 */
export function excludedReason(relPath: string): string | null {
  if (INTERNAL_TEST_FILES.has(relPath)) return 'internal evaluation test';
  const parts = relPath.split(/[\\/]+/).filter(p => p.length > 0);
  if (parts.includes('.pi')) return 'agent state directory';
  if (parts.includes('__pycache__')) return 'Python bytecode cache';
  if (parts.includes('node_modules')) return 'installed dependencies';
  if (parts.includes('eval')) return 'internal trial records';
  if (parts.includes('relay')) return 'internal relay tooling';
  if (parts.includes('systemd')) return 'internal service units';
  if (parts.length > 0 && parts[parts.length - 1].endsWith(PYC_SUFFIX)) return 'compiled Python bytecode';
  if (parts[0] === 'docs' && /^recoverable-rest-.*\.json$/.test(parts[parts.length - 1] ?? '')) {
    return 'internal verification record';
  }
  if (relPath === 'docs/instruction-scope.md') return 'internal scoping record';
  return null;
}

/** Sorted recursive listing of every regular file under `dir` (dereferenced symlinks included). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      const isFile = entry.isFile() || (entry.isSymbolicLink() && statSync(full).isFile());
      if (isFile) out.push(full);
      else if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

export interface ExportResult {
  rootDir: string;
  outDir: string;
  /** Exported files, as `/`-separated paths relative to `outDir`, sorted. */
  files: string[];
  /** Manifest-tree entries refused by the exclusion rules, with the reason each was dropped. */
  excluded: { path: string; reason: string }[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The package root that ships this script (one level above `scripts/`). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Copies the public source snapshot of `rootDir` into `outDir`. `outDir` must not exist or
 * must be empty (a dirty target could mix stale private files into a "clean" export), and
 * must sit outside `rootDir`. Throws on the first problem; on success the output is swept
 * once more against `excludedReason`, so the manifest, the filter and the sweep agree.
 */
export function exportPublicRelease(rootDir: string, outDir: string): ExportResult {
  const root = resolve(rootDir);
  const out = resolve(outDir);
  if (out === root || out.startsWith(root + sep)) {
    throw new Error('output directory must lie outside the source tree');
  }
  if (existsSync(out)) {
    if (!isDirectory(out)) throw new Error(`output path exists and is not a directory: ${out}`);
    if (readdirSync(out).length > 0) throw new Error(`output directory is not empty: ${out}`);
  }

  const missing = MANIFEST_FILES.filter(f => !isFile(join(root, f)));
  if (missing.length > 0) throw new Error(`manifest entries missing under ${root}: ${missing.join(', ')}`);
  const missingDirs = MANIFEST_DIRS.filter(d => !isDirectory(join(root, d)));
  if (missingDirs.length > 0) throw new Error(`manifest directories missing under ${root}: ${missingDirs.join(', ')}`);

  const excluded: { path: string; reason: string }[] = [];
  const sources: { rel: string; abs: string }[] = [];
  const addCandidate = (rel: string, abs: string): void => {
    const reason = excludedReason(rel);
    if (reason !== null) excluded.push({ path: rel, reason });
    else sources.push({ rel, abs });
  };
  for (const rel of MANIFEST_FILES) addCandidate(rel, join(root, rel));
  for (const dir of MANIFEST_DIRS) {
    for (const abs of listFiles(join(root, dir))) addCandidate(relative(root, abs).split(sep).join('/'), abs);
  }

  mkdirSync(out, { recursive: true });
  for (const { rel, abs } of sources) {
    const target = join(out, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs, target);
  }

  // Standalone test command: the snapshot's own test tree replaces the monorepo helper.
  const pkgPath = join(out, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
  pkg.scripts = { ...pkg.scripts, test: STANDALONE_TEST_SCRIPT };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // Sweep: refuse to return an output that still contains anything the rules ban.
  for (const abs of listFiles(out)) {
    const rel = relative(out, abs).split(sep).join('/');
    const reason = excludedReason(rel);
    if (reason !== null) {
      throw new Error(`exclusion sweep failed for exported ${rel}: ${reason}`);
    }
  }

  return { rootDir: root, outDir: out, files: sources.map(s => s.rel).sort(), excluded };
}

function main(): void {
  const args = process.argv.slice(2);
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && i + 1 < args.length) out = args[++i];
    else if (args[i].startsWith('--out=')) out = args[i].slice('--out='.length);
    else {
      console.error('usage: node --import tsx scripts/export-public-release.mts --out <dir>');
      process.exitCode = 2;
      return;
    }
  }
  if (out === undefined) {
    console.error('usage: node --import tsx scripts/export-public-release.mts --out <dir>');
    process.exitCode = 2;
    return;
  }
  try {
    const result = exportPublicRelease(packageRoot(), out);
    const refused = result.excluded.length > 0 ? `, refused ${result.excluded.length} internal entries` : '';
    console.log(`exported ${result.files.length} files to ${result.outDir}${refused}`);
  } catch (error) {
    console.error(`export failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) main();
