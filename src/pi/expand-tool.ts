/**
 * Registers `jev_expand` (spec: Design > Recoverable rest): the agent restores, by the id a
 * compaction stub shows, exactly what it originally saw. Read-only; reads the session's own
 * branch through `ctx.sessionManager` and never writes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { Type } from 'typebox';
import { callByHash, expand } from '../core/expand.js';
import { PENDING_RESULT } from '../core/segments.js';
import { branchMessages } from './branch.js';

interface ToolApi {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute(toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
  }): void;
}

type BranchSource = { cwd?: string; sessionManager?: { getBranch?: () => unknown[]; getEntries?: () => unknown[] } };

/**
 * For a call that named a file: how the file on disk now compares with what the call saw
 * (spec: Recoverable rest). A write is compared exactly; for anything else the file counts as
 * unchanged only when it still contains the call's result verbatim.
 */
export function fileNote(tool: string, args: unknown, resultText: string | undefined, cwd: string | undefined): string | undefined {
  const a = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const raw = typeof a.path === 'string' ? a.path.replace(/^@/, '') : undefined;
  if (!raw) return undefined;
  const path = isAbsolute(raw) || cwd === undefined ? raw : resolve(cwd, raw);
  if (!existsSync(path)) return `NOTE: ${raw} no longer exists on disk.`;
  let now: string;
  try { now = readFileSync(path, 'utf8'); } catch { return `NOTE: ${raw} could not be read now; re-read it before any edit.`; }
  const same = tool === 'write' && typeof a.content === 'string'
    ? now === a.content
    : resultText !== undefined && resultText.trim().length > 0 && now.includes(resultText.trim());
  return same
    ? `NOTE: ${raw} on disk still matches what this call saw.`
    : `NOTE: ${raw} on disk has changed since this call, or cannot be shown to match it; re-read it before any edit.`;
}

function branchOf(ctx: unknown): unknown[] | undefined {
  const manager = (ctx as BranchSource | undefined)?.sessionManager;
  if (typeof manager?.getBranch === 'function') return manager.getBranch();
  if (typeof manager?.getEntries === 'function') return manager.getEntries();
  return undefined;
}

export const EXPAND_TOOL_NAME = 'jev_expand';

/**
 * One row of expansions.jsonl: what a jev_expand call restored, as ids, hashes and counts only.
 * `seg_hash` is the restored segment's source hash (decisions.jsonl tuple index 6), so a
 * restore joins the decision that dropped or cut it. No text, path or argument is recorded.
 */
