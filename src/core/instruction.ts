import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, posix } from 'node:path';
import type { Segment } from './segments.js';

/**
 * How many path-like tokens one source may contribute. The cap is per source — the system
 * prompt, then each carried instruction pin, then each span instruction read — so one
 * saturated source cannot spend the next source's budget (spec amendment 2026-09-26).
 */
export const INSTRUCTION_REF_LIMIT = 5_000;

/**
 * A path-like token: an absolute path, a `~/` path, or a relative path that contains a `/`
 * or ends in a configured instruction basename. A terminal `/` is kept (a directory
 * reference); backticks, quotes and `.,;:!?)]}>»` are stripped, and a `§` anchor drops
 * itself and everything after it. The slash is not punctuation.
 */
const TOKEN = /(?:~\/|\/)?[A-Za-z0-9._~@+-]+(?:\/[A-Za-z0-9._~@+-]+)*\/?/g;
const TRAILING = /[`'".,;:!?)\]}>»]+$/;

/**
 * Absolute references name exact files, never subtrees, so the filesystem root is never
 * one. Directory references must be source-local; `referencesOf` bounds those. The rules
 * are lexical — no excluded-directory list is consulted.
 */
function safeReference(token: string): boolean {
  if (token.startsWith('/') || token.startsWith('~/')) {
    return !token.endsWith('/') && normalize(expandHome(token)) !== '/';
  }
  return token !== '~' && token !== '.' && token !== '..' && token !== './' && token !== '../';
}

export type InstructionSource = 'file' | 'reference';

/** Explicit configuration and instruction basenames remain whole, outside the reference cap. */
export function isInstructionFile(match: InstructionMatch, tool: string, path: unknown): boolean {
  if (!match.tools.has(tool)) return false;
  const normalised = normaliseReadPath(path, match.cwd);
  return normalised !== undefined &&
    (match.files.has(basename(normalised)) || match.paths.some(prefix => normalised.startsWith(prefix)));
}

export interface InstructionMatch {
  tools: ReadonlySet<string>;
  files: ReadonlySet<string>;
  /** Path prefixes. Empty means prefix matching is off (the loader default). */
  paths: readonly string[];
  followReferences: boolean;
  /** Absolute and `~` references taken from the system prompt. Already extracted. */
  instructionRefs: readonly string[];
  /** Session cwd. Absent leaves a relative read unresolved. */
  cwd?: string;
}

/** Expands a leading `~` or `~/`, then normalises. Anything else is unchanged. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * The read's path as matching sees it. A relative path is resolved against `cwd` when one
 * was supplied and left as written, normalised, when it was not.
 */
export function normaliseReadPath(raw: unknown, cwd: string | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const expanded = normalize(expandHome(raw));
  if (isAbsolute(expanded) || cwd === undefined) return expanded;
  return normalize(join(cwd, expanded));
}

/** A token the prompt seam keeps: absolute, or home-relative. Relative tokens are not. */
function isPromptReference(token: string): boolean {
  return token.startsWith('/') || token.startsWith('~/');
}

/** Reference strings from rendered prompt text: absolute and `~` tokens only. */
export function promptReferences(text: string): string[] {
  return extractReferences(text, new Set(), isPromptReference);
}

/**
 * Path-like tokens in `text`, in order, capped at {@link INSTRUCTION_REF_LIMIT}. A basename
 * in `files` keeps a relative token that has no `/`. `keep`, when given, drops a token before
 * it spends the cap, so ineligible tokens cannot fill the window.
 */
export function extractReferences(
  text: string,
  files: ReadonlySet<string>,
  keep?: (token: string) => boolean,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // `matchAll` walks the whole text. The cap limits what is kept, not how far the scan
  // reads: a body whose first 5,000 tokens are noise must still yield a later real path.
  for (const match of text.matchAll(TOKEN)) {
    if (found.length >= INSTRUCTION_REF_LIMIT) break;
    let token = match[0]!.replace(/§.*$/, '').replace(TRAILING, '');
    if (token.length === 0 || !safeReference(token)) continue;
    const bare = !token.startsWith('/') && !token.startsWith('~/');
    if (bare && !token.includes('/') && !files.has(token)) continue;
    if (keep !== undefined && !keep(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
}

/** Whether `path` is the reference or, for a reference ending in `/`, a file under it. */
function covers(reference: string, path: string): boolean {
  if (reference.endsWith('/')) return path.startsWith(reference);
  return path === reference;
}

/**
 * The references one instruction read contributes, resolved the way a later read is compared.
 * A resolved source resolves relative references against its own directory. An unresolved
 * source joins them onto the source path as written, and also keeps the reference as written,
 * so both the literal join and the bare token match (spec amendment 2026-09-26).
 */
function referencesOf(source: string, body: string, files: ReadonlySet<string>, resolved: boolean): string[] {
  const out: string[] = [];
  for (const token of extractReferences(body, files)) {
    if (token.startsWith('/') || token.startsWith('~/')) {
      out.push(normalize(expandHome(token)));
      continue;
    }
    const directory = source.endsWith('/') ? source : posix.dirname(source);
    const joined = normalize(posix.join(directory, token));
    // Preserve skill-local `references/`, but never let `../`, `./` or a climb to the root
    // widen scope: a subtree reference resolves strictly below the source's own directory.
    const relative = posix.relative(normalize(directory), joined);
    if (joined === '/' || (joined.endsWith('/') &&
      (relative === '' || relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)))) continue;
    out.push(joined);
    if (!resolved) out.push(normalize(token));
  }
  return out;
}

export interface InstructionReader {
  /**
   * The read path as this compaction resolves it, for a tool in `instruction_tools`.
   * Undefined for any other tool, or for an input with no path. Matching is separate:
   * the identity is stored even when the read is not an instruction read, so a later
   * compaction does not resolve it again.
   */
  identity(tool: string, path: unknown): string | undefined;
  /** True when this call is an instruction read. Scanning its body widens `note`. */
  matches(tool: string, path: unknown, isError: boolean): boolean;
  /** Why the read matched, used to bound followed references separately from whole files. */
  source(tool: string, path: unknown): InstructionSource | undefined;
  /** Adds the body's references. No effect once `followReferences` is off or the cap is hit. */
  note(tool: string, path: unknown, body: string, isError: boolean): void;
}

/**
 * The path carried matching uses. A segment that stored its resolution keeps it. A segment
 * from before that field keeps the path as stored: absolute and `~` still normalise, and a
 * relative path is not resolved against a cwd this segment never saw.
 */
export function carriedReadPath(segment: { readPath?: string; call?: { input: { path?: unknown } } }): string | undefined {
  if (typeof segment.readPath === 'string' && segment.readPath.length > 0) return segment.readPath;
  return normaliseReadPath(segment.call?.input.path, undefined);
}

/**
 * One compaction's matcher. Seed it with the carried instruction pins before the span walk;
 * `note` then extends it in order, so a reference pins only a later read.
 */
export function instructionReader(match: InstructionMatch, carried: readonly Segment[]): InstructionReader {
  const files = match.files;
  const refs: string[] = [];
  // Each source gets its own budget. A prompt that yields the limit must not stop a carried
  // pin, or a fresh read, from contributing the references a later read needs.
  const add = (items: readonly string[]): void => {
    let added = 0;
    for (const item of items) {
      if (added >= INSTRUCTION_REF_LIMIT) return;
      refs.push(item);
      added += 1;
    }
  };
  if (match.followReferences) {
    // The adapter already extracted these. They are one source, so they share one budget;
    // charging `add` per reference would let a long prompt contribute past the cap.
    add(match.instructionRefs.filter(safeReference).map(ref => normalize(expandHome(ref))));
    for (const segment of carried) {
      if (segment.pin !== 'instruction' || !segment.call) continue;
      const source = carriedReadPath(segment);
      if (source === undefined) continue;
      add(referencesOf(source, segment.call.result, files, isAbsolute(source)));
    }
  }
  const identity = (tool: string, path: unknown): string | undefined => {
    if (!match.tools.has(tool)) return undefined;
    return normaliseReadPath(path, match.cwd);
  };
  const matches = (tool: string, path: unknown): string | undefined => {
    const normalised = identity(tool, path);
    if (normalised === undefined) return undefined;
    if (isInstructionFile(match, tool, path)) return normalised;
    if (match.followReferences && refs.some(ref => covers(ref, normalised))) return normalised;
    return undefined;
  };
  return {
    identity,
    source(tool, path) {
      if (isInstructionFile(match, tool, path)) return 'file';
      return matches(tool, path) !== undefined ? 'reference' : undefined;
    },
    matches(tool, path, _isError) {
      // An error does not stop the match. The pin chain decides: with `error` configured it
      // wins, and without it the read is still an instruction read (spec amendment).
      return matches(tool, path) !== undefined;
    },
    note(tool, path, body, isError) {
      if (!match.followReferences || isError) return;
      const normalised = matches(tool, path);
      if (normalised === undefined) return;
      add(referencesOf(normalised, body, files, isAbsolute(normalised)));
    },
  };
}
