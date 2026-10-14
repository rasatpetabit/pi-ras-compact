/**
 * The chain of why (spec: Design > Why-chain): from the operator request the current work
 * serves, through the agent's own statements of each step, to the current step.
 *
 * As everywhere in the charter, the judge selects and code copies: the judge picks which
 * charter entry the work serves and which paragraph of the agent's own text states the
 * current step; the paragraph is stored as an exact slice of its entry. A request whose
 * work the judge confidently calls finished is shown as one line with its id instead of
 * in full; its text is one jev_expand away. Every failure keeps the previous chain.
 */
import type { BranchMessage, CharterEntry, CharterState } from './charter.js';

export interface ChainStep { entryId: string; start: number; end: number; text: string; gen: number }
export interface ChainBranch { root: string; steps: ChainStep[]; done: boolean; since: number }
export interface ChainState { version: 1; branches: ChainBranch[]; current: string | null }

export const EMPTY_CHAIN: ChainState = { version: 1, branches: [], current: null };

export interface ChainOptions {
  /** Most recent live operator entries offered as the request being served. */
  maxRoots: number;
  /** Most recent agent paragraphs offered as the current step. */
  maxParagraphs: number;
  /** A paragraph shorter than this is not a statement of purpose. */
  minParagraphChars: number;
  showChars: number;
  /** Steps rendered per branch, newest kept. Older steps stay in the carry and are recoverable. */
  renderSteps: number;
  doneThreshold: number;
  /** The confirming "is anything still in progress or pending?" must be at most this. */
  pendingMax: number;
  pickThreshold: number;
}

export const DEFAULT_CHAIN_OPTIONS: ChainOptions = {
  maxRoots: 10, maxParagraphs: 8, minParagraphChars: 60, showChars: 500, renderSteps: 6, doneThreshold: 0.9, pendingMax: 0.1, pickThreshold: 0.5,
};

export interface ChainAsker {
  ask(
    state: Record<string, unknown>,
    questions: Record<string, { type: 'choice' | 'noul'; instructions: string; criteria?: Record<string, string> }>,
  ): Promise<{ answers: Record<string, unknown> }>;
}

