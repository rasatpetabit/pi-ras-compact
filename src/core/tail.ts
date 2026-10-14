/** Versioned boundary-only representation. Never used as stored compaction content. */
export const TAIL_PROFILE = 'complete-boundary-v2';
export interface BoundaryEvidence {
  lastOperatorRequest: TailEntry | null;
  /** Structural response evidence only; the model must judge whether it answered the request. */
  responseAfterRequest: boolean;
  terminalAssistant: boolean;
  openCalls: string[];
}
export const TAIL_STAGES = [
  { text: [1400, 600], args: [700, 300], result: [400, 200] },
  { text: [700, 300], args: [140, 60], result: [200, 100] },
  { text: [400, 150], args: [40, 20], result: [100, 50] },
] as const;
export type CallState = 'resolved' | 'unresolved' | 'unknown';
export interface TailBlock {
  kind: string; text?: string; name?: string; ref?: string; status?: 'ok' | 'error' | 'unknown';
  unresolved?: boolean; ambiguous?: boolean; crossBoundary?: boolean; unavailable?: string;
}
export interface TailEntry { ordinal: number; kind: string; role?: string; blocks: TailBlock[] }
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Key sorting makes arguments independent of insertion order. */
export function stableJSON(v: any): string {
  return JSON.stringify(v, (_k, value) => object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value) ?? 'null';
}
export function abridge(text: string, head: number, tail: number): string {
  const chars = Array.from(text);
  if (chars.length <= head + tail) return text;
  return chars.slice(0, head).join('') + `[${chars.length - head - tail} chars omitted]` + (tail ? chars.slice(-tail).join('') : '');
}
export function renderTail(entries: readonly TailEntry[], stage: number): string {
  const caps = TAIL_STAGES[stage]!;
  return JSON.stringify({ representation: TAIL_PROFILE, stage: stage + 1, entries: entries.map(entry => {
    // One aggregate source-character cap for all text blocks, preserving descriptors/order.
    const textBlocks = entry.blocks.filter(b => b.kind === 'text');
    const total = textBlocks.reduce((n, b) => n + Array.from(b.text ?? '').length, 0);
    let offset = 0;
    return { ...entry, blocks: entry.blocks.map(block => {
      if (block.text === undefined) return { ...block };
      const chars = Array.from(block.text), size = chars.length;
      let text: string;
      if (block.kind === 'text' && total > caps.text[0] + caps.text[1]) {
        const head = Math.max(0, Math.min(size, caps.text[0] - offset));
        const tail = Math.max(0, Math.min(size - head, offset + size - (total - caps.text[1])));
        text = abridge(block.text, head, tail); offset += size;
      } else {
        const cap = block.kind === 'call' ? caps.args : block.kind === 'result' ? caps.result : caps.text;
        text = abridge(block.text, cap[0], cap[1]);
      }
      return { ...block, text, originalChars: size };
    }) };
  }) });
}

