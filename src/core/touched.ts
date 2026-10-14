/**
 * Touched paths (win-rule set, 2026-09-30): every path a tool call on the branch named, whether
 * or not the judge kept the call. Judge-independent and deterministic, a few hundred tokens, and
 * it survives a compaction whose pins alone exceed the budget. Of the win-rule set's 16 misses,
 * 5 were paths named only in `ls`, `bash` or `grep` arguments; Pi's own read/modified file lists
 * do not see those tools.
 */
import type { BranchMessage } from './charter.js';

/** Path-shaped tokens inside a string argument (a shell command, a glob base, a search root). */
const PATH_TOKEN = /(?:^|[\s"'`=(:,])((?:~|\.{1,2})?\/[\w.@+%-]+(?:\/[\w.@+%-]+)*\/?|[\w.@+%-]+(?:\/[\w.@+%-]+)+\/?)/g;
const PATH_KEY = /(path|file|dir|root|cwd)s?$/i;
const NOT_A_PATH = /^(https?:|\/dev\/null$|\/\/)/;

export function pathsInArgs(args: unknown): string[] {
  const out: string[] = [];
  const visit = (key: string, value: unknown): void => {
    if (typeof value === 'string') {
      if (PATH_KEY.test(key)) { if (value.length > 0 && value.length < 400) out.push(value); return; }
      if (key === 'command' || key === 'cmd' || key === 'script') {
        for (const m of value.matchAll(PATH_TOKEN)) if (m[1] && !NOT_A_PATH.test(m[1])) out.push(m[1]);
      }
    } else if (Array.isArray(value)) {
      for (const v of value) visit(key, v);
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(k, v);
    }
  };
  visit('', args);
  return out;
}

const norm = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '') || p;

/** Tools whose result is a path list: a path at the start of a line (grep's `path:line:` too). */
export const LISTING_TOOLS: ReadonlySet<string> = new Set(['ls', 'glob', 'find', 'grep', 'rg']);
const LINE_PATH = /^\s*((?:~|\.{1,2})?\/[\w.@+%-]+(?:\/[\w.@+%-]+)*\/?|[\w.@+%-]+(?:\/[\w.@+%-]+)+\/?)(?=[\s:]|$)/;

export function pathsInListing(text: string, maxLines = 400): string[] {
  const out: string[] = [];
  for (const line of text.split('\n').slice(0, maxLines)) {
    const m = LINE_PATH.exec(line);
    if (m?.[1] && !NOT_A_PATH.test(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Distinct paths named by tool calls in `messages`, newest first, at most `max`. Paths already in
 * `except` (Pi's read and modified lists) are left out.
 */
export function touchedPaths(messages: readonly BranchMessage[], except: Iterable<string>, max: number, listings = false): { paths: string[]; omitted: number } {
  const skip = new Set([...except].map(norm));
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  const toolOf = new Map<string, string>();
  if (listings) for (const m of messages) for (const c of m.toolCalls) toolOf.set(c.id, c.name);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (listings && m.role === 'toolResult' && m.toolCallId !== undefined && !m.isError && LISTING_TOOLS.has(toolOf.get(m.toolCallId) ?? '')) {
      for (const raw of pathsInListing(m.text)) {
        const p = norm(raw);
        if (p.length < 2 || skip.has(p) || seen.has(p)) continue;
        seen.add(p);
        newestFirst.push(p);
      }
      continue;
    }
    if (m.role !== 'assistant') continue;
    for (let c = m.toolCalls.length - 1; c >= 0; c--) {
      for (const raw of pathsInArgs(m.toolCalls[c]!.args)) {
        const p = norm(raw);
        if (p.length < 2 || skip.has(p) || seen.has(p)) continue;
        seen.add(p);
        newestFirst.push(p);
      }
    }
  }
  return { paths: newestFirst.slice(0, max), omitted: Math.max(0, newestFirst.length - max) };
}

export function renderTouched(touched: { paths: string[]; omitted: number }): string {
  if (touched.paths.length === 0) return '';
  const lines = [...(touched.omitted > 0 ? [`(${touched.omitted} earlier paths not listed)`] : []), ...touched.paths];
  return `\n\n<touched-paths>\n${lines.join('\n')}\n</touched-paths>`;
}
