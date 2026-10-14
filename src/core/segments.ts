import type { Message } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { normaliseReadPath, instructionReader, type InstructionMatch } from './instruction.js';
import { PIN_CLASSES, type PinClass } from './pins.js';

const SEGMENT_KINDS = ['user', 'assistant', 'context', 'call', 'foreign'] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export interface CallBody {
  tool: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  /** The result was already cut to a head by an earlier compaction. */
  resultTruncated: boolean;
  /**
   * The tool-call id, so a stub can name what `jev_expand` restores. Absent on a carry
   * written before this field; such a stub keeps the old wording.
   */
  id?: string;
}

/** The unit Jev judges and the carry stores (spec: Compaction core, Segments). */
export interface Segment {
  layoutId?: string;
  kind: SegmentKind;
  text: string;
  pin: PinClass | null;
  /** The compaction generation that created the segment; pins expire by it. */
  gen: number;
  call?: CallBody;
  /**
   * The read path as matching resolved it when this segment was created, cwd included.
   * Carried matching and duplicate detection use it instead of re-resolving `call.input.path`
   * against a later compaction's cwd. Absent on a carry written before this field: those
   * reads keep the path as stored and are not re-resolved.
   */
  readPath?: string;
  /** Matching provenance; absent on legacy carries, which are revalidated before following. */
  instructionSource?: 'file' | 'reference';
  /**
   * First 12 hex of SHA-256 over the uncut source. Absent on a segment written
   * before the decision record, or dropped because the stored value was malformed.
   */
  srcHash?: string;
  /** Length of that uncut source. Travels with `srcHash`; absent means the same. */
  srcChars?: number;
}

export interface Carry {
  version: 1;
  generation: number;
  segments: Segment[];
}

export const CARRY_VERSION = 1;
/**
 * Sanity bounds for a stored carry, far above anything valid: a carry renders
 * within the summary budget. A carry beyond them is treated as opaque text.
 */
const CARRY_LIMITS = { segments: 50_000, bytes: 32 * 1024 * 1024 } as const;

export const SUMMARY_OPEN = '<compacted-conversation>';
export const SUMMARY_CLOSE = '</compacted-conversation>';
/** Our header and the interim wrapper's both start with this, so a foreign carry drops them. */
export const SUMMARY_HEADER_PREFIX = 'Earlier conversation retained ';
const WRAPPER_TAGS = new Set([SUMMARY_OPEN, SUMMARY_CLOSE, '<summary-of-earlier-context>', '</summary-of-earlier-context>']);
const FILE_LIST_BLOCK = /<(read-files|modified-files)>[\s\S]*?<\/\1>/g;
export const PENDING_RESULT = '(its result follows in the retained conversation)';

