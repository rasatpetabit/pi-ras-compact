/**
 * Session charter: the session's directives, carried verbatim through every compaction
 * (a deliberate carry rule: directives are preserved word for word, never summarized).
 *
 * The charter is derived from the session's own entries, not from the previous summary:
 * every operator message and every answered question before the compaction point is a
 * charter entry, however many compactions ago it was written. What the carry adds is
 * only the retirement state (which entries were corrected, dropped or finished), keyed
 * by the stable session entry id. So a session whose earlier compactions came from Pi,
 * from the old pi-jev carry, or from nothing at all gets its full charter at the next
 * compaction, and no entry can be lost by a carry that failed to parse.
 *
 * Nothing here writes text. Every entry's text is a slice of its source entry, with
 * machine-produced text (pasted logs and tool output, expanded skill bodies)
 * replaced by a marker that names the exact byte range, so `jev_expand` can restore it.
 */

/** A session message as the charter reads it. The Pi adapter builds these from branch entries. */
export interface BranchMessage {
  /** Pi session entry id. Stable across compactions and forks. */
  entryId: string;
  role: 'user' | 'assistant' | 'toolResult' | 'other';
  /** Text parts joined with '\n'. */
  text: string;
  toolCalls: ReadonlyArray<{ id: string; name: string; args: unknown }>;
  /** For a tool result: the call it answers. */
  toolCallId?: string;
  isError?: boolean;
}

export type CharterKind = 'said' | 'answered';
export type RetireReason = 'corrected' | 'dropped' | 'done' | 'superseded';

export interface PastedRange {
  /** Character offsets into the source text, [start, end). */
  start: number;
  end: number;
  lines: number;
  why: PasteRule;
}

export type PasteRule = 'log' | 'skill' | 'tool_output';

export interface CharterEntry {
  /** `u:<entryId>` for an operator message, `a:<toolCallId>` for an answered question. */
  id: string;
  kind: CharterKind;
  entryId: string;
  /** Rendered text: the source with pasted ranges replaced by markers. */
  text: string;
  /** Characters of the full source text. */
  sourceChars: number;
  /** Hash of the full source text (the node adapter supplies the function). */
  sourceHash: string;
  pasted: PastedRange[];
  /** Position in the branch, oldest first. */
  order: number;
}

/** What the carry keeps about the charter: retirement state only. */
export interface CharterState {
  version: 1;
  retired: Record<string, { reason: RetireReason; by: string | null; gen: number }>;
}

export const EMPTY_CHARTER_STATE: CharterState = Object.freeze({ version: 1, retired: Object.freeze({}) }) as CharterState;

export interface CharterOptions {
  /** Tools whose call + result is an operator answer (ask_user_question and friends). */
  decisionTools: ReadonlySet<string>;
  /** First 12 hex of a SHA-256. */
  hash: (text: string) => string;
  /** A log run shorter than this many lines stays verbatim. */
  pasteMinLines: number;
  /** A run matching a session tool result is stubbed only at this many characters or more. */
  toolOutputMinChars: number;
}

export const DEFAULT_PASTE_MIN_LINES = 12;
export const DEFAULT_TOOL_OUTPUT_MIN_CHARS = 600;

// ---------------------------------------------------------------------------------------------
// Pasted-bulk detection (deterministic)
// ---------------------------------------------------------------------------------------------

