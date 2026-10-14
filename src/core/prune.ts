import type { Message } from '../vendor/pi-jev/vendor/fast-jev-compaction/index.js';
import { carriedReadPath, instructionReader, isInstructionFile, type InstructionMatch } from './instruction.js';
import { judge, statusAt, VERDICT_ID, type CoreAsker, type JudgeRound, type Verdict } from './judge.js';
import { PIN_CLASSES, type PinClass } from './pins.js';
import {
  renderSegment,
  renderSummary,
  summaryOverheadChars,
  stubCounts,
  truncatedResult,
  type RenderOptions,
  type SegmentStatus,
} from './render.js';
import { CARRY_VERSION, foreignSegments, spanToSegments, type Carry, type Segment } from './segments.js';

export interface CoreOptions {
  /**
   * The session charter carries operator messages and answered questions verbatim outside
   * the pool (spec: pi-jev-compact-cachelane, Design > Charter), so with it on those segments
   * are not judged, pinned or rendered here. Absent is off.
   */
  charter?: boolean;
  /** Live-context stubs for pinned modifications (spec: Live context). Absent is off. */
  stubWrites?: boolean;
  stubEditChars?: number;
  /** Backfill unused budget with the strongest judged-out segments (see `backfill` below). */
  backfill?: boolean;
  /** Backfill floor: a judged-out segment comes back only when its strongest answer reaches this. */
  backfillMin?: number;
  /** Backfill only `read` results of files a modify call in the pool touched (files under active edit). */
  backfillActiveReads?: boolean;
  pins: ReadonlySet<PinClass>;
  modifyTools: ReadonlySet<string>;
  /** Tool calls whose whole call+result is pinned `decision` (spec: Part 1). */
  decisionTools: ReadonlySet<string>;
  pinGenerations: number;
  /** Generations a decision pin survives, independent of pinGenerations. */
  decisionPinGenerations: number;
  /** Cap on the stored size of a retained decision answer. */
  decisionPinMaxChars: number;
  /** Tool calls that can be pinned `instruction`, and the files and prefixes that match. */
  instructionTools: ReadonlySet<string>;
  instructionFiles: ReadonlySet<string>;
  instructionPaths: readonly string[];
  instructionFollowReferences: boolean;
  /** Generations an instruction pin survives, independent of pinGenerations. */
  instructionPinGenerations: number;
  /** Cap on the rendered size of retained instruction reads. Separate from the decision cap. */
  instructionPinMaxChars: number;
  keepThreshold: number;
  borderline: number;
  thresholdSchedule: readonly number[];
  truncateHeadChars: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  maxArgChars: number;
  maxArgCharsPinned: number;
  /**
   * First 12 hex of a SHA-256 over a segment's uncut source. The node adapter
   * supplies it; the core stays free of a crypto import.
   */
  hash: (text: string) => string;
}

export interface CompactInput {
  /** A structured carry, the previous summary as opaque text, or nothing. */
  previous: Carry | string | undefined;
  span: readonly Message[];
  boundaryToolUseId?: string;
  goal: string;
  /** Token budget for the whole summary, the text appended after it included. */
  budgetTokens: number;
  /** Characters appended after the summary (the file lists): a fixed cost. */
  suffixChars: number;
  /** Unknown pin strings the carry reader demoted to null when `previous` was read. */
  demotedUnknown: number;
  /**
   * Absolute and `~` paths named by the session's system prompt. The adapter extracts
   * them; the core never reads the prompt. Empty when the prompt was unavailable.
   */
  instructionRefs?: readonly string[];
  /** Session cwd. Absent leaves a relative instruction path unresolved. */
  cwd?: string;
}

