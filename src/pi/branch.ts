/**
 * Pi session entries -> the charter's BranchMessage view. Tolerant by design: an entry
 * this adapter does not recognise is skipped, never guessed at, so a Pi format change
 * can shrink what the charter sees but never put words in the operator's mouth.
 */
import type { BranchMessage } from '../core/charter.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text parts only, joined with '\n'. Images and thinking are not text the operator or a tool produced. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map(part => (part as { text: string }).text)
    .join('\n');
}

function toolCallsOf(content: unknown): BranchMessage['toolCalls'] {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; args: unknown }> = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'toolCall') continue;
    if (typeof part.id !== 'string' || typeof part.name !== 'string') continue;
    out.push({ id: part.id, name: part.name, args: part.arguments });
  }
  return out;
}

export function branchMessages(entries: readonly unknown[]): BranchMessage[] {
  const out: BranchMessage[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== 'message' || typeof entry.id !== 'string' || !isRecord(entry.message)) continue;
    const m = entry.message;
    if (m.role === 'user') {
      out.push({ entryId: entry.id, role: 'user', text: textOf(m.content), toolCalls: [] });
    } else if (m.role === 'assistant') {
      out.push({ entryId: entry.id, role: 'assistant', text: textOf(m.content), toolCalls: toolCallsOf(m.content) });
    } else if (m.role === 'bashExecution' && !m.excludeFromContext &&
      typeof m.timestamp === 'number' && typeof m.command === 'string' && typeof m.output === 'string') {
      // Match the compaction converter's synthetic call identity exactly.
      const id = `bashexec_${m.timestamp}`;
      out.push({ entryId: entry.id, role: 'assistant', text: '', toolCalls: [{ id, name: 'bash', args: { command: m.command } }] });
      out.push({ entryId: entry.id, role: 'toolResult', text: m.output, toolCalls: [], toolCallId: id,
        isError: m.cancelled === true || (typeof m.exitCode === 'number' && m.exitCode !== 0) });
    } else if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
      out.push({ entryId: entry.id, role: 'toolResult', text: textOf(m.content), toolCalls: [], toolCallId: m.toolCallId, isError: m.isError === true });
    }
  }
  return out;
}

/** Entries strictly before the first kept entry. An absent id means the whole branch. */
export function entriesBefore(entries: readonly unknown[], firstKeptEntryId: string): unknown[] {
  const at = entries.findIndex(e => isRecord(e) && e.id === firstKeptEntryId);
  return at < 0 ? [...entries] : entries.slice(0, at);
}