export function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[jev-compaction: ${text.length - limit} more chars not kept]`;
}

/** Cuts every string inside a tool input to `limit` characters, at any depth. */
function bounded(value: unknown, limit: number): unknown {
  if (typeof value === 'string') return cut(value, limit);
  if (Array.isArray(value)) return value.map(item => bounded(item, limit));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item, limit)]));
  }
  return value;
}

export interface SegmentOptions {
  pins: ReadonlySet<PinClass>;
  modifyTools: ReadonlySet<string>;
  /** Tool calls whose whole call+result is pinned `decision` (spec: Part 1). */
  decisionTools: ReadonlySet<string>;
  /**
   * How a fresh call matches the `instruction` pin. Absent means the class is off,
   * even when `instruction` is in `pins`: matching needs the tools and the files.
   */
  instruction?: InstructionMatch;
  /** tool_use_id of the call at Pi's split-turn boundary, if any. */
  boundaryToolUseId?: string;
  /** Longest string kept inside a tool input or a pinned result. */
  maxStoredChars: number;
  gen: number;
  /**
   * First 12 hex of a SHA-256 over the uncut source. Supplied by the node
   * adapter (`coreOptions`); the core does not import a crypto runtime.
   */
  hash: (text: string) => string;
}

function sourceOf(text: string, hash: (text: string) => string): Pick<Segment, 'srcHash' | 'srcChars'> {
  return { srcHash: hash(text), srcChars: text.length };
}

function callSegment(
  tool: string,
  input: Record<string, unknown>,
  result: string,
  isError: boolean,
  pin: PinClass | null,
  options: SegmentOptions,
  readPath?: string,
  id?: string,
): Segment {
  return {
    kind: 'call',
    text: '',
    pin,
    gen: options.gen,
    ...(readPath !== undefined ? { readPath } : {}),
    ...sourceOf(JSON.stringify([tool, input, result]), options.hash),
    call: {
      tool,
      input: bounded(input, options.maxStoredChars) as Record<string, unknown>,
      result: pin === null ? result : cut(result, options.maxStoredChars),
      isError,
      resultTruncated: false,
      ...(id !== undefined && id.length > 0 ? { id } : {}),
    },
  };
}

/**
 * Splits a converted span into segments, oldest first, and assigns pins.
 * `carried` holds the carry's segments, instruction pins included, so a reference in one
 * can pin a fresh read. The span is walked oldest first and a body's references are added
 * only after that call matches, so a read is never reclassified by a later file.
 */
export function spanToSegments(
  messages: readonly Message[],
  options: SegmentOptions,
  carried: readonly Segment[] = [],
): Segment[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { text: result.text, isError: result.isError ?? false });
    }
  }
  const pinned = (cls: PinClass): PinClass | null => (options.pins.has(cls) ? cls : null);
  const reader = options.instruction ? instructionReader(options.instruction, carried) : undefined;
  const seenCalls = new Set<string>();
  const out: Segment[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (text.length > 0) {
      const source = sourceOf(text, options.hash);
      if (message.role === 'assistant') out.push({ kind: 'assistant', text, pin: null, gen: options.gen, ...source });
      else if (message.source === 'custom') out.push({ kind: 'context', text, pin: null, gen: options.gen, ...source });
      else out.push({ kind: 'user', text, pin: pinned('user'), gen: options.gen, ...source });
    }
    for (const use of message.toolUses) {
      seenCalls.add(use.tool_use_id);
      const result = results.get(use.tool_use_id);
      const isError = result?.isError ?? false;
      const resultText = result?.text ?? '';
      const instruction = reader?.matches(use.tool, use.input.path, isError) ?? false;
      const pin =
        (options.modifyTools.has(use.tool) ? pinned('modify') : null) ??
        (options.decisionTools.has(use.tool) ? pinned('decision') : null) ??
        (isError ? pinned('error') : null) ??
        (instruction ? pinned('instruction') : null) ??
        (use.tool_use_id === options.boundaryToolUseId ? pinned('boundary') : null);
      // The stored body is what a later read can match, and only once this call is pinned:
      // an errored read has no body worth following, and a class that is not configured
      // (`pinned` returned null) does not become a source either.
      // The uncut result: the stored body is cut to the storage cap, and a reference past
      // that cut would otherwise be invisible to a later read in the same compaction.
      if (instruction && pin === 'instruction') reader?.note(use.tool, use.input.path, resultText, isError);
      // Only an instruction read stores the resolved path. Other calls keep their input as
      // written, and a carry from before this field has no readPath to re-resolve.
      const readPath =
        instruction && pin === 'instruction' ? reader?.identity(use.tool, use.input.path) : undefined;
      const segment = callSegment(use.tool, use.input, resultText || PENDING_RESULT, isError, pin, options, readPath, use.tool_use_id);
      if (pin === 'instruction') segment.instructionSource = reader?.source(use.tool, use.input.path);
      out.push(segment);
    }
    for (const result of message.toolResults ?? []) {
      if (seenCalls.has(result.tool_use_id)) continue;
      const isError = result.isError ?? false;
      out.push(callSegment('unknown', {}, result.text, isError, isError ? pinned('error') : null, options, undefined, result.tool_use_id));
    }
  }
  return out;
}

/**
 * A previous summary that is not a structured carry (Pi's own summary, the
 * interim wrapper's, or a native carry that failed validation) becomes one
 * unpinned segment per paragraph.
 */
export function foreignSegments(text: string, gen: number): Segment[] {
  const cleaned = text
    .replace(FILE_LIST_BLOCK, '')
    .split('\n')
    .filter(line => !WRAPPER_TAGS.has(line.trim()))
    .join('\n');
  return cleaned
    .split(/\n[ \t]*\n/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph.length > 0 && !paragraph.startsWith(SUMMARY_HEADER_PREFIX))
    .map(paragraph => ({ kind: 'foreign' as const, text: paragraph, pin: null, gen }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type CheckedSegment = { ok: true; segment: Segment; demoted: boolean; changed: boolean } | { ok: false };

function checkSegment(value: unknown, generation: number): CheckedSegment {
  if (!isRecord(value)) return { ok: false };
  if (typeof value.kind !== 'string' || !(SEGMENT_KINDS as readonly string[]).includes(value.kind)) return { ok: false };
  if (typeof value.text !== 'string') return { ok: false };
  if (!Number.isInteger(value.gen) || (value.gen as number) < 1 || (value.gen as number) > generation) return { ok: false };
  const pin: unknown = value.pin;
  let demoted = false;
  if (pin !== null && !(PIN_CLASSES as readonly unknown[]).includes(pin)) {
    // An unknown pin STRING is a newer writer's class, not a broken segment: demote it to
    // null and count it. A pin that is not even a string is invalid (spec: Part 1 item 7).
    if (typeof pin !== 'string') return { ok: false };
    demoted = true;
  }
  if (value.kind === 'call') {
    const call = value.call;
    if (
      !isRecord(call) ||
      typeof call.tool !== 'string' ||
      !isRecord(call.input) ||
      typeof call.result !== 'string' ||
      typeof call.isError !== 'boolean' ||
      typeof call.resultTruncated !== 'boolean'
    )
      return { ok: false };
  } else if ('call' in value) return { ok: false };
  // A source hash from before this change is simply absent. A present pair that is not a
  // 12-hex digest and an integer length is dropped from this segment, never a reason to
  // reject the carry. The pair travels together: one bad field drops both.
  const hashOk = typeof value.srcHash === 'string' && /^[0-9a-f]{12}$/.test(value.srcHash);
  const charsOk = Number.isInteger(value.srcChars) && (value.srcChars as number) >= 0;
  // Same tolerance as the source hash: a present read path that is not a non-empty string is
  // dropped from this segment. An absent one is a carry from before the field existed.
  const readPathOk = typeof value.readPath === 'string' && value.readPath.length > 0;
  const dropReadPath = 'readPath' in value && !readPathOk;
  const dropInstructionSource = 'instructionSource' in value &&
    value.instructionSource !== 'file' && value.instructionSource !== 'reference';
  const sourcePresent = 'srcHash' in value || 'srcChars' in value;
  const dropSource = sourcePresent && !(hashOk && charsOk);
  const dropLayoutId = 'layoutId' in value && (typeof value.layoutId !== 'string' || !/^s:[0-9]+:[0-9]+(?::new)*$/.test(value.layoutId) || value.layoutId.length > 128);
  if (!dropLayoutId && !demoted && !dropSource && !dropReadPath && !dropInstructionSource) return { ok: true, segment: value as unknown as Segment, demoted, changed: false };
  const segment = { ...(demoted ? { ...value, pin: null } : value) };
  if (dropSource) {
    delete segment.srcHash;
    delete segment.srcChars;
  }
  if (dropLayoutId) delete segment.layoutId;
  if (dropReadPath) delete segment.readPath;
  if (dropInstructionSource) delete segment.instructionSource;
  return {
    ok: true,
    segment: segment as unknown as Segment,
    demoted,
    changed: true,
  };
}

/**
 * Returns the carry and how many unknown pin strings the pass demoted to null,
 * when every field has the stored shape; else `undefined`. The demotion keeps a
 * carry written by newer code readable (and its other pins intact) by older code.
 */
export function validateCarry(value: unknown): { carry: Carry; demotedUnknown: number } | undefined {
  if (!isRecord(value) || value.version !== CARRY_VERSION) return undefined;
  const { generation, segments } = value;
  if (!Number.isInteger(generation) || (generation as number) < 1) return undefined;
  if (!Array.isArray(segments) || segments.length > CARRY_LIMITS.segments) return undefined;
  let bytes: number;
  try {
    bytes = JSON.stringify(value).length;
  } catch {
    return undefined;
  }
  if (bytes > CARRY_LIMITS.bytes) return undefined;
  let demotedUnknown = 0;
  let sourceDropped = false;
  const checked: unknown[] = [];
  for (const segment of segments) {
    const result = checkSegment(segment, generation as number);
    if (!result.ok) return undefined;
    if (result.demoted) demotedUnknown += 1;
    if (result.changed) sourceDropped = true;
    checked.push(result.segment);
  }
  // With no demotion and no dropped source the stored value is returned as it is, so a
  // carry round-trips unchanged, extra fields included.
  const carry = (demotedUnknown > 0 || sourceDropped ? { ...value, segments: checked } : value) as unknown as Carry;
  return { carry, demotedUnknown };
}