export interface CompactStats {
  generation: number;
  /** The carry-pruning step that produced the result; 6 means the pins alone exceed the budget. */
  step: 2 | 3 | 4 | 5 | 6;
  segments: number;
  kept: number;
  truncated: number;
  /** Rendered segments with at least one storage or render cap. */
  capped: number;
  /** Rendered segments naming a jev_expand restore for a stub. */
  stubbed: number;
  /** Rendered segments with a cap or truncation stub lacking a restore (G3). */
  unlinked: number;
  dropped: number;
  pinned: number;
  demoted: number;
  /**
   * Pins demoted to ordinary segments because they exceeded their class's size cap.
   * `decision` and `instruction` are both counted here; the two are not separable.
   */
  demotedCap: number;
  /** Instruction pins demoted because a newer pin reads the same normalised path. */
  demotedDuplicate: number;
  /** Judged-out segments brought back because the budget had room. */
  backfilled: number;
  /** Pinned segments in the result, one count per pin class. */
  pinnedByClass: Record<PinClass, number>;
  /** Unknown pin strings demoted to null by the carry reader when `previous` was read. */
  demotedUnknown: number;
  /** Segments put to Jev in this compaction, fresh or carried, with an answer. */
  asked: number;
  /**
   * Segments no question reached in this compaction, whether they were carried
   * under budget or their window could not be shown readably.
   */
  unasked: number;
  /** Asked segments whose verdict carried no usable answer, so they kept by default. */
  unanswered: number;
  jevRequests: number;
  jevInputTokens: number;
  jevOutputTokens: number;
}

/**
 * One input segment, oldest first: carry, then the new span.
 * `[idx, kind, tool, pin, gen, chars, hash, asked, p_keep, p_call, p_result, rule, step, outcome]`.
 * `chars` and `hash` are null for a carried segment written before the source hash existed.
 */
export type DecisionTuple = [
  number,
  Segment['kind'],
  string | null,
  PinClass | null,
  number,
  number | null,
  string | null,
  1 | 0 | -1 | -2,
  number | null,
  number | null,
  number | null,
  string,
  1 | 2 | 3 | 4 | 5 | 6,
  SegmentStatus,
];

/** The decision record for one `compactSpan` call. The adapter writes it; it never enters the carry. */
export interface DecisionRecord {
  generation: number;
  final_step: CompactStats['step'];
  keep_threshold: number;
  /** The last schedule value step 4 applied, or null when step 4 did not run. */
  threshold_final: number | null;
  segments: DecisionTuple[];
}

export type CompactOutcome = {
  ok: true;
  summary: string;
  carry: Carry;
  renderedParts?: Array<{ segmentIndex: number; text: string }>;
  stats: CompactStats;
  decisions: DecisionRecord;
};

/**
 * Pi's own size estimate, four characters per token. The budget is compared in
 * the unit Pi uses to decide when to compact.
 */
export function tokensForChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Whether a verdict carries an answer Jev actually gave. A call verdict needs
 * both of the two answers `decideCall` reads; with either missing it keeps the
 * call conservatively, which is not an answer.
 */
function usable(verdict: Verdict | undefined): boolean {
  if (verdict === undefined) return false;
  if (verdict.kind === 'text') return verdict.keep !== undefined;
  const names = Object.keys(verdict.answers);
  return names.some(name => name.startsWith('call_')) && names.some(name => name.startsWith('result_'));
}

const RANK: Record<SegmentStatus, number> = { keep: 0, truncate: 1, drop: 2 };

