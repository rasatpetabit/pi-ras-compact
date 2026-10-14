import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Locates an installed Pi package root without embedding any host-specific install
 * path. Resolution order: `PI_PACKAGE_DIR` (when it holds a package with
 * `dist/index.js`), then the `pi` executable found on PATH (npm bin symlink →
 * realpath → package root two levels above `dist/cli.js`).
 *
 * Returns null when no installation is found. Callers skip install-dependent
 * tests rather than assuming a location: a checkout with no Pi around it must
 * still run every unit test.
 */
let cached: string | null | undefined;

export function piInstallRoot(): string | null {
  if (cached !== undefined) return cached;
  cached = resolve();
  return cached;
}

function resolve(): string | null {
  const fromEnv = process.env.PI_PACKAGE_DIR;
  if (fromEnv && existsSync(join(fromEnv, 'dist', 'index.js'))) return fromEnv;
  try {
    const bin = execFileSync('which', ['pi'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!bin) return null;
    const cli = realpathSync(bin);
    if (!/[\\/]dist[\\/]cli\.js$/.test(cli)) return null;
    const root = dirname(dirname(cli));
    return existsSync(join(root, 'dist', 'index.js')) ? root : null;
  } catch {
    return null;
  }
}

/** The installed CLI entry (`dist/cli.js`), or null when no installation is found. */
export function piInstallCli(): string | null {
  const root = piInstallRoot();
  return root && existsSync(join(root, 'dist', 'cli.js')) ? join(root, 'dist', 'cli.js') : null;
}
