/**
 * The record of each compaction in the chat. Interactive Pi redraws the chat when
 * a compaction ends and shows every compaction the same way ("Compacted from N
 * tokens"), so a notification from the hook is wiped and a Jev compaction looks
 * like Pi's own summary. After Pi saves a compaction, this appends a custom
 * session entry saying which engine produced it and with what numbers. Custom
 * entries are drawn in the chat, survive the redraw, `/reload` and resume, and
 * never reach the model.
 */

import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { BackendDescriptor } from '../client/backend-descriptor.js';
import { clean, k, identity, destination, readDescriptor, contextText, fitVariants, clip, routeHeadline } from './presentation.js';

/** The custom entry type in the session file. */
export const MARKER_TYPE = 'jev-compaction';

/** Custom entry recording the provider's count of the context after a compaction. Never rendered. */
export const MEASURED_TYPE = 'jev-compaction-measured';

/** What the hook recorded about its last outcome, for the entry written after Pi saves it. */
export interface LastOutcome {
  attemptId?: string;
  engine: 'jev' | 'fallback';
  resolution?: string;
  backend?: string;
  backend_descriptor?: BackendDescriptor;
  backend_requests?: Record<string, number>;
  backend_responses?: Record<string, number>;
  reason: string | null;
  tokensBefore: number | null;
  /** Pi's own estimate of the saved entry's after-context, when it compacted. */
  tokensAfter: number | null;
  latencyMs: number;
}

/** The context-after budget a Jev compaction was measured against, as its entry recorded it. */
export interface JevBudget {
  /** The predicted context after, system prompt and tools included. */
  predictedAfter: number | null;
  /** Pi's trigger `T`: `contextWindow - reserveTokens`. */
  trigger: number | null;
  /** The preferred target `A`. */
  target: number | null;
  /** What the context holds after the compaction apart from the summary, `F`. */
  fixedAfter: number | null;
  /** The summary's own budget. */
  budgetTokens: number | null;
}

export interface MarkerData {
  origin?: 'native' | 'extension';
  requestId?: string;
  version: 1;
  backend?: string;
  backend_descriptor?: BackendDescriptor;
  backend_requests?: Record<string, number>;
  backend_responses?: Record<string, number>;
  fallback_from?: string;
  fallback_reason?: string;
  /** Source identity recorded when the hosted retry was triggered, never reconstructed. */
  fallback_descriptor?: BackendDescriptor;
  resolution?: string;
  charterStats?: Record<string, number>;
  /** Id of the compaction entry this describes. */
  compactionId: string | null;
  /**
   * `jev`: Jev produced it. `pi`: Pi's own summary, with the fallback reason
   * when the hook gave one. `other`: an extension other than Jev saved it, which Jev knows
   * only from the entry itself.
   */
  engine: 'jev' | 'pi' | 'other';
  reason: string | null;
  tokensBefore: number | null;
  summaryChars: number;
  /**
   * The predicted context after, system prompt and tools included: the saved entry's own
   * `estimatedTokensAfter`, else the hook's figure. Null when neither exists.
   */
  predictedAfter: number | null;
  /** Pi's `estimateTokens` over the new message projection alone, without the fixed prompt. */
  contextAfter: number | null;
  latencyMs: number | null;
  model: string | null;
  configHash: string | null;
  stats: Record<string, number> | null;
  /** Pinned segments per class, when the entry recorded them; absent on older entries. */
  pinnedByClass?: Record<string, number> | null;
  /** The budget the entry recorded; null for entries written before it existed. */
  budget?: JevBudget | null;
  /**
   * The provider's own count of the context on the first response after the compaction
   * (`input + cacheRead + cacheWrite`), once it has arrived; the estimate stands until then.
   */
  measuredAfter?: number | null;
}

type Theme = { fg(color: string, text: string): string; bold?(text: string): string };
type Component = { render(width: number): string[]; invalidate(): void };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function counts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(value)) if (typeof n === 'number' && Number.isFinite(n)) out[key] = n;
  return out;
}

/** Per-class pin counts, when the entry recorded them as an object of numbers. */
function pinnedByClass(stats: unknown): Record<string, number> | null {
  if (!isRecord(stats) || !isRecord(stats.pinnedByClass)) return null;
  const out = counts(stats.pinnedByClass);
  return out && Object.keys(out).length > 0 ? out : null;
}