const clip = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n)} …`);

/** Paragraphs of an assistant message as exact [start, end) slices. */
export function paragraphs(m: BranchMessage, minChars: number): ChainStep[] {
  const out: ChainStep[] = [];
  const push = (from: number, to: number): void => {
    const raw = m.text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length >= minChars) out.push({ entryId: m.entryId, start: from + lead, end: from + lead + text.length, text, gen: 0 });
  };
  const sep = /\n[ \t]*\n/g;
  let from = 0;
  let match: RegExpExecArray | null;
  while ((match = sep.exec(m.text)) !== null) {
    push(from, match.index);
    from = match.index + match[0].length;
  }
  push(from, m.text.length);
  return out;
}

export function verifyStep(step: ChainStep, source: string): boolean {
  return source.slice(step.start, step.end) === step.text;
}

function readChoice(answer: unknown): { choice: string; p: number } | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const a = answer as Record<string, unknown>;
  const probs = a.probabilities as Record<string, unknown> | undefined;
  if (typeof a.choice !== 'string' || !probs || typeof probs[a.choice] !== 'number') return undefined;
  return { choice: a.choice, p: probs[a.choice] as number };
}
const readNoul = (answer: unknown): number | undefined => {
  const n = (answer as { noul?: unknown } | undefined)?.noul;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

export function readChainState(raw: unknown): ChainState {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_CHAIN, branches: [] };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Array.isArray(r.branches)) return { ...EMPTY_CHAIN, branches: [] };
  const branches: ChainBranch[] = [];
  for (const b of r.branches) {
    if (typeof b !== 'object' || b === null) continue;
    const x = b as Record<string, unknown>;
    if (typeof x.root !== 'string' || !Array.isArray(x.steps)) continue;
    const steps = x.steps.filter((s): s is ChainStep => typeof s === 'object' && s !== null
      && typeof (s as ChainStep).entryId === 'string' && typeof (s as ChainStep).text === 'string'
      && Number.isInteger((s as ChainStep).start) && Number.isInteger((s as ChainStep).end) && typeof (s as ChainStep).gen === 'number');
    branches.push({ root: x.root, steps, done: x.done === true, since: typeof x.since === 'number' ? x.since : 0 });
  }
  const current = typeof r.current === 'string' && branches.some(b => b.root === r.current) ? r.current : null;
  return { version: 1, branches, current };
}

export interface ChainUpdate { state: ChainState; log: Record<string, unknown> }

/**
 * One compaction's update: which live request the span's latest work serves, the paragraph
 * that states the current step, and which open requests are finished.
 */
export async function updateChain(
  previous: ChainState,
  charter: readonly CharterEntry[],
  charterState: CharterState,
  span: readonly BranchMessage[],
  gen: number,
  asker: ChainAsker,
  options: ChainOptions = DEFAULT_CHAIN_OPTIONS,
): Promise<ChainUpdate> {
  const live = charter.filter(e => e.kind === 'said' && !Object.prototype.hasOwnProperty.call(charterState.retired, e.id));
  // The most recent live requests, and always the session's first one: the original ask stays
  // selectable however many messages came after it.
  const recent = live.slice(-options.maxRoots);
  const roots = (live.length > 0 && !recent.includes(live[0]!) ? [...recent, live[0]!] : recent).reverse();
  const paras = span.filter(m => m.role === 'assistant').flatMap(m => paragraphs(m, options.minParagraphChars)).slice(-options.maxParagraphs);
  if (roots.length === 0) return { state: previous, log: { why: 'no_roots' } };
  const rootLabel = new Map<string, string>();
  const rootCriteria: Record<string, string> = {};
  roots.forEach((e, i) => { rootLabel.set(`R${i + 1}`, e.id); rootCriteria[`R${i + 1}`] = clip(e.text, options.showChars); });
  const paraLabel = new Map<string, ChainStep>();
  const paraCriteria: Record<string, string> = {};
  paras.forEach((p, i) => { paraLabel.set(`P${i + 1}`, p); paraCriteria[`P${i + 1}`] = clip(p.text, options.showChars); });
  const open = previous.branches.filter(b => !b.done);
  const questions: Parameters<ChainAsker['ask']>[1] = {};
  const singleton: string[] = [];
  if (roots.length === 1) singleton.push('serves');
  else {
    questions.serves = {
      type: 'choice',
      instructions: 'Which operator request does the agent\'s most recent work (latest_agent_text) serve? Choose the request it is ultimately for.',
      criteria: rootCriteria,
    };
  }
  if (paras.length === 1) singleton.push('step');
  else if (paras.length > 1) {
    questions.step = {
      type: 'choice',
      instructions: 'Which of these paragraphs, written by the agent, best states what it is doing now and why?',
      criteria: paraCriteria,
    };
  }
  const byRoot = new Map(charter.map(e => [e.id, e]));
  open.forEach((b, i) => {
    const root = byRoot.get(b.root);
    if (!root) return;
    questions[`done_${i}`] = {
      type: 'noul',
      instructions: `Given latest_agent_text, is the work this operator request asked for finished, with nothing still in progress for it? Request: ${clip(root.text, options.showChars)}`,
    };
  });
  const latest = span.filter(m => m.role === 'assistant' && m.text.trim().length > 0).slice(-3).map(m => clip(m.text, 1500));
  let answers: Record<string, unknown> = {};
  try {
    if (Object.keys(questions).length > 0) ({ answers } = await asker.ask({ latest_agent_text: latest }, questions));
  } catch {
    return { state: previous, log: { why: 'error' } };
  }
  const branches = previous.branches.map(b => ({ ...b, steps: [...b.steps] }));
  const log: Record<string, unknown> = { why: 'ok' };
  if (singleton.length > 0) log.singleton = singleton;
  // Finished takes two confident answers (spec: Why-chain): done, then nothing pending.
  const candidates = open.filter((b, i) => {
    const p = readNoul(answers[`done_${i}`]);
    log[`done_${b.root}`] = p ?? null;
    return p !== undefined && p >= options.doneThreshold;
  });
  if (candidates.length > 0) {
    const confirm: Parameters<ChainAsker['ask']>[1] = {};
    candidates.forEach((b, i) => {
      const root = byRoot.get(b.root)!;
      confirm[`pending_${i}`] = {
        type: 'noul',
        instructions: `Given latest_agent_text, is anything still in progress, pending or promised for this operator request? Request: ${clip(root.text, options.showChars)}`,
      };
    });
    let pending: Record<string, unknown> = {};
    try {
      ({ answers: pending } = await asker.ask({ latest_agent_text: latest }, confirm));
    } catch {
      pending = {};
    }
    candidates.forEach((b, i) => {
      const q = readNoul(pending[`pending_${i}`]);
      log[`pending_${b.root}`] = q ?? null;
      if (q !== undefined && q <= options.pendingMax) branches.find(x => x.root === b.root)!.done = true;
    });
  }
  // A singleton has selection probability 1, not model-assessed relevance. Keep the
  // normal pickThreshold gate for both deterministic and judged selections.
  const serves = roots.length === 1 ? { choice: 'R1', p: 1 } : readChoice(answers.serves);
  const rootId = serves && serves.p >= options.pickThreshold ? rootLabel.get(serves.choice) : undefined;
  log.serves = serves ?? null;
  if (rootId === undefined) return { state: { version: 1, branches, current: previous.current }, log };
  let branch = branches.find(b => b.root === rootId);
  if (!branch) {
    branch = { root: rootId, steps: [], done: false, since: gen };
    branches.push(branch);
  }
  branch.done = false; // work that still serves a request means it is not finished
  const step = paras.length === 1 ? { choice: 'P1', p: 1 } : readChoice(answers.step);
  log.step = step ?? null;
  const picked = step && step.p >= options.pickThreshold ? paraLabel.get(step.choice) : undefined;
  if (picked) branch.steps.push({ ...picked, gen });
  return { state: { version: 1, branches, current: rootId }, log };
}

export const CHAIN_HEADER = '## Why the current work';

export function renderChain(state: ChainState, charter: readonly CharterEntry[], options: ChainOptions = DEFAULT_CHAIN_OPTIONS): string {
  if (state.branches.length === 0) return '';
  const byId = new Map(charter.map(e => [e.id, e]));
  const one = (id: string, n: number) => {
    const e = byId.get(id);
    return e ? `[${id}] "${clip(e.text.replace(/\s+/g, ' ').trim(), n)}"` : `[${id}]`;
  };
  const lines: string[] = [CHAIN_HEADER];
  const current = state.branches.find(b => b.root === state.current);
  if (current) {
    lines.push(`Current work serves the operator request ${one(current.root, 300)}.`);
    const steps = current.steps.slice(-options.renderSteps);
    if (steps.length > 0) {
      lines.push('Steps toward it, in the agent\'s own words, oldest first:');
      if (current.steps.length > steps.length) lines.push(`- (${current.steps.length - steps.length} earlier steps not shown)`);
      for (const s of steps) lines.push(`- (compaction ${s.gen}) ${s.text}`);
    }
  }
  const openOthers = state.branches.filter(b => !b.done && b !== current);
  if (openOthers.length > 0) {
    lines.push('Other open requests:');
    for (const b of openOthers) lines.push(`- ${one(b.root, 160)}`);
  }
  const done = state.branches.filter(b => b.done && b !== current);
  if (done.length > 0) {
    lines.push('Finished requests (full text by id with jev_expand):');
    for (const b of done) lines.push(`- ${one(b.root, 100)}`);
  }
  return lines.join('\n') + '\n';
}

/** Charter entries of finished requests: rendered one line in the chain, not in full in the charter. */
export function finishedRoots(state: ChainState): Set<string> {
  return new Set(state.branches.filter(b => b.done && b.root !== state.current).map(b => b.root));
}
