import { cut, SUMMARY_CLOSE, SUMMARY_HEADER_PREFIX, SUMMARY_OPEN, type Segment } from './segments.js';

export type SegmentStatus = 'keep' | 'truncate' | 'drop';

export interface RenderOptions {
  maxArgChars: number;
  maxArgCharsPinned: number;
  modifyTools: ReadonlySet<string>;
  truncateHeadChars: number;
  /**
   * Live context (spec: pi-jev-compact-cachelane, Live context): a pinned write's body, and an
   * edit's replacement text above `stubEditChars`, render as a stub (path, size, lines, head,
   * restore id) instead of in full; the file is on disk and jev_expand restores the exact
   * arguments. Absent is off.
   */
  stubWrites?: boolean;
  stubEditChars?: number;
}

const STUB_HEAD_LINES = 5;

function headLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(0, n).join('\n') + (lines.length > n ? '\n…' : '');
}

/** A stubbed modification: what changed and where, and the call that restores it exactly. */
export function modifyStub(segment: Segment, options: RenderOptions): string | undefined {
  const call = segment.call;
  if (!call || segment.pin === null || !options.modifyTools.has(call.tool)) return undefined;
  const id = restoreId(call.id, segment.srcHash);
  const restore = id ? `jev_expand(${JSON.stringify(id)}, part="input")` : undefined;
  if (!restore) return undefined;
  const path = typeof call.input.path === 'string' ? call.input.path : '(no path)';
  if (options.stubWrites === true && call.tool === 'write' && typeof call.input.content === 'string') {
    const body = call.input.content;
    if (body.length <= 400) return undefined;
    return `write path=${path} [body stubbed: ${body.split('\n').length} lines, ${body.length} chars; the file is on disk, and ${restore} restores exactly what was written. First lines:]\n${headLines(body, STUB_HEAD_LINES)}`;
  }
  if (options.stubEditChars !== undefined && call.tool === 'edit') {
    const size = JSON.stringify(call.input).length;
    if (size <= options.stubEditChars) return undefined;
    const edits = Array.isArray(call.input.edits) ? call.input.edits.length : 1;
    return `edit path=${path} [${edits} edit${edits === 1 ? '' : 's'} stubbed: ${size} chars; ${restore} restores the exact old and new text]`;
  }
  return undefined;
}

export const SUMMARY_HEADER = `${SUMMARY_HEADER_PREFIX}verbatim by Jev selective compaction. A cut or stubbed tool result or argument names the jev_expand call that restores it exactly; call it instead of re-running the tool.`;

/** Resolve old carries in the same order as result truncation: id, valid source hash, neither. */
function restoreId(id?: string, srcHash?: string): string | undefined {
  return typeof id === 'string' && id.length > 0 ? id
    : typeof srcHash === 'string' && /^[0-9a-f]{12}$/.test(srcHash) ? `h:${srcHash}` : undefined;
}

function restoreText(id?: string, srcHash?: string, input = false): string | undefined {
  const target = restoreId(id, srcHash);
  return target === undefined ? undefined : input
    ? `jev_expand(${JSON.stringify(target)}, part="input") restores the full arguments`
    : `jev_expand(${JSON.stringify(target)}) restores it exactly`;
}

/** Link only bare storage/render caps; an existing link is historical content. */
export function linkCapMarkers(text: string, restore?: string): string {
  return restore === undefined ? text : text.replace(
    /\[jev-compaction: \d+ more chars not kept\]/g,
    marker => `${marker.slice(0, -1)}; ${restore}]`,
  );
}

/** Per-rendered-segment counts, so multiple stubs in one segment count only once. */
export function stubCounts(rendered: string): { capped: number; stubbed: number; unlinked: number } {
  return {
    capped: /\[jev-compaction: \d+ more chars not kept(?:; [^\n]*?)?\]/.test(rendered) ? 1 : 0,
    stubbed: /jev_expand\("[^"\n]+"(?:, part="input")?\) restores /.test(rendered) ? 1 : 0,
    unlinked: /\[jev-compaction: \d+ more chars not kept\]|; re-run the tool if needed\]|\[args cut; no restore id\]/.test(rendered) ? 1 : 0,
  };
}