export interface ExpansionRow {
  tool_call_id: string;
  ok: boolean;
  id_kind: 'tool_result' | 'call_input' | 'user_entry' | 'answer' | 'hash' | 'invalid';
  part: 'result' | 'input';
  tool: string | null;
  seg_hash: string | null;
  chars_returned: number;
  total_chars: number | null;
  offset: number;
  limit: number | null;
  compaction_entry_id: string | null;
  attempt_id: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The ledger fields for one expansion, derived from the branch. The segment hash is computed
 * exactly as `spanToSegments` computes `srcHash`: a call is `[tool, input, result]`, an operator
 * message is its trimmed text. The compaction is the latest one in the branch after the
 * restored entry: its summary carried the stub the agent expanded.
 */
export function expansionRow(
  entries: readonly unknown[],
  toolCallId: string,
  params: Record<string, unknown>,
  result: { ok: boolean; returned?: number; total?: number; offset?: number },
  hash: (text: string) => string,
): ExpansionRow {
  const id = String(params.id ?? '').trim();
  const part: 'result' | 'input' = params.part === 'input' ? 'input' : 'result';
  const messages = branchMessages(entries);
  let kind: ExpansionRow['id_kind'] = 'invalid';
  let callId: string | undefined;
  let segHash: string | null = null;
  let tool: string | null = null;
  let sourceEntry: string | undefined;
  if (id.startsWith('u:')) {
    kind = 'user_entry';
    const m = messages.find(x => x.role === 'user' && x.entryId === id.slice(2));
    if (m) { segHash = hash(m.text.trim()); sourceEntry = m.entryId; }
  } else if (id.startsWith('h:')) {
    kind = 'hash';
    callId = callByHash(messages, id.slice(2), hash);
  } else if (id.length > 0) {
    kind = id.startsWith('a:') ? 'answer' : part === 'input' ? 'call_input' : 'tool_result';
    callId = id.startsWith('a:') ? id.slice(2) : id;
  }
  if (callId !== undefined) {
    for (const m of messages) {
      const call = m.role === 'assistant' ? m.toolCalls.find(c => c.id === callId) : undefined;
      if (!call) continue;
      const res = messages.find(x => x.role === 'toolResult' && x.toolCallId === callId);
      const input = isRecord(call.args) ? call.args : {};
      tool = call.name;
      segHash = hash(JSON.stringify([call.name, input, res?.text || PENDING_RESULT]));
      sourceEntry = m.entryId;
      break;
    }
  }
  let compactionEntryId: string | null = null;
  let attemptId: string | null = null;
  if (sourceEntry !== undefined) {
    const at = entries.findIndex(e => isRecord(e) && e.id === sourceEntry);
    for (let i = entries.length - 1; i > at && at >= 0; i--) {
      const e = entries[i];
      if (!isRecord(e) || e.type !== 'compaction') continue;
      compactionEntryId = typeof e.id === 'string' ? e.id : null;
      const jev = isRecord(e.details) && isRecord(e.details.jev) ? e.details.jev : undefined;
      attemptId = typeof jev?.attempt_id === 'string' ? jev.attempt_id : null;
      break;
    }
  }
  return {
    tool_call_id: toolCallId,
    ok: result.ok,
    id_kind: kind,
    part,
    tool,
    seg_hash: segHash,
    chars_returned: result.ok ? result.returned ?? 0 : 0,
    total_chars: result.ok ? result.total ?? null : null,
    offset: result.ok ? result.offset ?? 0 : typeof params.offset === 'number' ? params.offset : 0,
    limit: typeof params.limit === 'number' ? params.limit : null,
    compaction_entry_id: compactionEntryId,
    attempt_id: attemptId,
  };
}

/** Receives one row per jev_expand call. It must not throw; the tool guards it anyway. */
export type ExpansionSink = (row: ExpansionRow, ctx: unknown) => void;

export function registerExpandTool(pi: ToolApi, sink?: ExpansionSink): void {
  pi.registerTool({
    name: EXPAND_TOOL_NAME,
    label: 'Jev expand',
    description:
      'Restore exactly what was originally seen for something a compaction replaced with a stub or a jev_expand marker: ' +
      'a tool result, a call\'s arguments (a write\'s or edit\'s content, part "input"), an operator message or pasted block ' +
      '("u:<entry>", with the offset and limit the marker names), or an answered question ("a:<call>"). ' +
      'Returns a historical snapshot from the session record; files may have changed since.',
    promptSnippet: 'Restore compacted content by the id its stub or marker shows',
    promptGuidelines: [
      'Use jev_expand when a compacted summary shows a jev_expand(...) marker or a stub id and the original text is needed; it returns a historical snapshot, so re-read a file before quoting it in an edit.',
    ],
    parameters: Type.Object({
      id: Type.String({ description: 'The id from the stub or marker.' }),
      part: Type.Optional(Type.String({ description: 'For a tool call: "result" (default) or "input".' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Character offset to start from.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Characters to return (default 20000).' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const out = await run(params, ctx);
      if (sink) {
        try {
          const entries = branchOf(ctx) ?? [];
          const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
          sink(expansionRow(entries, String(toolCallId ?? ''), params, out.details as { ok: boolean }, hash), ctx);
        } catch {
          // The ledger never changes what the tool returns.
        }
      }
      return out;
    },
  });
}

async function run(params: Record<string, unknown>, ctx: unknown): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
  const entries = branchOf(ctx);
  if (!entries) return { content: [{ type: 'text', text: 'jev_expand: the session record is not available here' }], details: { ok: false } };
  const part = params.part === 'input' ? 'input' : params.part === undefined || params.part === 'result' ? 'result' : undefined;
  if (part === undefined) return { content: [{ type: 'text', text: 'jev_expand: part must be "result" or "input"' }], details: { ok: false } };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
  const result = expand(branchMessages(entries), {
    id: String(params.id ?? ''),
    part,
    ...(typeof params.offset === 'number' ? { offset: params.offset } : {}),
    ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
  }, hash);
  if (!result.ok) return { content: [{ type: 'text', text: result.error }], details: { ok: false } };
  const messages = branchMessages(entries);
  const id = String(params.id ?? '');
  const callId = id.startsWith('h:') || id.startsWith('u:') || id.startsWith('a:') ? undefined : id;
  const call = callId ? messages.flatMap(m => (m.role === 'assistant' ? m.toolCalls : [])).find(c => c.id === callId) : undefined;
  const seen = callId ? messages.find(m => m.role === 'toolResult' && m.toolCallId === callId)?.text : undefined;
  const note = call ? fileNote(call.name, call.args, seen, (ctx as BranchSource | undefined)?.cwd) : undefined;
  return {
    content: [{ type: 'text', text: `${note ? `${note}\n` : ''}${result.header}\n\n${result.text}` }],
    details: { ok: true, total: result.total, offset: result.offset, returned: result.returned },
  };
}