function provenance(jev: Record<string, unknown> | undefined, last?: LastOutcome): Partial<MarkerData> {
  const out: Partial<MarkerData> = {};
  const raw = jev ?? last;
  if (!raw) return out;
  const descriptor = readDescriptor(raw.backend_descriptor);
  if (descriptor) out.backend_descriptor = descriptor;
  for (const field of ['backend_requests', 'backend_responses'] as const) {
    const values = counts(raw[field]);
    if (values) out[field] = Object.fromEntries(Object.entries(values).filter(([, n]) => Number.isSafeInteger(n) && n >= 0));
  }
  if (raw.origin === 'native' || raw.origin === 'extension') out.origin = raw.origin;
  if (typeof raw.requestId === 'string') out.requestId = raw.requestId;
  if (typeof raw.backend === 'string') out.backend = clean(raw.backend);
  if (last?.resolution && !jev) out.resolution = last.resolution;
  if (jev) {
    if (typeof jev.fallback_from === 'string') out.fallback_from = clean(jev.fallback_from);
    if (typeof jev.fallback_reason === 'string') out.fallback_reason = clean(jev.fallback_reason);
    const source = readDescriptor(jev.fallback_descriptor);
    if (source) out.fallback_descriptor = source;
    const charter = counts(jev.charter_stats);
    if (charter) out.charterStats = charter;
  }
  return out;
}

/**
 * The marker for a saved compaction entry. `last` is the hook's outcome for this
 * compaction when it ran, used unless its `tokensBefore` contradicts the entry's.
 */
export function markerFor(entry: unknown, last: LastOutcome | undefined, contextAfter: number | null): MarkerData {
  const compaction = isRecord(entry) ? entry : {};
  const details = isRecord(compaction.details) ? compaction.details : {};
  const jev = isRecord(details.jev) ? details.jev : undefined;
  const tokensBefore = num(compaction.tokensBefore);
  // The hook runs just before Pi saves, so an outcome whose tokensBefore matches is this
  // compaction's. One instance serves the whole process and a hook that stopped before reading
  // the event (a config error) has no tokensBefore to compare, so a null matches nothing: the
  // failure reaches the operator through the notification and the telemetry line instead.
  const ours = last !== undefined && last.tokensBefore !== null && last.tokensBefore === tokensBefore ? last : undefined;
  // Saved by some hook, but not ours and carrying nothing of ours: another extension compacted.
  const foreign = compaction.fromHook === true && jev === undefined;
  const savedAfter = num(compaction.estimatedTokensAfter);
  const rawBudget = jev && isRecord(jev.budget) ? jev.budget : undefined;
  const budget: JevBudget | null = rawBudget
    ? {
        predictedAfter: num(rawBudget.predictedAfter),
        trigger: num(rawBudget.trigger),
        target: num(rawBudget.target),
        fixedAfter: num(rawBudget.fixedAfter),
        budgetTokens: num(rawBudget.budgetTokens),
      }
    : null;
  return {
    version: 1,
    compactionId: typeof compaction.id === 'string' ? compaction.id : null,
    engine: jev ? 'jev' : foreign ? 'other' : 'pi',
    reason: jev || foreign ? null : ours ? ours.reason : null,
    ...provenance(jev, foreign ? undefined : ours),
    tokensBefore,
    summaryChars: typeof compaction.summary === 'string' ? compaction.summary.length : 0,
    predictedAfter: savedAfter ?? (foreign ? null : num(rawBudget?.predictedAfter) ?? ours?.tokensAfter ?? null),
    contextAfter,
    latencyMs: foreign ? null : num(jev?.latencyMs) ?? (ours ? ours.latencyMs : null),
    model: jev && typeof jev.model === 'string' ? jev.model : null,
    configHash: jev && typeof jev.config_hash === 'string' ? jev.config_hash : null,
    stats: jev ? counts(jev.stats) : null,
    pinnedByClass: jev ? pinnedByClass(jev.stats) : null,
    budget,
  };
}

/**
 * The marker for a Jev compaction entry, built from the entry alone: this is what
 * Pi's compaction box renders from, live and on resume, without any live outcome.
 * An entry written before `budget`/`latencyMs` existed renders with
 * 'context after unknown' and no time rather than throwing.
 */
