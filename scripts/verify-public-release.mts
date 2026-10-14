/**
 * Automated release & leak verifier. Inspects BOTH concrete public release surfaces and
 * fails unless every file in each is free of internal references:
 *
 *   (a) the npm package: `npm pack --dry-run --json --ignore-scripts` for the file list,
 *       plus a real `npm pack --ignore-scripts` tarball extracted to a scratch directory;
 *   (b) the standalone source snapshot produced by `exportPublicRelease()` in a scratch
 *       directory, with `node_modules` symlinked in and the whole test suite run inside it
 *       under `env -i PATH HOME` (no ambient credentials, no parent-monorepo files), so
 *       100% of the standalone suite must pass outside the development tree.
 *
 * Every internal token below is built by joining split fragments, so this file itself
 * (which ships in the source snapshot and is scanned by its own check) contains no
 * literal forbidden substring. Run: node --import tsx scripts/verify-public-release.mts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { excludedReason, exportPublicRelease, listFiles, packageRoot, STANDALONE_TEST_SCRIPT } from './export-public-release.mts';

/** Joining split fragments keeps every internal token out of this file's own bytes. */
const J = (...parts: string[]): string => parts.join('');

/** Substring tokens: one occurrence anywhere in a shipped file is a leak. */
const SUBSTRING_TOKENS: readonly { label: string; token: string }[] = [
  // Internal hostnames.
  { label: 'internal hostname', token: J('sky', 'net') },
  { label: 'internal hostname', token: J('sky', 'net1') },
  { label: 'internal hostname', token: J('sky', 'net3') },
  { label: 'internal hypervisor hostname', token: J('ep', 'yc1') },
  { label: 'internal hypervisor hostname', token: J('ep', 'yc2') },
  { label: 'internal control daemon', token: J('her', 'dr') },
  { label: 'internal workload tag', token: J('w4:', 'pWR') },
  { label: 'internal workload tag', token: J('w4:', 'pS4') },
  { label: 'internal workload tag', token: J('w4:', 'pXF') },
  // Internal IP literals.
  { label: 'internal network prefix', token: J('192.168', '.') },
  // Internal paths, users and organisations.
  { label: 'internal fleet path', token: J('/srv', '/workflows') },
  { label: 'internal development path', token: J('/srv', '/dev') },
  { label: 'internal package path', token: J('/srv', '/pi') },
  { label: 'internal inference path', token: J('/srv', '/inference') },
  { label: 'internal daemon path', token: J('/srv', '/sky', 'net') },
  { label: 'internal research path', token: J('/srv', '/context-mode') },
  { label: 'internal agents path', token: J('/srv', '/agents') },
  { label: 'internal user home', token: J('/home/', 'ras') },
  { label: 'internal user handle', token: J('ras', '@') },
  { label: 'internal npm scope', token: J('@', 'ras/') },
  { label: 'internal organisation', token: J('peta', 'bit') },
  { label: 'internal flag marker', token: J('--srv', '-') },
  { label: 'internal flag marker', token: J('--home-ras', '--') },
  // Internal service and model identities.
  { label: 'internal model id', token: J('dsv41', '-flash') },
  { label: 'internal service id', token: J('zen', 'mux') },
  { label: 'internal eval campaign', token: J('compact-eval-open', 'jev27') },
  { label: 'internal model id', token: J('gpt-6', '-astra') },
  { label: 'internal model id', token: J('gpt-6.', '1-sol') },
  // Internal file artefacts and record names.
  { label: 'internal agent-state path', token: J('.p', 'i/') },
  { label: 'internal memory system', token: J('hind', 'sight') },
  { label: 'python bytecode artefact', token: J('.p', 'yc') },
  { label: 'internal session record', token: J('session', '.jsonl') },
  { label: 'internal retention record', token: J('retain-receipts', '.json') },
  { label: 'internal recall record', token: J('last-recall', '.json') },
];

/** The carrier-grade NAT address range, assembled so no address literal appears above. */
const CGNAT_RANGE = new RegExp(
  ['100', '\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])', '\\.[0-9]+', '\\.[0-9]+'].join(''),
);

export interface ForbiddenHit {
  label: string;
  excerpt: string;
}

