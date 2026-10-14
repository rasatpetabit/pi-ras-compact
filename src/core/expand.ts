/**
 * `jev_expand`: returns exactly the bytes the agent originally saw for something a
 * compaction stubbed, read from the session's own entries (spec: Design > Recoverable rest).
 * Read-only and paged; an unknown id is a plain error.
 */
import type { BranchMessage } from './charter.js';
import { PENDING_RESULT } from './segments.js';

export interface ExpandRequest {
  /**
   * A tool-call id from a stub, `u:<entryId>` for an operator message, `a:<toolCallId>` for an
   * answer, or `h:<srcHash>` for a stub carried from before ids existed.
   */
  id: string;
  /** For a tool call: `result` (default) or `input` (the call's arguments, e.g. a write's content). */
  part?: 'result' | 'input';
  offset?: number;
  limit?: number;
}

export type ExpandResult =
  | { ok: true; text: string; header: string; total: number; offset: number; returned: number }
  | { ok: false; error: string };

export const EXPAND_DEFAULT_LIMIT = 20_000;
export const EXPAND_MAX_LIMIT = 100_000;

const HISTORICAL =
  'Historical snapshot: exactly what the agent saw at the time, restored from the session record. ' +
  'Files may have changed since; re-read a file before quoting it in an edit.';

/** Arguments as the call carried them. A string argument (a write's content) is returned as-is. */
function inputText(args: unknown): string {
  if (typeof args === 'string') return args;
  if (typeof args === 'object' && args !== null) {
    const a = args as Record<string, unknown>;
    const keys = Object.keys(a);
    // A single-body call (write content, edit text) reads best as its body; everything else as JSON.
    if (keys.length === 2 && typeof a.path === 'string' && typeof a.content === 'string') return a.content;
  }
  return JSON.stringify(args, null, 2);
}

/**
 * The call a source hash names: the one whose `[tool, arguments, result]` hashes to it, exactly as
 * segments compute `srcHash`. Repeated calls are interchangeable only when their
 * complete source snapshots are byte-identical. Hash collisions remain ambiguous.
 */
export function callByHash(messages: readonly BranchMessage[], srcHash: string, hash: (text: string) => string): string | undefined {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, m.text);
  const found: string[] = [];
  const snapshots = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.toolCalls) {
      const input = typeof c.args === 'object' && c.args !== null ? c.args : {};
      const snapshot = JSON.stringify([c.name, c.args, results.get(c.id)]);
      if (hash(JSON.stringify([c.name, input, results.get(c.id) || PENDING_RESULT])) === srcHash) {
        found.push(c.id);
        snapshots.add(snapshot);
      }
    }
  }
  return found.length > 0 && snapshots.size === 1 ? found[0] : undefined;
}

export function expand(messages: readonly BranchMessage[], request: ExpandRequest, hash?: (text: string) => string): ExpandResult {
  const id = typeof request.id === 'string' ? request.id.trim() : '';
  if (id.length === 0) return { ok: false, error: 'jev_expand: id is required' };
  const offset = Math.max(0, Math.floor(Number(request.offset ?? 0)) || 0);
  const limit = Math.min(EXPAND_MAX_LIMIT, Math.max(1, Math.floor(Number(request.limit ?? EXPAND_DEFAULT_LIMIT)) || EXPAND_DEFAULT_LIMIT));

  let full: string | undefined;
  let what: string;
  if (id.startsWith('h:')) {
    const callId = hash ? callByHash(messages, id.slice(2), hash) : undefined;
    if (callId === undefined) return { ok: false, error: `jev_expand: no single call in this session matches ${JSON.stringify(id)}` };
    return expand(messages, { ...request, id: callId }, hash);
  }
  if (id.startsWith('u:')) {
    const entryId = id.slice(2);
    full = messages.find(m => m.role === 'user' && m.entryId === entryId)?.text;
    what = `operator message ${entryId}`;
  } else {
    const callId = id.startsWith('a:') ? id.slice(2) : id;
    const call = messages.flatMap(m => (m.role === 'assistant' ? m.toolCalls : [])).find(c => c.id === callId);
    const part = id.startsWith('a:') ? 'result' : request.part ?? 'result';
    if (part === 'input') {
      full = call ? inputText(call.args) : undefined;
      what = call ? `arguments of ${call.name} call ${callId}` : `call ${callId}`;
    } else {
      const result = messages.find(m => m.role === 'toolResult' && m.toolCallId === callId);
      full = result?.text;
      what = call ? `result of ${call.name} call ${callId}${result?.isError ? ' (an error)' : ''}` : `result of call ${callId}`;
    }
  }
  if (full === undefined) return { ok: false, error: `jev_expand: no ${request.part === 'input' ? 'call' : 'entry'} with id ${JSON.stringify(id)} in this session` };
  const text = full.slice(offset, offset + limit);
  const end = offset + text.length;
  const more = end < full.length ? ` More remains: call again with offset=${end}.` : '';
  const header = `${HISTORICAL}\n${what}: characters ${offset}–${end} of ${full.length}.${more}`;
  return { ok: true, text, header, total: full.length, offset, returned: text.length };
}
