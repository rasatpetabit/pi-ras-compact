import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { BackendDescriptor } from '../client/backend-descriptor.js';

export const clean = (value: unknown): string => stripTerminalSequences(typeof value === 'string' ? value : '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
export const k = (n: number): string => n < 1000 ? String(Math.round(n)) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
export const identity = (d?: BackendDescriptor, id?: string): string => clean(d?.label) || clean(d?.id) || clean(id) || 'backend not recorded';
export function destination(d?: BackendDescriptor): string {
  try { const url = new URL(d?.where ?? ''); return clean(url.host) || 'destination not recorded'; }
  catch { return 'destination not recorded'; }
}
export function readDescriptor(value: unknown): BackendDescriptor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !clean(raw.id)) return undefined;
  const out: BackendDescriptor = { id: clean(raw.id) };
  for (const key of ['label', 'model', 'revision', 'verified_revision'] as const) if (typeof raw[key] === 'string' && clean(raw[key])) out[key] = clean(raw[key]);
  if (typeof raw.where === 'string') {
    try { const url = new URL(clean(raw.where)); if (['http:', 'https:'].includes(url.protocol)) out.where = `${url.protocol}//${url.host}`; } catch { /* absent */ }
  }
  return out;
}
export interface ContextFigures { tokensBefore?: number | null; measuredAfter?: number | null; predictedAfter?: number | null; contextAfter?: number | null }
export function contextText(d: ContextFigures): string {
  const before = typeof d.tokensBefore === 'number' ? k(d.tokensBefore) : null;
  if (typeof d.measuredAfter === 'number') return before ? `Context ${before} → ${k(d.measuredAfter)} measured` : `Context after ${k(d.measuredAfter)} measured`;
  if (typeof d.predictedAfter === 'number') return before ? `Context ${before} → ~${k(d.predictedAfter)} predicted` : `Context after ~${k(d.predictedAfter)} predicted`;
  if (typeof d.contextAfter === 'number') return `Messages after ~${k(d.contextAfter)} estimated`;
  return before ? `Context ${before} → unknown` : 'Context after unknown';
}
export interface RouteRecord {
  backend?: string; backend_descriptor?: BackendDescriptor; fallback_from?: string;
  fallback_reason?: string; fallback_descriptor?: BackendDescriptor; reason?: string | null;
  backend_requests?: Record<string, number>;
  backend_responses?: Record<string, number>;
  tokens_before?: number; predicted_after?: number; measured_after?: number; context_after?: number;
}
/** Installed host worst case at 60 columns: Warning: (9) + Text padding (2).
 * Chooser title also fits its maximum configured countdown suffix (7) + padding (2).
 * No terminal width is exposed by Pi; a conservative fixed floor is intentional.
 */