function excerptAround(text: string, at: number, length: number): string {
  return text.slice(Math.max(0, at - 40), Math.min(text.length, at + length + 40)).replace(/\s+/g, ' ').trim();
}

/** Public GitHub owner/repository URL explicitly allowed in package metadata and docs. */
const ALLOWED_PUBLIC_REPO = 'github.com/rasatpetabit/pi-ras-compact';

/** Every forbidden match in one file's text: substring tokens first, then the address range. */
export function findForbiddenMatches(text: string): ForbiddenHit[] {
  const scrubbed = text.split(ALLOWED_PUBLIC_REPO).join('github.com/<public-owner>/pi-ras-compact');
  const hits: ForbiddenHit[] = [];
  for (const { label, token } of SUBSTRING_TOKENS) {
    let at = scrubbed.indexOf(token);
    while (at !== -1) {
      hits.push({ label, excerpt: excerptAround(scrubbed, at, token.length) });
      at = scrubbed.indexOf(token, at + 1);
    }
  }
  const range = CGNAT_RANGE.exec(scrubbed);
  if (range !== null) hits.push({ label: 'internal range address', excerpt: excerptAround(scrubbed, range.index, range[0].length) });
  return hits;
}

export interface SurfaceFinding {
  surface: string;
  path: string;
  label: string;
  excerpt: string;
}

/** Path rules plus a content scan of every file under `dir`, reported against `surface`. */
export function scanTree(surface: string, dir: string): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  for (const abs of listFiles(dir)) {
    const rel = abs.slice(dir.length + 1);
    const reason = excludedReason(rel);
    if (reason !== null) findings.push({ surface, path: rel, label: `forbidden path (${reason})`, excerpt: '' });
    for (const hit of findForbiddenMatches(readFileSync(abs, 'utf8'))) {
      findings.push({ surface, path: rel, label: hit.label, excerpt: hit.excerpt });
    }
  }
  return findings;
}

function run(command: string, args: string[], options: { cwd?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const done = spawnSync(command, args, { ...options, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}

/** The file list `npm pack --dry-run --json` reports, without running any package script. */
export function npmPackDryRunList(rootDir: string): string[] {
  const done = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: rootDir });
  if (done.status !== 0) throw new Error(`npm pack --dry-run failed:\n${done.stderr}`);
  const parsed = JSON.parse(done.stdout) as { files?: { path: string }[] }[];
  const files = parsed[0]?.files ?? [];
  if (files.length === 0) throw new Error('npm pack --dry-run reported no files');
  return files.map(f => f.path);
}

/** Packs for real (scripts disabled), extracts the tarball, and lists what it contains. */
export function npmPackExtract(rootDir: string, workDir: string): { files: string[]; extractDir: string } {
  const packDir = join(workDir, 'pack');
  const extractDir = join(workDir, 'extract');
  mkdirSync(packDir, { recursive: true });
  const done = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir], { cwd: rootDir });
  if (done.status !== 0) throw new Error(`npm pack failed:\n${done.stderr}`);
  const parsed = JSON.parse(done.stdout) as { filename?: string }[];
  const filename = parsed[0]?.filename;
  if (filename === undefined) throw new Error('npm pack --json reported no tarball filename');
  mkdirSync(extractDir, { recursive: true });
  const tar = run('tar', ['-xzf', join(packDir, filename), '-C', extractDir]);
  if (tar.status !== 0) throw new Error(`tar extraction failed:\n${tar.stderr}`);
  const packageDir = join(extractDir, 'package');
  return { files: listFiles(packageDir).map(abs => abs.slice(packageDir.length + 1)), extractDir: packageDir };
}

/**
 * Runs the snapshot's whole test suite inside the exported tree with a scrubbed
 * environment: only PATH and an empty scratch HOME survive, so nothing ambient (no
 * credentials, no parent-monorepo `config/` or `docs/`) can influence the result.
 */