export async function compactSpan(input: CompactInput, options: CoreOptions, asker: CoreAsker): Promise<CompactOutcome> {
  // Step 1: advance the generation, demote expired or unconfigured pins, compose.
  const previous = typeof input.previous === 'object' ? input.previous : undefined;
  const generation = (previous?.generation ?? 0) + 1;
  let demoted = 0;
  const carriedAll: Segment[] = previous
    ? previous.segments.map(segment => {
        if (segment.pin === null) return segment;
        const lifetime =
          segment.pin === 'decision'
            ? options.decisionPinGenerations
            : segment.pin === 'instruction'
              ? options.instructionPinGenerations
              : options.pinGenerations;
        // With the charter on, an instruction-file read is a directive and has no clock
        // (spec: pi-jev-compact-cachelane, Charter > rule): it never expires by generation.
        const clockless = options.charter === true && segment.pin === 'instruction';
        const expired = !clockless && generation - segment.gen > lifetime;
        if (!expired && options.pins.has(segment.pin)) return segment;
        demoted += 1;
        return { ...segment, pin: null };
      })
    : typeof input.previous === 'string'
      ? foreignSegments(input.previous, generation)
      : [];
  // With the charter on, operator messages and answered questions are carried verbatim in the
  // charter above the summary, so here they are neither rendered nor charged to the budget. They
  // stay in the pool with their pins and lifecycle unchanged, because the judge reads the
  // conversation around each candidate from the pool: without them it no longer sees what the
  // operator asked and keeps less of what the work needs (win-rule set, 2026-09-30: 31 vs 34 of 51
  // future references, all of it one session where the judge kept 36 calls instead of 42).
  const inCharter = (segment: Segment): boolean =>
    options.charter === true &&
    (segment.kind === 'user' || (segment.kind === 'call' && segment.call !== undefined && options.decisionTools.has(segment.call.tool)));
  const carried: Segment[] = carriedAll;
  const instruction: InstructionMatch = {
    tools: options.instructionTools,
    files: options.instructionFiles,
    paths: options.instructionPaths,
    followReferences: options.instructionFollowReferences,
    instructionRefs: input.instructionRefs ?? [],
    cwd: input.cwd,
  };
  // Old writers had no provenance and could turn `/.' into a root reference. Revalidate
  // those pins before any body can seed fresh matching. Genuine files seed the migration;
  // only a matched read may extend it. New reference pins keep their recorded provenance
  // even after their original source has left the carry.
  const ownFile = (segment: Segment): boolean => segment.call !== undefined &&
    isInstructionFile({ ...instruction, cwd: undefined }, segment.call.tool, carriedReadPath(segment));
  const trusted = carried.filter(segment => segment.pin === 'instruction' &&
    (ownFile(segment) || segment.instructionSource === 'reference'));
  const reader = instructionReader(instruction, trusted);
  for (const { segment, index } of carried.map((segment, index) => ({ segment, index }))
    .sort((a, b) => a.segment.gen - b.segment.gen || a.index - b.index)) {
    if (segment.pin !== 'instruction' || !segment.call) continue;
    const path = carriedReadPath(segment);
    const source = ownFile(segment) ? 'file' : segment.instructionSource === 'reference'
      ? 'reference' : reader.source(segment.call.tool, path);
    if (source === undefined) {
      carried[index] = { ...segment, pin: null };
      demoted += 1;
    } else {
      carried[index] = { ...segment, instructionSource: source };
      reader.note(segment.call.tool, path, segment.call.result, segment.call.isError);
    }
  }
  const fresh = spanToSegments(
    input.span,
    {
      pins: options.pins,
      modifyTools: options.modifyTools,
      decisionTools: options.decisionTools,
      instruction,
      boundaryToolUseId: input.boundaryToolUseId,
      maxStoredChars: options.maxArgCharsPinned,
      gen: generation,
      hash: options.hash,
    },
    carried,
  );
  const seenLayoutIds = new Set<string>();
  const segments = [...carried, ...fresh].map((segment, index) => {
    let layoutId = segment.layoutId;
    if (!layoutId || seenLayoutIds.has(layoutId)) {
      layoutId = `s:${generation}:${index}`;
      while (seenLayoutIds.has(layoutId)) layoutId += ':new';
    }
    seenLayoutIds.add(layoutId);
    return { ...segment, layoutId };
  });
  const render: RenderOptions = {
    maxArgChars: options.maxArgChars,
    maxArgCharsPinned: options.maxArgCharsPinned,
    modifyTools: options.modifyTools,
    truncateHeadChars: options.truncateHeadChars,
    ...(options.stubWrites === true ? { stubWrites: true } : {}),
    ...(options.stubEditChars !== undefined ? { stubEditChars: options.stubEditChars } : {}),
  };
  // One size cap per capped class, each on its own budget: a large decision pin never demotes
  // an instruction pin. Within a class the walk is newest first and the newest pin is always
  // kept. A pin is charged what it adds to the summary, the same cost the budget uses
  // (`partChars` below), not its stored size (spec amendment 2026-09-26). The cap bounds context.
  let demotedCap = 0;
  let demotedDuplicate = 0;
  const renderedSize = (segment: Segment): number => renderSegment(segment, 'keep', render).length + 2;
  const newestFirst = (cls: PinClass) =>
    segments
      .map((segment, index) => ({ segment, index }))
      .filter(item => item.segment.pin === cls)
      // Newest first by generation, then later position within a generation. Array position alone
      // is newest only while the carry stays in generation order, which nothing here enforces.
      .sort((x, y) => y.segment.gen - x.segment.gen || y.index - x.index);
  const capClass = (cls: PinClass, maxChars: number): void => {
    let used = 0;
    // Instruction only: a re-read of the same normalised path supersedes the older pin, and that
    // demotion is counted on its own, before the size test, so it is never also a cap demotion.
    // Demotion removes the pin. It does not remove the segment: within budget, step 2 keeps the
    // older copy verbatim, and only a later step puts it to Jev.
    const seen = new Set<string>();
    const items = newestFirst(cls).flatMap(item => {
      if (cls !== 'instruction') return [item];
      // With the charter on a re-read retires nothing: only a byte-identical re-read (same path,
      // same source hash) drops the older copy, which loses nothing.
      const path = options.charter === true
        ? (carriedReadPath(item.segment) !== undefined && item.segment.srcHash !== undefined ? `${carriedReadPath(item.segment)}\u0000${item.segment.srcHash}` : undefined)
        : carriedReadPath(item.segment);
      if (path !== undefined && seen.has(path)) {
        segments[item.index] = { ...item.segment, pin: null };
        demotedDuplicate += 1;
        return [];
      }
      if (path !== undefined) seen.add(path);
      return [item];
    });
    for (const [position, item] of items.entries()) {
      const size = renderedSize(item.segment);
      // With the charter on, instruction reads are not capped by size either: the charter
      // keeps every instruction read whole, named files and followed references alike.
      const capped = !(options.charter === true && cls === 'instruction');
      if (capped && position > 0 && used + size > maxChars) {
        segments[item.index] = { ...item.segment, pin: null };
        demotedCap += 1;
      } else {
        used += size;
      }
    }
  };
  capClass('decision', options.decisionPinMaxChars);
  capClass('instruction', options.instructionPinMaxChars);
  const all = segments.map((_, index) => index);
  const status: SegmentStatus[] = segments.map(() => 'keep');
  // Initialised with status, so every segment has a rule before any step runs:
  // a pin is step 1, a carried unpinned segment is step 2, a fresh unpinned one is step 1.
  const rule: string[] = segments.map((segment, index) =>
    segment.pin !== null ? 'pin' : index < carried.length ? 'carried' : 'unasked',
  );
  const stepOf: Array<1 | 2 | 3 | 4 | 5 | 6> = segments.map((segment, index) =>
    segment.pin !== null || index >= carried.length ? 1 : 2,
  );
  const verdicts = new Map<number, Verdict>();
  let backfilled = 0;
  /** Segments a question reached, whichever window and stage asked it. */
  const askedAt = new Set<number>();
  const usage = { requests: 0, input: 0, output: 0 };

  const partChars = (i: number): number =>
    status[i] === 'drop' || inCharter(segments[i]!) ? 0 : renderSegment(segments[i]!, status[i]!, render).length + 2;
  const parts = all.map(partChars);
  // With the charter on, the operator's messages are carried in full above the summary, so the
  // header's "Ongoing goal" copy of the last three is not repeated. The judge still sees the goal.
  const shownGoal = options.charter === true ? '' : input.goal;
  let chars = summaryOverheadChars(shownGoal) + input.suffixChars + parts.reduce((sum, n) => sum + n, 0);
  const fits = (): boolean => tokensForChars(chars) <= input.budgetTokens;
  const lower = (i: number, next: SegmentStatus, why: string, at: 1 | 2 | 3 | 4 | 5 | 6): void => {
    if (segments[i]!.pin !== null) return; // a current pin is never lowered, whoever asks
    if (RANK[next] <= RANK[status[i]!]) return;
    status[i] = next;
    rule[i] = why;
    stepOf[i] = at;
    const now = partChars(i);
    chars += now - parts[i]!;
    parts[i] = now;
  };
  const unpinned = (i: number): boolean => segments[i]!.pin === null;
  const alive = (i: number): boolean => status[i] !== 'drop';
  /** The opposite of `lower`, for backfill only: never past what the segment can show. */
  const raise = (i: number, next: SegmentStatus, why: string, at: 1 | 2 | 3 | 4 | 5 | 6): void => {
    if (RANK[next] >= RANK[status[i]!]) return;
    status[i] = next;
    rule[i] = why;
    stepOf[i] = at;
    const now = partChars(i);
    chars += now - parts[i]!;
    parts[i] = now;
  };
  /** A verdict's strength, for ordering backfill: the larger of the answers it gave. */
  const strength = (verdict: Verdict | undefined): number => {
    if (verdict === undefined) return -1;
    if (verdict.kind === 'text') return verdict.keep ?? -1;
    const [, call, result] = probs(verdict);
    return Math.max(call ?? -1, result ?? -1);
  };
  /**
   * Backfill (win-rule set, 2026-09-30): a threshold drops what the judge rated below it even when
   * the budget has room, and 10 of the 16 references the next steps needed were in such segments
   * (s19: six read results at p 0.25-0.43 with 26K tokens of budget unused). While the budget
   * has room, the strongest judged-out segments come back, whole when they fit and as a stub
   * otherwise; a segment no question reached, or one the budget itself dropped, stays out.
   */
  const pathOf = (i: number): string | undefined => {
    const input = segments[i]!.call?.input as Record<string, unknown> | undefined;
    const p = input?.path ?? input?.file_path ?? input?.filePath;
    return typeof p === 'string' ? p.replace(/^\.\//, '') : undefined;
  };
  const activePaths = new Set(all.filter(i => segments[i]!.call !== undefined && options.modifyTools.has(segments[i]!.call!.tool)).map(pathOf).filter((p): p is string => p !== undefined));
  const activeRead = (i: number): boolean => segments[i]!.call?.tool === 'read' && activePaths.has(pathOf(i) ?? '\u0000');
  const backfill = (at: 3 | 4): number => {
    if (!options.backfill) return 0;
    let restored = 0;
    const candidates = all
      .filter(i => unpinned(i) && status[i] !== 'keep' && rule[i]!.startsWith('threshold:') && usable(verdicts.get(i))
        && strength(verdicts.get(i)) >= (options.backfillMin ?? 0)
        && (!options.backfillActiveReads || activeRead(i)))
      .sort((x, y) => strength(verdicts.get(y)) - strength(verdicts.get(x)) || x - y);
    for (const i of candidates) {
      const before = status[i]!;
      for (const next of ['keep', 'truncate'] as const) {
        if (RANK[next] >= RANK[before]) continue;
        raise(i, next, 'backfill', at);
        if (fits()) { restored += 1; break; }
        // Undo: put the status back and recount; try the smaller form.
        status[i] = before;
        const now = partChars(i);
        chars += now - parts[i]!;
        parts[i] = now;
      }
    }
    return restored;
  };
  const ask = async (targets: number[], round: JudgeRound): Promise<void> => {
    if (targets.length === 0) return;
    const judged = await judge(
      segments,
      all.filter(alive),
      targets,
      { goal: input.goal, maxStateTokens: options.maxStateTokens, maxRequestTokens: options.maxRequestTokens },
      asker,
      round,
    );
    for (const [index, verdict] of judged.verdicts) {
      // Only a segment a question really reached is asked about; a window that
      // could not be fitted or shown readably returns no verdict for its targets.
      askedAt.add(index);
      verdicts.set(index, verdict);
    }
    usage.requests += judged.usage.requests;
    usage.input += judged.usage.input;
    usage.output += judged.usage.output;
  };
  const round3 = (value: number | undefined): number | null =>
    value === undefined ? null : Math.round(value * 1000) / 1000;
  const probs = (verdict: Verdict | undefined): [number | null, number | null, number | null] => {
    if (verdict === undefined) return [null, null, null];
    if (verdict.kind === 'text') return [round3(verdict.keep), null, null];
    const call = verdict.answers[`call_${VERDICT_ID}`];
    const result = verdict.answers[`result_${VERDICT_ID}`];
    return [
      null,
      round3(call !== undefined && 'noul' in call ? call.noul : undefined),
      round3(result !== undefined && 'noul' in result ? result.noul : undefined),
    ];
  };
  /**
   * A judge round's answers. Unlike `lower`, an answered segment that stays `keep`
   * still records the threshold: the round decided it. A target with no usable
   * answer records `unanswered`. A target the window never returned a verdict for
   * keeps its initial `unasked`.
   */
  const applyAt = (targets: readonly number[], threshold: number, at: 1 | 3): void => {
    const why = `threshold:${threshold}`;
    for (const i of targets) {
      const verdict = verdicts.get(i);
      if (!usable(verdict)) {
        if (verdict !== undefined) {
          rule[i] = 'unanswered';
          stepOf[i] = at;
        }
        continue;
      }
      const decided = statusAt(verdict, threshold, options.borderline);
      const reason = decided.guarded ? 'borderline' : why;
      if (decided.status === 'keep') {
        rule[i] = reason;
        stepOf[i] = at;
        continue;
      }
      lower(i, decided.status, reason, at);
    }
  };
  const count = (wanted: SegmentStatus): number => status.filter(s => s === wanted).length;
  /*
   * What became of each segment, as one class per segment so the four counts
   * sum to `segments`: a current pin is never put to Jev (`pinned`); a segment
   * no question reached is `unasked`; of the asked ones, a verdict with no
   * usable answer kept by default (`unanswered`), the rest are `asked`.
   */
  const classOf = (i: number): 'pinned' | 'asked' | 'unanswered' | 'unasked' => {
    if (segments[i]!.pin !== null) return 'pinned';
    if (!askedAt.has(i)) return 'unasked';
    return usable(verdicts.get(i)) ? 'asked' : 'unanswered';
  };
  const classCount = (wanted: ReturnType<typeof classOf>): number =>
    all.filter(i => classOf(i) === wanted).length;
  const stats = (step: CompactStats['step'], recovery: ReturnType<typeof stubCounts>): CompactStats => ({
    ...recovery,
    generation,
    step,
    segments: segments.length,
    kept: count('keep'),
    truncated: count('truncate'),
    dropped: count('drop'),
    pinned: segments.filter(segment => segment.pin !== null).length,
    demoted,
    demotedCap,
    demotedDuplicate,
    backfilled,
    pinnedByClass: Object.fromEntries(
      PIN_CLASSES.map(cls => [cls, segments.filter(segment => segment.pin === cls).length]),
    ) as Record<PinClass, number>,
    demotedUnknown: input.demotedUnknown,
    asked: classCount('asked'),
    unasked: classCount('unasked'),
    unanswered: classCount('unanswered'),
    jevRequests: usage.requests,
    jevInputTokens: usage.input,
    jevOutputTokens: usage.output,
  });
  const finish = (step: CompactStats['step'], thresholdFinal: number | null): CompactOutcome => {
    const kept: Segment[] = [];
    const rendered: string[] = [];
    const renderedParts: Array<{ segmentIndex: number; text: string }> = [];
    const rows: DecisionTuple[] = [];
    const recovery = { capped: 0, stubbed: 0, unlinked: 0 };
    for (const i of all) {
      const segment = segments[i]!;
      const verdict = verdicts.get(i);
      const [pKeep, pCall, pResult] = probs(verdict);
      const asked: 1 | 0 | -1 | -2 =
        segments[i]!.pin !== null ? 0 : verdict === undefined ? (rule[i] === 'unasked' ? -2 : 0) : usable(verdict) ? 1 : -1;
      rows.push([
        i,
        segment.kind,
        segment.call?.tool ?? null,
        segment.pin,
        segment.gen,
        segment.srcChars ?? null,
        segment.srcHash ?? null,
        asked,
        pKeep,
        pCall,
        pResult,
        rule[i]!,
        stepOf[i]!,
        status[i]!,
      ]);
      if (status[i] === 'drop') continue;
      if (!inCharter(segment)) {
        const text = renderSegment(segment, status[i]!, render);
        rendered.push(text);
        renderedParts.push({ segmentIndex: kept.length, text });
        const counts = stubCounts(text);
        recovery.capped += counts.capped;
        recovery.stubbed += counts.stubbed;
        recovery.unlinked += counts.unlinked;
      }
      const call = segment.call;
      kept.push(
        status[i] === 'truncate' && call && !call.resultTruncated
          ? {
              ...segment,
              call: {
                ...call,
                result: truncatedResult(call.result, call.isError, options.truncateHeadChars, call.id, segment.srcHash),
                resultTruncated: true,
              },
            }
          : segment,
      );
    }
    return {
      ok: true,
      summary: renderSummary(rendered, shownGoal),
      renderedParts,
      carry: { version: CARRY_VERSION, generation, segments: kept },
      stats: stats(step, recovery),
      decisions: {
        generation,
        final_step: step,
        keep_threshold: options.keepThreshold,
        threshold_final: thresholdFinal,
        segments: rows,
      },
    };
  };

  // Once current pins alone exceed the budget, every successful scoring path
  // reaches step 6 with exactly those pins. Resolve this after expiry, duplicate
  // demotion and class caps; optional scores cannot change the retained packet.
  const protectedChars = summaryOverheadChars(options.charter === true ? '' : input.goal) + input.suffixChars
    + all.filter(i => !unpinned(i)).reduce((sum, i) => sum + parts[i]!, 0);
  if (tokensForChars(protectedChars) > input.budgetTokens) {
    for (const i of all) if (unpinned(i)) lower(i, 'drop', 'budget_drop', 5);
    return finish(6, null);
  }

  // Otherwise the new span is judged, with the whole candidate as the state.
  const freshTargets = all.slice(carried.length).filter(unpinned);
  await ask(freshTargets, 'span');
  applyAt(freshTargets, options.keepThreshold, 1);

  // Step 2: within budget, the carry stays as it is; what the judge rated out comes back while room lasts.
  if (fits()) { backfilled = backfill(3); return finish(2, null); }

  // Step 3: re-judge the carry.
  const carryTargets = all.slice(0, carried.length).filter(i => unpinned(i) && alive(i));
  await ask(carryTargets, 'carry');
  applyAt(carryTargets, options.keepThreshold, 3);
  if (fits()) { backfilled = backfill(3); return finish(3, null); }

  // Step 4: stricter thresholds from the stored answers, oldest first, no new Jev calls.
  // A segment with no verdict, and one this threshold does not change, keeps its rule.
  let thresholdFinal: number | null = null;
  for (const threshold of options.thresholdSchedule) {
    thresholdFinal = threshold;
    const why = `threshold:${threshold}`;
    for (const i of all) {
      if (!unpinned(i) || !alive(i)) continue;
      const verdict = verdicts.get(i);
      if (!usable(verdict)) continue;
      const decided = statusAt(verdict, threshold, options.borderline);
      lower(i, decided.status, decided.guarded ? 'borderline' : why, 4);
      if (fits()) { backfilled = backfill(4); return finish(4, thresholdFinal); }
    }
  }

  // Step 5: drop everything unpinned.
  for (const i of all) if (unpinned(i)) lower(i, 'drop', 'budget_drop', 5);
  if (fits()) return finish(5, thresholdFinal);

  // Step 6: the pins alone do not fit. The budget guides pruning, it never refuses a compaction
  // (operator decision 2026-09-25): the result is the pins, over budget.
  return finish(6, thresholdFinal);
}