export function entryMarker(entry: unknown): MarkerData {
  const compaction = isRecord(entry) ? entry : {};
  const details = isRecord(compaction.details) ? compaction.details : {};
  const jev = isRecord(details.jev) ? details.jev : undefined;
  const rawBudget = jev && isRecord(jev.budget) ? jev.budget : undefined;
  // Only an entry that carries `details.jev` is Jev's; anything else is Pi's own summary,
  // with no hook outcome recorded for it.
  return {
    version: 1,
    compactionId: typeof compaction.id === 'string' ? compaction.id : null,
    engine: jev ? 'jev' : compaction.fromHook === true ? 'other' : 'pi',
    reason: null,
    ...provenance(jev),
    tokensBefore: num(compaction.tokensBefore),
    summaryChars: typeof compaction.summary === 'string' ? compaction.summary.length : 0,
    predictedAfter: num(compaction.estimatedTokensAfter) ?? num(rawBudget?.predictedAfter),
    contextAfter: null,
    latencyMs: jev ? num(jev.latencyMs) : null,
    model: jev && typeof jev.model === 'string' ? jev.model : null,
    configHash: jev && typeof jev.config_hash === 'string' ? jev.config_hash : null,
    stats: jev ? counts(jev.stats) : null,
    pinnedByClass: jev ? pinnedByClass(jev.stats) : null,
    budget: rawBudget
      ? {
          predictedAfter: num(rawBudget.predictedAfter),
          trigger: num(rawBudget.trigger),
          target: num(rawBudget.target),
          fixedAfter: num(rawBudget.fixedAfter),
          budgetTokens: num(rawBudget.budgetTokens),
        }
      : null,
  };
}

/** Route-first shared card. Collapsed rows are fitted before styling, never wrapped. */
function headlines(data: MarkerData, width: number, expanded: boolean): string[] {
  const d = readDescriptor(data.backend_descriptor);
  const b = identity(d, data.backend);
  let first: string, second: string;
  if (data.engine === 'jev') {
    const base = routeHeadline(data, width);
    const model = clean(d?.model ?? data.model);
    const trigger = data.origin === 'extension' ? ' · detector' : '';
    first = fitVariants([base + trigger + (model ? ` · ${model}` : ''), base + trigger, trigger ? 'Jev · detector' : base], width);
    if (data.fallback_from) {
      const f = identity(readDescriptor(data.fallback_descriptor), data.fallback_from);
      const provenance = `! Fallback from ${f} (${clean(data.fallback_reason) || 'reason not recorded'})`;
      second = fitVariants([`${provenance} · ${destination(d)}`, provenance], width);
    } else {
      second = d ? `At ${destination(d)}` : 'Destination not recorded';
      const revision = clean(d?.verified_revision || d?.revision).slice(0, 12);
      const optional = `${second} · ${d?.verified_revision ? 'verified' : 'pinned'} ${revision}`;
      if (!expanded && Number.isFinite(width) && width >= 80 && revision && visibleWidth(optional) <= width) second = optional;
      second = fitVariants([second], width);
    }
  } else if (data.engine === 'other') {
    first = fitVariants(['Compaction [other extension]'], width);
    second = fitVariants(['Jev did not produce this compaction'], width);
  } else {
    const selected = data.resolution === 'native';
    first = fitVariants([selected ? '! Pi [built-in summary] · selected fallback' : 'Pi [built-in summary]'], width);
    second = data.resolution === 'disabled' || data.reason === 'disabled' ? 'Jev disabled'
      : selected ? `Jev [${b}] failed (${clean(data.reason) || 'reason not recorded'})`
      : data.reason && data.reason !== 'jev_did_not_run' ? `Jev [${b}] did not produce it (${clean(data.reason) || 'reason not recorded'})`
      : 'Jev outcome not recorded';
    second = fitVariants([second], width);
  }
  const context = contextText(data);
  const timing = data.engine === 'jev' && typeof data.latencyMs === 'number' ? ` · ${(data.latencyMs / 1000).toFixed(1)}s attempt` : '';
  const third = fitVariants([context + timing, context], width);
  const s = data.stats ?? {};
  const cutLabel = typeof s.capped === 'number' ? 'pruning cuts' : 'cut';
  const countText = `${third} · ${s.kept} kept / ${s.truncated} ${cutLabel} / ${s.dropped} dropped`;
  return [first, second, !expanded && data.engine === 'jev' && Number.isFinite(width) && width >= 80 &&
    [s.kept, s.truncated, s.dropped].every(n => typeof n === 'number') && visibleWidth(countText) <= width ? countText : third];
}

function contextExplanation(data: MarkerData): string {
  if (typeof data.measuredAfter === 'number') return `next-response provider input ${k(data.measuredAfter)}; ` +
    (typeof data.predictedAfter === 'number' ? `prediction ~${k(data.predictedAfter)}; ` : '') + 'includes system + tools';
  if (typeof data.predictedAfter === 'number') return `prediction ~${k(data.predictedAfter)}; includes system + tools; next-response measurement not recorded`;
  if (typeof data.contextAfter === 'number') return `message-only estimate ~${k(data.contextAfter)}; excludes fixed system + tools`;
  return 'after-context not recorded';
}

