/**
 * Run by `extension.test.ts` as a child process. Reproduces the Pi CLI's exit
 * channel: `main.js` runs the installed `runPrintMode`, keeps a nonzero
 * `process.exitCode` an extension set, and only overrides it when runPrintMode
 * itself fails. Importing the installed release means this is the real CLI code
 * path, not a stub; the stub is only the agent session `runPrintMode` drives.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { JevError } from '../../src/client/jev-client.js';
import { handleCompact, type Deps, type HookContext } from '../../src/pi/extension.js';
import { piEvent, testDeps, TEST_MODEL } from './pi-event.js';
import { scratchDir } from './scratch.js';

const piBin = execFileSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).trim();
const releaseRoot = piBin.length > 0 ? dirname(dirname(realpathSync(piBin))) : undefined;
const cliEntry = releaseRoot ? join(releaseRoot, 'dist', 'cli.js') : undefined;
if (!releaseRoot || !cliEntry || !existsSync(cliEntry)) {
  console.log(JSON.stringify({ skip: 'no installed Pi CLI release' }));
  process.exit(0);
}
// Make this process look like the Pi CLI: `pi` is a symlink to dist/cli.js, and Node reports
// the symlink path as argv[1], so isPiCliProcess() must resolve it.
const cliLink = join(scratchDir('jev-cli-link-'), 'pi');
symlinkSync(cliEntry, cliLink);
process.argv[1] = cliLink;

const deps: Deps = testDeps({
  stderr: () => {},
  makeAsker: () => ({ ask: async () => { throw new JevError('network', 'x'); } }),
});
const ctx: HookContext = {
  mode: 'print',
  hasUI: false,
  model: { contextWindow: 1_048_576, provider: TEST_MODEL.provider, id: TEST_MODEL.id },
  ui: { notify: () => {}, setStatus: () => {} },
};

// The hook must cancel and set the exit code; reset it so the run below is what proves the channel.
const hookResult = await handleCompact(piEvent(), ctx, deps);
process.exitCode = 0;

const { runPrintMode } = (await import(`${releaseRoot}/dist/modes/print-mode.js`)) as {
  runPrintMode: (runtime: unknown, options: { mode: string; messages?: string[] }) => Promise<number>;
};

const session = {
  subscribe: () => () => {},
  bindExtensions: async () => {},
  waitForIdle: async () => {},
  prompt: async () => {
    await handleCompact(piEvent(), ctx, deps);
  },
  state: { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }] },
  sessionManager: { getHeader: () => undefined },
  agent: { subscribe: () => () => {} },
};
const runtime = { session, setRebindSession: () => {}, dispose: async () => {} };

const runPrintModeResult = await runPrintMode(runtime, { mode: 'text', messages: ['go'] });
console.log(JSON.stringify({ hookResult, runPrintModeResult, processExitCode: process.exitCode }));
