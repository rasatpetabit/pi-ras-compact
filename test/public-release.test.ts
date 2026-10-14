/**
 * Packaging and leak regression test for the public release. Fast checks only:
 * publishable package metadata, negative containment of internal artefacts through
 * both release surfaces, a full forbidden-token scan of everything the exporter
 * ships, and the standalone config load of the bundled `config/jev.toml`.
 *
 * The internal artefact names below are built from joined fragments, so this file
 * (which the exporter ships) contains none of the forbidden literals it checks for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  excludedReason,
  exportPublicRelease,
  MANIFEST_FILES,
  STANDALONE_TEST_SCRIPT,
} from '../scripts/export-public-release.mts';
import { findForbiddenMatches } from '../scripts/verify-public-release.mts';
import { scratchDir } from './support/scratch.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const J = (...parts: string[]): string => parts.join('');

test('package.json declares a publishable public package', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(pkg.name, 'pi-ras-compact');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.repository, {
    type: 'git',
    url: 'git+https://github.com/rasatpetabit/pi-ras-compact.git',
  });
  assert.ok(!pkg.private, 'the public package must not be private');
  assert.ok(Array.isArray(pkg.files), 'files allowlist must be an array');
  assert.ok((pkg.files as unknown[]).length > 0, 'files allowlist must not be empty');
  assert.ok((pkg.files as string[]).includes('decision-service/CLM-LICENSE'), 'files allowlist must include CLM-LICENSE');
  assert.ok(existsSync(join(ROOT, 'LICENSE')), 'LICENSE must ship beside package.json');
  assert.ok(existsSync(join(ROOT, 'decision-service', 'CLM-LICENSE')), 'decision-service/CLM-LICENSE must exist');
});

test('neither release surface includes agent state or bytecode artefacts planted in a scratch copy', () => {
  const scratch = scratchDir('pi-jev-negative-');
  const copy = join(scratch, 'copy');
  exportPublicRelease(ROOT, copy);

  // Internal artefacts planted into the scratch copy of the package root.
  const agentDir = J('.', 'pi');
  const memoryDir = J('hind', 'sight');
  const bytecodeSuffix = J('.p', 'yc');
  const planted = [
    join(copy, agentDir, memoryDir, 'dummy.json'),
    join(copy, 'decision-service', '__pycache__', `dummy${bytecodeSuffix}`),
  ];
  for (const file of planted) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{}\n');
  }

  // Surface 1: the exporter must refuse both, and the export must not contain them.
  // (The dummies sit outside the manifest, so refusal means absence, not a rename.)
  assert.notEqual(excludedReason(join(agentDir, memoryDir, 'dummy.json')), null, 'agent state path must be classified as excluded');
  assert.notEqual(
    excludedReason(join('decision-service', '__pycache__', `dummy${bytecodeSuffix}`)),
    null,
    'bytecode cache path must be classified as excluded',
  );
  const out = join(scratch, 're-export');
  const exported = exportPublicRelease(copy, out);
  for (const file of exported.files) assert.equal(excludedReason(file), null, `exported ${file} must be allowed`);
  for (const file of planted) {
    const rel = file.slice(copy.length + 1);
    assert.ok(!exported.files.includes(rel), `export must not contain ${rel}`);
    assert.ok(!existsSync(join(out, rel)), `exported tree must not contain ${rel}`);
  }

  // Surface 2: npm pack must not include them either (and no excluded path at all).
  const done = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: copy,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(done.status, 0, `npm pack --dry-run failed: ${done.stderr}`);
  const packed = (JSON.parse(done.stdout) as { files: { path: string }[] }[])[0].files.map(f => f.path);
  for (const path of packed) {
    assert.equal(excludedReason(path), null, `npm pack must not include excluded path ${path}`);
  }
  for (const file of planted) {
    const rel = file.slice(copy.length + 1);
    assert.ok(!packed.includes(rel), `npm pack must not include ${rel}`);
  }
});

test('every file the exporter ships is free of internal references', () => {
  const scratch = scratchDir('pi-jev-leakscan-');
  const snapshot = join(scratch, 'snapshot');
  const { files } = exportPublicRelease(ROOT, snapshot);

  const manifest = new Set(MANIFEST_FILES);
  const shipped = files.filter(f => !manifest.has(f));
  assert.ok(shipped.length > 0, 'the export must contain more than the fixed manifest files');
  assert.ok(files.includes(join('scripts', 'export-public-release.mts')), 'the exporter ships itself');
  assert.ok(files.includes(join('test', 'public-release.test.ts')), 'this test ships in the snapshot');

  const leaks: string[] = [];
  for (const rel of files) {
    assert.equal(excludedReason(rel), null, `exported path ${rel} must be allowed`);
    for (const hit of findForbiddenMatches(readFileSync(join(snapshot, rel), 'utf8'))) {
      leaks.push(`${rel}: ${hit.label} — ${hit.excerpt}`);
    }
  }
  assert.deepEqual(leaks, [], `internal references leaked into the public snapshot:\n${leaks.join('\n')}`);

  const exportedPkg = JSON.parse(readFileSync(join(snapshot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(exportedPkg.scripts?.test, STANDALONE_TEST_SCRIPT, 'the snapshot must test standalone');
});

test('every relative import in the snapshot resolves inside the snapshot', () => {
  const scratch = scratchDir('pi-jev-imports-');
  const snapshot = join(scratch, 'snapshot');
  const { files } = exportPublicRelease(ROOT, snapshot);

  // tsx/tsc ESM mapping: a specifier may name the emitted form of a TS source.
  const candidates = (specifier: string): string[] => [
    specifier,
    `${specifier}.ts`,
    `${specifier}.tsx`,
    specifier.replace(/\.js$/, '.ts'),
    specifier.replace(/\.mjs$/, '.mts'),
    join(specifier, 'index.ts'),
  ];
  const importRe = /(?:\bfrom\s*|\bimport\s*|\bimport\s*\()['"](\.[^'"]+)['"]/g;
  const unresolved: string[] = [];
  for (const rel of files.filter(f => /^(?:src|test|scripts)\//.test(f))) {
    if (!/\.(?:ts|mts|mjs|js)$/.test(rel)) continue;
    const text = readFileSync(join(snapshot, rel), 'utf8');
    for (const match of text.matchAll(importRe)) {
      const specifier = match[1]!;
      const base = resolve(dirname(join(snapshot, rel)), specifier);
      const ok = candidates(base).some(c => existsSync(c));
      if (!ok) unresolved.push(`${rel}: ${specifier}`);
    }
  }
  assert.deepEqual(unresolved, [], `shipped files import modules absent from the snapshot:\n${unresolved.join('\n')}`);
});

test('the bundled config loads in the exported snapshot with no parent-monorepo config', async () => {
  const scratch = scratchDir('pi-jev-config-');
  const snapshot = join(scratch, 'snapshot');
  exportPublicRelease(ROOT, snapshot);

  // The precondition: the snapshot's parent is bare scratch, so no ../../.. config exists.
  assert.ok(!existsSync(join(snapshot, '..', 'config')), 'no parent config/ may exist beside the snapshot');
  assert.ok(!existsSync(join(snapshot, '..', 'docs')), 'no parent docs/ may exist beside the snapshot');

  // The suite run symlinks node_modules into the snapshot; do the same for this import.
  symlinkSync(join(ROOT, 'node_modules'), join(snapshot, 'node_modules'), 'dir');

  const saved = process.env.JEV_CONFIG_PATH;
  delete process.env.JEV_CONFIG_PATH;
  try {
    const configModule = (await import(pathToFileURL(join(snapshot, 'src/client/config.ts')).href)) as {
      loadConfig: (path?: string) => { ok: boolean; errors?: string[]; hash?: string };
    };
    const byDefault = configModule.loadConfig();
    assert.ok(byDefault.ok, `default load must use the bundled config: ${byDefault.errors?.join(', ')}`);
    const explicit = configModule.loadConfig(join(snapshot, 'config', 'jev.toml'));
    assert.ok(explicit.ok, `bundled config must validate standalone: ${explicit.errors?.join(', ')}`);
    assert.match(explicit.hash ?? '', /^[0-9a-f]{12}$/, 'a valid load carries its provenance hash');
  } finally {
    if (saved !== undefined) process.env.JEV_CONFIG_PATH = saved;
    else delete process.env.JEV_CONFIG_PATH;
    rmSync(join(snapshot, 'node_modules'), { force: true });
  }
});