export function markerLines(data: MarkerData, expanded: boolean, width = Infinity): string[] {
  // No optional additions without a supplied component width.
  const lines = headlines(data, width, expanded);
  if (!expanded) {
    const s = data.stats;
    if (data.engine === 'jev' && s && typeof s.capped === 'number' && typeof s.stubbed === 'number') {
      lines.push(fitVariants([
        `Recovery: ${s.capped} capped · ${s.stubbed} restorable · jev_expand`,
        `${s.capped} capped · ${s.stubbed} restorable · jev_expand`,
        `${s.capped} capped · jev_expand`,
        `${s.capped} capped`,
      ], width));
      if (typeof s.unlinked === 'number' && s.unlinked > 0) lines.push(fitVariants([
        `! ${s.unlinked} stubs without a restore id`, `! ${s.unlinked} unlinked stubs`,
      ], width));
    }
    return lines;
  }
  const b = data.budget;
  const after = data.measuredAfter ?? data.predictedAfter;
  if (data.engine === 'jev' && typeof after === 'number' && typeof b?.trigger === 'number' && after > b.trigger) {
    lines.push(`! Context ${typeof data.measuredAfter === 'number' ? 'measured' : 'predicted'} exceeds trigger ${k(b.trigger)}`);
  }
  const row = (prefix: string, parts: Array<string | undefined>) => {
    const present = parts.filter((p): p is string => !!p);
    if (present.length) lines.push(prefix + present.join(' · '));
  };
  const descriptor = readDescriptor(data.backend_descriptor);
  if (data.engine === 'jev') {
    if (descriptor) row('Route ', [descriptor.id, descriptor.where, descriptor.revision ? `pinned revision ${descriptor.revision}` : undefined, descriptor.verified_revision ? `verified revision ${descriptor.verified_revision}` : undefined]);
    if (data.fallback_from) row('Fallback source ', [clean(data.fallback_from), readDescriptor(data.fallback_descriptor)?.where]);
    if (data.backend_requests) row('Backend requests: ', Object.entries(data.backend_requests).map(([id, n]) => `${clean(id)} ${n}`));
    if (data.backend_responses) row('Accepted responses: ', Object.entries(data.backend_responses).map(([id, n]) => `${clean(id)} ${n}`));
  } else if (data.engine === 'pi' && descriptor && data.reason && data.reason !== 'disabled') {
    row('Failed Jev route ', [descriptor.id, descriptor.where]);
  }
  lines.push('Context: ' + contextExplanation(data));
  if (data.engine === 'jev') {
    const s = data.stats ?? {};
    const count = (value: number | undefined, suffix: string, tokens = false) => typeof value === 'number' ? `${tokens ? k(value) : value} ${suffix}` : undefined;
    row('Segments: ', [count(s.kept, 'kept'), count(s.truncated, typeof s.capped === 'number' ? 'pruning cuts' : 'cut'), count(s.dropped, 'dropped'), count(s.pinned, 'pinned'), count(s.capped, 'capped')]);
    row('Recoverable: ', [count(s.stubbed, 'stubs restorable with jev_expand')]);
    if (typeof s.unlinked === 'number' && s.unlinked > 0) lines.push(`! ${s.unlinked} stubs without a restore id`);
    row('Pruning: ', [count(s.jevRequests, 'requests'), count(s.jevInputTokens, 'tokens in', true), count(s.jevOutputTokens, 'tokens out', true)]);
    if (typeof data.latencyMs === 'number') lines.push(`Attempt: ${(data.latencyMs / 1000).toFixed(1)}s · successful pass only` +
      (data.fallback_from ? `; excludes failed ${identity(readDescriptor(data.fallback_descriptor), data.fallback_from)} attempt` : ''));
    const charter = data.charterStats ?? {};
    row('Charter sources: ', [count(charter.said, 'said'), count(charter.answered, 'answered'), count(charter.retired, 'retired IDs')]);
    if (b) row('Budget: ', [typeof b.target === 'number' ? `target ${k(b.target)}` : undefined,
      typeof b.trigger === 'number' ? `trigger ${k(b.trigger)}` : undefined,
      typeof b.fixedAfter === 'number' ? `fixed ${k(b.fixedAfter)}` : undefined,
      typeof b.budgetTokens === 'number' ? `summary ${k(b.budgetTokens)}` : undefined]);
  }
  row('Record: ', [data.compactionId ? `entry ${clean(data.compactionId)}` : undefined,
    data.configHash && data.engine === 'jev' ? `config ${clean(data.configHash)}` : undefined]);
  return lines.map(clean);
}
export const compactionBoxLines = markerLines;