/** A line that looks like machine output rather than something typed. */
const LOGGY = [
  /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, // ISO timestamp
  /^\s*\[?\d{2}:\d{2}:\d{2}/, // clock time
  /^\s*at [\w$.<>]+ \(.*:\d+:\d+\)\s*$/, // JS stack frame
  /^\s*File ".*", line \d+/, // Python stack frame
  /^Traceback \(most recent call last\):/,
  /^\s*\d+\s*[|:│]\s/, // numbered source listing
  /^\s*[{[].*[}\]],?\s*$/, // JSON line
  /^\s*(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/,
  /^\s*[\w.-]+@[\w.-]+:[~/].*[$#] /, // shell prompt
  /^\s*[-drwxlsStT]{10}[.@+]?\s+\d+/, // ls -l
  /^[+-]{3} |^@@ .* @@/, // diff headers
  /^\s*\$ \S/, // shell command echo
];
const loggy = (line: string): boolean => line.trim().length > 0 && LOGGY.some(re => re.test(line));

interface Line { text: string; start: number; end: number }

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ text: text.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return out;
}

/** Ranges end at the end of their last line; the newline after them stays in the prose. */
function rangeOf(lines: Line[], from: number, to: number, why: PasteRule): PastedRange {
  return { start: lines[from]!.start, end: lines[to]!.end, lines: to - from + 1, why };
}

/**
 * Pasted ranges in an operator message, sorted and non-overlapping. Only text that provably came
 * from a machine is selected: an expanded skill body, a log- or trace-shaped run, or a run that
 * reproduces a session tool result. A fenced block or a JSON/YAML document is not stubbed for its
 * shape alone, because the operator may have written it (spec amendment after the spec-gate review,
 * F3); when rules conflict, the text stays.
 * `toolOutputs` are the session's tool result texts; a run of the message that reproduces
 * one of them (the operator pasting output back) is stubbed.
 */
export function detectPasted(text: string, options: Pick<CharterOptions, 'pasteMinLines' | 'toolOutputMinChars'>, toolOutputs: readonly string[] = []): PastedRange[] {
  const min = options.pasteMinLines;
  const lines = splitLines(text);
  const ranges: PastedRange[] = [];
  const taken = new Array<boolean>(lines.length).fill(false);
  // 1. Expanded skill bodies: `<skill name=...>` ... `</skill>`, any length.
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*<skill\b[^>]*>/.test(lines[i]!.text)) continue;
    let j = i;
    while (j < lines.length && !/<\/skill>\s*$/.test(lines[j]!.text)) j++;
    if (j >= lines.length) break;
    ranges.push(rangeOf(lines, i, j, 'skill'));
    for (let k = i; k <= j; k++) taken[k] = true;
    i = j;
  }
  // 2. Log-shaped runs: at least `min` consecutive lines, 80% of the non-empty ones loggy.
  for (let i = 0; i < lines.length; i++) {
    if (taken[i] || !loggy(lines[i]!.text)) continue;
    let j = i;
    let hits = 0;
    let nonEmpty = 0;
    let lastLoggy = i;
    while (j < lines.length && !taken[j]) {
      const t = lines[j]!.text;
      if (t.trim().length > 0) {
        nonEmpty++;
        if (loggy(t)) { hits++; lastLoggy = j; }
        else if (j - lastLoggy > 2) break; // three prose lines in a row end the run
      }
      j++;
    }
    const span = lastLoggy - i + 1;
    if (span >= min && hits / Math.max(nonEmpty, 1) >= 0.8) {
      ranges.push(rangeOf(lines, i, lastLoggy, 'log'));
      for (let k = i; k <= lastLoggy; k++) taken[k] = true;
    }
    i = Math.max(i, lastLoggy);
  }
  // 3. Runs that reproduce a session tool result.
  for (const output of toolOutputs) {
    if (output.length < options.toolOutputMinChars) continue;
    const probe = output.trim();
    if (probe.length < options.toolOutputMinChars) continue;
    let at = text.indexOf(probe);
    while (at >= 0) {
      const end = at + probe.length;
      const overlaps = ranges.some(r => at < r.end && end > r.start);
      if (!overlaps) ranges.push({ start: at, end, lines: probe.split('\n').length, why: 'tool_output' });
      at = text.indexOf(probe, end);
    }
  }
  return ranges.sort((x, y) => x.start - y.start);
}

/** The block's first line, clipped, so a mis-stubbed block is still visible in context. */
function firstLine(text: string, r: PastedRange): string {
  const line = text.slice(r.start, r.end).split('\n', 1)[0]!.trim();
  return line.length <= 100 ? line : `${line.slice(0, 100)}…`;
}

export const pastedMarker = (entryId: string, r: PastedRange, text = ''): string => {
  const head = text.length > 0 ? `, first line: ${JSON.stringify(firstLine(text, r))}` : '';
  return `[pasted ${r.why}: ${r.lines} line${r.lines === 1 ? '' : 's'}, ${r.end - r.start} chars${head} — jev_expand("u:${entryId}", offset=${r.start}, limit=${r.end - r.start})]`;
};

/** The source with each pasted range replaced by its marker. */
export function withMarkers(entryId: string, text: string, ranges: readonly PastedRange[]): string {
  let out = '';
  let at = 0;
  for (const r of ranges) {
    out += text.slice(at, r.start) + pastedMarker(entryId, r, text);
    at = r.end;
  }
  return out + text.slice(at);
}

/**
 * Verifies an entry against its source: every character outside the pasted ranges is the
 * source's own, in order, and each range is exactly its marker. A failure means the entry
 * was not built from this source and must not be rendered as the operator's words.
 */
export function verifyEntry(entry: CharterEntry, source: string, hash: (text: string) => string): boolean {
  if (hash(source) !== entry.sourceHash || source.length !== entry.sourceChars) return false;
  if (entry.kind === 'answered') return entry.pasted.length === 0 && entry.text.endsWith(`\nA: ${source.trim()}`);
  return withMarkers(entry.entryId, source, entry.pasted) === entry.text;
}

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

/** The questions of an ask_user_question-style call, as the agent wrote them. */
function questionsOf(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return [];
  const a = args as Record<string, unknown>;
  const list = Array.isArray(a.questions) ? a.questions : [a];
  const out: string[] = [];
  for (const q of list) {
    if (typeof q === 'object' && q !== null && typeof (q as Record<string, unknown>).question === 'string') {
      out.push(((q as Record<string, unknown>).question as string).trim());
    }
  }
  return out;
}