export const MESSAGE_CONTENT_BUDGET = 60 - 11;
export function routeActivity(route: RouteRecord): string {
  const id = readDescriptor(route.backend_descriptor)?.id ?? clean(route.backend);
  const count = id ? route.backend_requests?.[id] : undefined;
  const responses = id ? route.backend_responses?.[id] : undefined;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (valid(responses) && responses > 0) return 'served';
  if (count === 0) return 'no requests';
  if (valid(count) && count > 0) return 'service unconfirmed';
  return 'activity unknown';
}
export function clip(text: string, width: number): string {
  const fitted = truncateToWidth(text, Math.max(0, width), '…');
  return text.includes('\x1b') ? fitted : stripTerminalSequences(fitted);
}
export function fitVariants(variants: string[], width = Infinity): string {
  const safe = variants.map(clean);
  return safe.find(text => visibleWidth(text) <= width) ?? clip(safe.at(-1) ?? '', width);
}
/** Preserve cancellation/native action when unusually long identity itself must be clipped. */
function actionVariants(messages: string[], backend: string, prefix: string, action: string, width: number): string {
  const fit = messages.find(text => visibleWidth(text) <= width);
  if (fit) return fit;
  const fixed = `${prefix} Jev [] ${action}`;
  const budget = width - visibleWidth(fixed);
  if (budget >= 1) return `${prefix} Jev [${clip(backend, budget)}] ${action}`;
  return clip(messages.at(-1) ?? '', width);
}
/** Preserve explicit activity evidence before clipping an unusually long route label. */
export function routeHeadline(route: RouteRecord, width = Infinity): string {
  const backend = identity(readDescriptor(route.backend_descriptor), route.backend);
  const activity = routeActivity(route);
  const base = `✓ Jev [${backend}]${activity ? ` · ${activity}` : ''}`;
  return activity ? actionVariants([base], backend, '✓', `· ${activity}`, width) : fitVariants([base], width);
}
export function outcomeLine(state: string, route: RouteRecord, width = MESSAGE_CONTENT_BUDGET, explanation = 'the compaction failed'): string {
  const d = readDescriptor(route.backend_descriptor), source = readDescriptor(route.fallback_descriptor);
  const b = identity(d, route.backend), f = identity(source, route.fallback_from);
  const r = clean(route.reason ?? route.fallback_reason) || 'reason not recorded';
  const c = contextText({ tokensBefore: route.tokens_before, predictedAfter: route.predicted_after, measuredAfter: route.measured_after, contextAfter: route.context_after });
  const base = routeHeadline(route, width);
  if (state === 'success') {
    const model = clean(d?.model), host = destination(d);
    const routeText = `${base}${model ? ` · ${model}` : ''} @ ${host}`;
    return fitVariants([`${routeText} · ${c}`, routeText, `${base} · ${c}`, `${base} · ${c.replace(/^Context /, '')}`, base], width);
  }
  if (state === 'hosted_success') {
    const text = `${base} ← ${f} (${clean(route.fallback_reason) || 'reason not recorded'})`;
    return fitVariants([`${text} · ${c}`, text, `${base} ← ${f}`, base], width);
  }
  const messages: Record<string, string[]> = {
    failure: [`× Jev [${b}] failed (${r}): ${clean(explanation)}`, `× Jev [${b}] failed (${r})`],
    chooser: [`× Jev [${b}] failed (${r}) — retry, Pi, or cancel?`, `× Jev [${b}] failed (${r}) · choose`, `× Jev [${b}] — retry, Pi, or cancel?`, `× Jev [${b}] · choose action`],
    retry: [`↻ Jev [${b}] · retrying after ${r}`, `↻ Jev [${b}] · retrying`],
    hosted_retry: [`↻ Jev [${b}] failed (${r}) → TypeSafe hosted`, `↻ Jev [${b}] → TypeSafe hosted`],
    native: [`! Jev [${b}] failed (${r}) · Pi summary selected`, `! Jev [${b}] · Pi summary selected`],
    cancel: [`! Jev [${b}] cancelled (${r}) · Pi summary not used`, `! Jev [${b}] cancelled · Pi summary not used`],
    abort: [`! Jev [${b}] cancelled by user · Pi summary not used`, `! Jev [${b}] cancelled · Pi summary not used`],
    headless: [`! Jev [${b}] cancelled (${r}; no chooser) · Pi summary not used`, `! Jev [${b}] cancelled · Pi summary not used`],
    rpc: [`! Jev [${b}] cancelled (${r}; RPC prompt unbounded) · Pi summary not used`, `! Jev [${b}] cancelled · Pi summary not used`],
    last_resort: [`× Jev [${b}] error handling failed · cancelled; Pi summary not used`, `× Jev [${b}] · cancelled; Pi summary not used`],
  };
  const chosen = messages[state] ?? messages.failure;
  if (['cancel', 'abort', 'headless', 'rpc'].includes(state)) return actionVariants([...chosen, `! Jev [${b}] cancelled; Pi not used`], b, '!', 'cancelled; Pi not used', width);
  if (state === 'last_resort') return actionVariants([...chosen, `× Jev [${b}] cancelled; Pi not used`], b, '×', 'cancelled; Pi not used', width);
  if (state === 'native') return actionVariants(chosen, b, '!', '· Pi summary selected', width);
  return fitVariants(chosen, width);
}