/** Scan original captured entries, not converted messages or sampled result candidates. */
export function capturedTail(branch: readonly any[], preparation: any, leafId: string): {
  entries: TailEntry[]; summarizedCallState: CallState; retainedCallState: CallState; boundaryEvidence: BoundaryEvidence;
} {
  const unknown = () => ({ entries: [], summarizedCallState: 'unknown' as const, retainedCallState: 'unknown' as const,
    boundaryEvidence: { lastOperatorRequest: null, responseAfterRequest: false, terminalAssistant: false, openCalls: [] } });
  const leaf = branch.findIndex(e => e.id === leafId);
  const at = branch.findIndex(e => e.id === preparation.firstKeptEntryId);
  if (leaf < 0 || at < 0 || at > leaf || new Set(branch.slice(0, leaf + 1).map(e => e.id)).size !== leaf + 1 ||
      !Array.isArray(preparation.messagesToSummarize) || !Array.isArray(preparation.turnPrefixMessages)) return unknown();
  const captured = branch.slice(0, leaf + 1);
  const calls: Array<{ id: string; name: string; args: string; entry: number; block: number; ref: string }> = [];
  const results: Array<{ id: string; entry: number }> = [];
  let unsupported = false;
  const blocksOf = (m: any): any[] => typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m?.content) ? m.content : [];
  captured.forEach((e, entry) => {
    if (e.type !== 'message') return;
    if (!object(e.message) || (e.message.content !== undefined && typeof e.message.content !== 'string' && !Array.isArray(e.message.content))) unsupported = true;
    if (e.message?.role === 'toolResult') {
      if (typeof e.message.toolCallId !== 'string' || !e.message.toolCallId) unsupported = true;
      else results.push({ id: e.message.toolCallId, entry });
    }
    blocksOf(e.message).forEach((b, block) => {
      if (b?.type === 'toolCall') {
        if (typeof b.id !== 'string' || !b.id || typeof b.name !== 'string' || !b.name || !object(b.arguments)) unsupported = true;
        else calls.push({ id: b.id, name: b.name, args: stableJSON(b.arguments), entry, block, ref: `c${calls.length}` });
      } else if (b?.type === 'tool_use' || b?.type === 'function_call') unsupported = true;
    });
    if (e.message?.tool_calls) unsupported = true;
  });
  const pairing = (c: typeof calls[number]) => {
    const rs = results.filter(r => r.id === c.id), cs = calls.filter(x => x.id === c.id);
    const ambiguous = cs.length !== 1 || rs.length > 1 || (rs.length === 1 && rs[0]!.entry <= c.entry);
    const unresolved = rs.length === 0;
    return { unresolved, ambiguous, crossBoundary: !ambiguous && !unresolved && (c.entry < at) !== (rs[0]!.entry < at) };
  };
  let summarized: CallState = unsupported ? 'unknown' : 'resolved';
  const projected = new Map<string, number>();
  // Native projections may rebuild messages: verify original call block identity by value.
  for (const m of [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]) {
    if (!object(m) || (m.content !== undefined && typeof m.content !== 'string' && !Array.isArray(m.content)) || m.tool_calls) summarized = 'unknown';
    for (const b of blocksOf(m)) {
      if (b?.type === 'toolCall') {
        const matches = calls.filter(c => c.id === b.id && c.name === b.name && c.args === stableJSON(b.arguments));
        if (matches.length !== 1 || pairing(matches[0]!).ambiguous) summarized = 'unknown';
        else {
          const c = matches[0]!; projected.set(c.ref, (projected.get(c.ref) ?? 0) + 1);
          if (pairing(c).unresolved && summarized !== 'unknown') summarized = 'unresolved';
        }
      } else if (b?.type === 'tool_use' || b?.type === 'function_call') summarized = 'unknown';
    }
  }
  // Coverage is bidirectional: omitted native blocks must not silently certify raw calls.
  // Calls archived before the last compaction are not in the current summarized span.
  let from = 0;
  for (let i = 0; i < at; i++) if (captured[i].type === 'compaction') from = i + 1;
  if (calls.some(c => c.entry >= from && c.entry < at && projected.get(c.ref) !== 1) ||
      [...projected.values()].some(n => n !== 1)) summarized = 'unknown';
  let retained: CallState = unsupported ? 'unknown' : 'resolved';
  for (const c of calls.filter(c => c.entry >= at)) {
    if (pairing(c).ambiguous) retained = 'unknown';
    else if (pairing(c).unresolved && retained !== 'unknown') retained = 'unresolved';
  }
  const entries = captured.slice(at).map((e, i): TailEntry => {
    const message = e.type === 'message' ? e.message : e.type === 'custom_message' ? { role: 'custom', content: e.content } : undefined;
    const role = typeof message?.role === 'string' ? message.role : undefined;
    const blocks = blocksOf(message).map((b, block): TailBlock => {
      const c = calls.find(c => c.entry === at + i && c.block === block);
      if (c) return { kind: 'call', name: c.name, ref: c.ref, text: c.args, ...pairing(c) };
      if (role === 'toolResult') {
        const matches = calls.filter(c => c.id === message.toolCallId);
        const c = matches.length === 1 ? matches[0] : undefined;
        return { kind: 'result', name: typeof message.toolName === 'string' ? message.toolName : 'unknown',
          ref: c?.ref, status: message.isError === true ? 'error' : message.isError === false ? 'ok' : 'unknown',
          ambiguous: !c || pairing(c).ambiguous, crossBoundary: c ? pairing(c).crossBoundary : false,
          ...(typeof b?.text === 'string' ? { text: b.text } : { unavailable: 'unsupported tool result block' }) };
      }
      if (b?.type === 'text' && typeof b.text === 'string') return { kind: 'text', text: b.text };
      if (b?.type === 'thinking' && typeof b.thinking === 'string') return { kind: 'thinking', text: b.thinking };
      return { kind: typeof b?.type === 'string' ? b.type : 'unknown', unavailable: 'content unavailable; uncertainty required' };
    });
    // Include complete custom/workflow/control payloads and metadata. No guessed whitelist of
    // irrelevant records: a queued-work notice may be decisive even when it has no message role.
    if (!message) blocks.push({ kind: typeof e.type === 'string' ? e.type : 'unknown', text: stableJSON(e) });
    if (e.type === 'custom_message') blocks.unshift({ kind: 'custom_metadata', text: stableJSON({ customType: e.customType, details: e.details }) });
    if (!blocks.length) blocks.push({ kind: 'empty', unavailable: message?.content === undefined ? 'content unavailable; uncertainty required' : 'empty content' });
    return { ordinal: i + 1, kind: typeof e.type === 'string' ? e.type : 'unknown', ...(role ? { role } : {}), blocks };
  });
  const userAt = captured.findLastIndex(e => e.type === 'message' && e.message?.role === 'user');
  const user = captured[userAt]?.message;
  const lastOperatorRequest: TailEntry | null = userAt < 0 ? null : {
    ordinal: userAt + 1, kind: 'message', role: 'user', blocks: blocksOf(user).map(b =>
      b?.type === 'text' && typeof b.text === 'string' ? { kind: 'text', text: b.text }
        : { kind: 'unknown', unavailable: 'operator content unavailable' }),
  };
  const leafMessage = captured[leaf]?.message;
  const terminalAssistant = leafMessage?.role === 'assistant' && leafMessage.stopReason === 'stop' &&
    !blocksOf(leafMessage).some(b => b?.type === 'toolCall');
  const boundaryEvidence = { lastOperatorRequest, responseAfterRequest: userAt >= 0 && leaf > userAt && terminalAssistant,
    terminalAssistant, openCalls: calls.filter(c => c.entry >= from && (pairing(c).unresolved || pairing(c).ambiguous)).map(c => c.ref) };
  return { entries, summarizedCallState: summarized, retainedCallState: retained, boundaryEvidence };
}