/** Style sanitized segments individually: only the success glyph is green. */
function styled(line: string, theme: Theme): string {
  const fg = (color: string, text: string) => text ? theme.fg(color, text) : '';
  const bold = (color: string, text: string) => fg(color, theme.bold?.(text) ?? text);
  const separator = () => fg('dim', ' · ');
  const context = (text: string) => text.split(/(\d+(?:\.\d+)?k?|→)/g).map(part =>
    /^\d/.test(part) ? bold('text', part) : part === '→' ? fg('text', part) : fg('muted', part)).join('');
  if (line.startsWith('✓ Jev [')) {
    const match = /^(✓) (Jev \[[^\]]*\])(.*)$/.exec(line);
    if (match) return fg('success', match[1]) + ' ' + bold('accent', match[2]) +
      (match[3].startsWith(' · ') ? separator() + fg('text', match[3].slice(3)) : fg('text', match[3]));
  }
  if (/^!? ?Pi \[/.test(line)) {
    const match = /^(! )?(Pi \[[^\]]*\])(.*)$/.exec(line);
    if (match) return (match[1] ? fg('warning', '!') + ' ' : '') + bold('accent', match[2]) + fg('muted', match[3]);
  }
  if (line.startsWith('! Fallback')) {
    const at = line.lastIndexOf(' · ');
    return at >= 0 ? fg('warning', line.slice(0, at)) + separator() + fg('accent', line.slice(at + 3)) : fg('warning', line);
  }
  if (line.startsWith('At ')) {
    const [host, revision] = line.slice(3).split(' · ');
    return fg('muted', 'At ') + fg('accent', host) + (revision ? separator() + fg('dim', revision) : '');
  }
  if (line.startsWith('Jev [')) {
    const match = /^(Jev \[[^\]]*\])(.*)$/.exec(line);
    if (match) return bold('accent', match[1]) + fg('muted', match[2]);
  }
  if (/^(Context|Messages)/.test(line)) {
    const [figure, ...metadata] = line.split(' · ');
    return context(figure) + metadata.map(part => separator() + fg('muted', part)).join('');
  }
  if (line.startsWith('!')) return fg('warning', line);
  if (/^(Route |Fallback source |Failed Jev route |Record: )/.test(line)) return fg('dim', line);
  return fg('muted', line);
}

function component(source: () => MarkerData, expanded: boolean, theme: Theme, indent: boolean, expandHint?: string): Component {
  return {
    render: width => {
      const padding = indent && width >= 2 ? ' ' : '';
      const inner = Math.max(0, width - padding.length);
      const lines = markerLines(source(), expanded, inner);
      if (!expanded && expandHint) {
        const hint = clean(expandHint);
        const suffix = ` · ${hint}`;
        if (visibleWidth(suffix) < inner) {
          const budget = inner - visibleWidth(suffix);
          // Drop optional timing/count segments whole before abbreviating evidence.
          const variants = [lines[2], contextText(source())];
          lines[2] = fitVariants(variants, budget) + suffix;
        } else lines[2] = clip(hint, inner);
      }
      return lines.flatMap((line, index) => {
        const text = styled(line, theme);
        const parts = expanded && index >= 3 ? wrapTextWithAnsi(text, Math.max(1, inner)) : [clip(text, inner)];
        return parts.map(part => padding + part);
      });
    },
    invalidate() {},
  };
}
/** Host owns box padding; this child receives actual inner width. */
export function renderCompactionBox(source: MarkerData | (() => MarkerData), options: { expanded: boolean }, theme: Theme): Component {
  return component(() => typeof source === 'function' ? source() : source, options.expanded, theme, false);
}
export function renderMarker(entry: { data?: unknown }, options: { expanded: boolean }, theme: Theme,
  resolve: (data: MarkerData) => MarkerData = data => data): Component {
  return component(() => resolve(entry.data as MarkerData), options.expanded, theme, true);
}

/** Per-invocation capability, not registration metadata. Invalid selection options
 * degrade to legacy decoration; the host owns expansion and the saved summary.
 */
export interface CompactionRenderOptions {
  expanded: boolean;
  readonly supportsCollapsedReplacement?: boolean;
  readonly expandHint?: string;
}
export function renderCompactionPresentation(source: MarkerData | (() => MarkerData), options: CompactionRenderOptions, theme: Theme) {
  if (!options.expanded && options.supportsCollapsedReplacement === true && clean(options.expandHint)) {
    return { kind: 'replace-collapsed' as const,
      component: component(() => typeof source === 'function' ? source() : source, false, theme, false, options.expandHint) };
  }
  return renderCompactionBox(source, options, theme);
}