function flat(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = '[unserializable]';
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** One line, each argument cut to `limit` characters (the upstream format). */
export function compactCall(tool: string, input: Record<string, unknown>, limit: number, restore?: string): string {
  let elided = false;
  const args = Object.entries(input)
    .map(([key, value]) => {
      const text = flat(value);
      if (text.length > limit) elided = true;
      return `${key}=${linkCapMarkers(text.length <= limit ? text : `${text.slice(0, limit - 1)}…`, restore)}`;
    })
    .join(' ');
  const call = args.length > 0 ? `${tool}(${args})` : tool;
  return elided ? `${call} [args cut; ${restore ?? 'no restore id'}]` : call;
}

/** Keeps whitespace so a kept edit stays usable; cut as a whole at `limit` with a marker. */
export function pinnedCall(tool: string, input: Record<string, unknown>, limit: number, restore?: string): string {
  const body = Object.entries(input)
    .map(([key, value]) => `--- ${key}\n${typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value))}`)
    .join('\n');
  return linkCapMarkers(cut(body.length > 0 ? `${tool}\n${body}` : tool, limit), restore);
}

/** A bounded head of a dropped result plus a note (the upstream format). */
export function truncatedResult(text: string, isError: boolean, headChars: number, id?: string, srcHash?: string): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  // With the call's id the stub names the exact restore. A carry from before the id existed
  // names the call's source hash, which jev_expand matches on the branch; with neither, the
  // stub keeps the old advice.
  const how = restoreText(id, srcHash) ?? 're-run the tool if needed';
  return `${head}[jev-compaction truncated ${text.length - headChars} chars of this tool result${isError ? ' (error)' : ''}; ${how}]`;
}

const OLD_ADVICE = '; re-run the tool if needed]';

/** A stub cut by an earlier compaction, rendered with the restore it now has: by id, else by source hash. */
export function restoreHint(stored: string, id?: string, srcHash?: string): string {
  if (!stored.endsWith(OLD_ADVICE)) return stored;
  const how = restoreText(id, srcHash);
  return how === undefined ? stored : `${stored.slice(0, -OLD_ADVICE.length)}; ${how}]`;
}

export function renderSegment(segment: Segment, status: SegmentStatus, options: RenderOptions): string {
  switch (segment.kind) {
    case 'user':
      return `[User]: ${segment.text}`;
    case 'assistant':
      return `[Assistant]: ${segment.text}`;
    case 'context':
      return `[Context]: ${segment.text}`;
    case 'foreign':
      return segment.text;
    case 'call': {
      const call = segment.call!;
      const inputRestore = restoreText(call.id, segment.srcHash, true);
      const head =
        segment.pin !== null && options.modifyTools.has(call.tool)
          ? modifyStub(segment, options) ?? pinnedCall(call.tool, call.input, options.maxArgCharsPinned, inputRestore)
          : compactCall(call.tool, call.input, options.maxArgChars, inputRestore);
      const result =
        status === 'truncate' && !call.resultTruncated
          ? truncatedResult(call.result, call.isError, options.truncateHeadChars, call.id, segment.srcHash)
          : call.resultTruncated
            ? restoreHint(call.result, call.id, segment.srcHash)
            : linkCapMarkers(call.result, restoreText(call.id, segment.srcHash));
      // trimEnd, not trim: a kept output's first-line indentation is content.
      return `[Assistant tool call]: ${linkCapMarkers(head, inputRestore)}\n[Tool result${call.isError ? ' (error)' : ''}]: ${result.trimEnd()}`;
    }
  }
}

function header(goal: string): string {
  const oneParagraph = goal.trim().replace(/\n[ \t]*\n+/g, '\n');
  return oneParagraph.length > 0 ? `${SUMMARY_HEADER}\nOngoing goal: ${oneParagraph}` : SUMMARY_HEADER;
}

/** One flat wrapper, whatever the carry held: no nested earlier-summary blocks. */
export function renderSummary(parts: readonly string[], goal: string): string {
  return [SUMMARY_OPEN, header(goal), ...parts, SUMMARY_CLOSE].join('\n\n');
}

/** `renderSummary([], goal).length`; every part adds its own length plus 2. */
export function summaryOverheadChars(goal: string): number {
  return renderSummary([], goal).length;
}

export interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
  omittedRead: number;
  omittedModified: number;
}

/** Unique entries, each at the position of its last occurrence. */
function newestUnique(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out.reverse();
}

/** Merges older and newer lists; a modified file is never also listed as read; the newest `max` of each stay. */
export function mergeFileLists(
  older: { read: readonly string[]; modified: readonly string[] },
  newer: { read: readonly string[]; modified: readonly string[] },
  max: number,
): FileLists {
  const modified = newestUnique([...older.modified, ...newer.modified]);
  const isModified = new Set(modified);
  const read = newestUnique([...older.read, ...newer.read]).filter(file => !isModified.has(file));
  return {
    readFiles: read.slice(-max),
    modifiedFiles: modified.slice(-max),
    omittedRead: Math.max(0, read.length - max),
    omittedModified: Math.max(0, modified.length - max),
  };
}

/** The Pi-format blocks appended after the summary; `''` when both lists are empty. */
export function renderFileLists(lists: FileLists): string {
  const block = (tag: string, files: string[], omitted: number): string | undefined =>
    files.length === 0
      ? undefined
      : `<${tag}>\n${[...(omitted > 0 ? [`(${omitted} earlier files not listed)`] : []), ...files].join('\n')}\n</${tag}>`;
  const blocks = [
    block('read-files', lists.readFiles, lists.omittedRead),
    block('modified-files', lists.modifiedFiles, lists.omittedModified),
  ].filter((text): text is string => text !== undefined);
  return blocks.length > 0 ? `\n\n${blocks.join('\n\n')}` : '';
}