/**
 * Every operator message and every answered question in `messages` (the branch before the
 * compaction point, oldest first), in branch order. Deterministic: the same branch always
 * yields the same entries.
 */
export function captureCharter(messages: readonly BranchMessage[], options: CharterOptions): CharterEntry[] {
  const outputs = messages.filter(m => m.role === 'toolResult' && !m.isError).map(m => m.text);
  const results = new Map<string, BranchMessage>();
  for (const m of messages) if (m.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, m);
  const entries: CharterEntry[] = [];
  messages.forEach((m, order) => {
    if (m.role === 'user') {
      const source = m.text;
      if (source.trim().length === 0) return;
      const pasted = detectPasted(source, options, outputs);
      entries.push({
        id: `u:${m.entryId}`,
        kind: 'said',
        entryId: m.entryId,
        text: withMarkers(m.entryId, source, pasted),
        sourceChars: source.length,
        sourceHash: options.hash(source),
        pasted,
        order,
      });
      return;
    }
    if (m.role !== 'assistant') return;
    for (const call of m.toolCalls) {
      if (!options.decisionTools.has(call.name)) continue;
      const result = results.get(call.id);
      if (!result || result.isError || result.text.trim().length === 0) continue;
      const qs = questionsOf(call.args);
      // The answer text is the tool result, verbatim. The questions are the agent's own words
      // and are shown only to make the answer readable.
      const text = `${qs.map(q => `Q: ${q}`).join('\n')}\nA: ${result.text.trim()}`;
      entries.push({
        id: `a:${call.id}`,
        kind: 'answered',
        entryId: result.entryId,
        text,
        sourceChars: result.text.length,
        sourceHash: options.hash(result.text),
        pasted: [],
        order,
      });
    }
  });
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Carry state and rendering
// ---------------------------------------------------------------------------------------------

/** Parses a carried charter state. Anything unreadable is the empty state: no entry is ever retired by a bad carry. */
export function readCharterState(raw: unknown): CharterState {
  if (typeof raw !== 'object' || raw === null) return { version: 1, retired: {} };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.retired !== 'object' || r.retired === null || Array.isArray(r.retired)) return { version: 1, retired: {} };
  const retired: CharterState['retired'] = {};
  const reasons = new Set<RetireReason>(['corrected', 'dropped', 'done', 'superseded']);
  for (const [id, v] of Object.entries(r.retired as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const x = v as Record<string, unknown>;
    if (!reasons.has(x.reason as RetireReason) || typeof x.gen !== 'number') continue;
    Object.defineProperty(retired, id, {
      value: { reason: x.reason as RetireReason, by: typeof x.by === 'string' ? x.by : null, gen: x.gen },
      enumerable: true, writable: true, configurable: true,
    });
  }
  return { version: 1, retired };
}

export const CHARTER_HEADER = '## Session charter';
export const CHARTER_PREAMBLE =
  'Every message the operator typed in this session and every answer they gave, verbatim, oldest first. ' +
  'These are standing unless a later entry corrects them; they are carried in full at every compaction. ' +
  'Pasted output is replaced by a jev_expand marker that restores it exactly.';

/**
 * Whether the charter renders this entry. A live entry is shown, and so is one retired as
 * `corrected`: a correction is often meaningful only beside what it corrects ("Make it 60 minutes
 * instead."), and a wrong whole-entry call must not hide a clause that still applies. It is shown
 * as ordinary verbatim history, with no label; the preamble already says a later entry prevails.
 * Entries `dropped`, `done` or `superseded` are retired and therefore left out of the render.
 */
export function shownInCharter(id: string, state: CharterState): boolean {
  if (!Object.prototype.hasOwnProperty.call(state.retired, id)) return true;
  return state.retired[id]!.reason === 'corrected';
}

export function renderCharter(entries: readonly CharterEntry[], state: CharterState): string {
  const live = entries.filter(e => shownInCharter(e.id, state));
  if (live.length === 0) return '';
  const lines: string[] = [CHARTER_HEADER, CHARTER_PREAMBLE, ''];
  for (const e of live) {
    const tag = e.kind === 'said' ? 'operator' : 'answer';
    lines.push(`[${tag} ${e.id}]`);
    lines.push(e.text);
    lines.push('');
  }
  const retired = entries.length - live.length;
  if (retired > 0) lines.push(`(${retired} earlier entr${retired === 1 ? 'y was' : 'ies were'} retired as dropped, finished or superseded; jev_expand restores any of them by id.)`, '');
  return lines.join('\n');
}

/** Characters the rendered charter adds, including the blank-line separator before the summary. */
export function charterChars(entries: readonly CharterEntry[], state: CharterState): number {
  const text = renderCharter(entries, state);
  return text.length === 0 ? 0 : text.length + 1;
}