export function runStandaloneSuite(snapshotDir: string, rootDir: string, workDir: string): { ok: boolean; summary: string } {
  const modules = join(rootDir, 'node_modules');
  const emptyHome = join(workDir, 'empty-home');
  mkdirSync(emptyHome, { recursive: true });
  if (!existsSync(modules)) {
    return { ok: false, summary: 'node_modules missing in the source tree; run npm install first' };
  }
  const link = join(snapshotDir, 'node_modules');
  if (existsSync(link)) {
    return { ok: false, summary: 'snapshot already contains a node_modules entry' };
  }
  symlinkSync(modules, link, 'dir');
  const done = run('env', ['-i', `PATH=${process.env.PATH ?? ''}`, `HOME=${emptyHome}`, 'sh', '-c', STANDALONE_TEST_SCRIPT], {
    cwd: snapshotDir,
  });
  const tail = `${done.stdout}\n${done.stderr}`.trim().split('\n').slice(-4).join(' | ');
  return { ok: done.status === 0, summary: `exit ${done.status ?? 'signal'}; ${tail}` };
}

export interface VerificationStep {
  name: string;
  ok: boolean;
  detail: string[];
}

export interface VerificationReport {
  rootDir: string;
  steps: VerificationStep[];
  ok: boolean;
}

function findingsStep(name: string, findings: SurfaceFinding[]): VerificationStep {
  const byPath = new Map<string, string[]>();
  for (const f of findings) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f.label]);
  return {
    name,
    ok: findings.length === 0,
    detail: [...byPath.entries()].map(([path, labels]) => `${path}: ${[...new Set(labels)].join(', ')}`),
  };
}

/**
 * The full gate: pack listing, packed tarball, exported snapshot and the standalone
 * suite run. Returns every step; `report.ok` is true only when all of them pass.
 */
export function verifyPublicRelease(rootDir: string = packageRoot(), options: { runSuite?: boolean } = {}): VerificationReport {
  const workDir = mkdtempSync(join(tmpdir(), 'pi-jev-release-verify-'));
  const steps: VerificationStep[] = [];
  try {
    // Surface (a), part 1: what npm WOULD publish, with package scripts disabled.
    try {
      const dryRun = npmPackDryRunList(rootDir);
      steps.push(findingsStep('npm pack --dry-run file list is clean', dryRun.flatMap(path => {
        const reason = excludedReason(path);
        return reason === null ? [] : [{ surface: 'npm-dry-run', path, label: `forbidden path (${reason})`, excerpt: '' }];
      })));
    } catch (error) {
      steps.push({ name: 'npm pack --dry-run file list is clean', ok: false, detail: [String(error)] });
    }

    // Surface (a), part 2: a real tarball, extracted and scanned file by file.
    try {
      const packed = npmPackExtract(rootDir, workDir);
      steps.push(findingsStep('npm pack tarball contents are clean', scanTree('npm-tarball', packed.extractDir)));
    } catch (error) {
      steps.push({ name: 'npm pack tarball contents are clean', ok: false, detail: [String(error)] });
    }

    // Surface (b): the standalone source snapshot, exported to scratch and scanned.
    try {
      const snapshotDir = join(workDir, 'snapshot');
      exportPublicRelease(rootDir, snapshotDir);
      steps.push(findingsStep('exported source snapshot is clean', scanTree('source-snapshot', snapshotDir)));
      if (options.runSuite !== false) {
        const suite = runStandaloneSuite(snapshotDir, rootDir, workDir);
        steps.push({
          name: 'standalone test suite passes with a scrubbed environment',
          ok: suite.ok,
          detail: [suite.summary],
        });
      }
    } catch (error) {
      steps.push({ name: 'exported source snapshot is clean', ok: false, detail: [String(error)] });
      if (options.runSuite !== false) {
        steps.push({ name: 'standalone test suite passes with a scrubbed environment', ok: false, detail: ['snapshot export failed; suite not run'] });
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return { rootDir: resolve(rootDir), steps, ok: steps.every(s => s.ok) };
}

function main(): void {
  const report = verifyPublicRelease();
  for (const step of report.steps) {
    console.log(`${step.ok ? 'ok' : 'FAIL'}  ${step.name}`);
    for (const line of step.detail) console.log(`     ${line}`);
  }
  console.log(report.ok ? 'public release verification: PASS' : 'public release verification: FAIL');
  process.exitCode = report.ok ? 0 : 1;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) main();
