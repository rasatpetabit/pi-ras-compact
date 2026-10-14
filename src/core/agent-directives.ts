/**
 * Accepted plans and agent commitments (spec: Design > Charter, `accepted` and `committed`).
 *
 * Both are the agent's own words, so unlike operator messages they cannot be re-derived from
 * the branch by a rule: the judge selects them once, from candidates code enumerates, and the
 * selected paragraphs are stored in the charter state as exact, verified slices of their
 * entries. Every failure selects nothing; nothing stored is ever dropped here.
 */
import type { BranchMessage } from './charter.js';
import { paragraphs, verifyStep } from './chain.js';

export interface AgentDirective {
  /** `p:<entryId>:<start>` — stable, and unique per paragraph. */
  id: string;
  kind: 'accepted' | 'committed';
  entryId: string;
  start: number;
  end: number;
  text: string;
  /** The operator message that approved it, for `accepted`. */
  approvedBy?: string;
  gen: number;
}

export interface DirectiveAsker {
  ask(
    state: Record<string, unknown>,
    questions: Record<string, { type: 'choice' | 'noul'; instructions: string; criteria?: Record<string, string> }>,
  ): Promise<{ answers: Record<string, unknown> }>;
}

export interface DirectiveOptions {
  approveThreshold: number;
  commitThreshold: number;
  /** Assistant messages before an operator message offered as what it approves. */
  approveCandidates: number;
  /** Commitment candidates asked per compaction, newest kept. */
  maxCommitCandidates: number;
  minParagraphChars: number;
  showChars: number;
}

export const DEFAULT_DIRECTIVE_OPTIONS: DirectiveOptions = {
  approveThreshold: 0.8, commitThreshold: 0.8, approveCandidates: 5, maxCommitCandidates: 24, minParagraphChars: 40, showChars: 900,
};

/** A first-person future or plan marker: the only paragraphs offered as commitments. */
export const COMMIT_MARKER = /\b(I'll|I will|I'm going to|I am going to|next,? I|then I|we will|we'll|plan:|my plan)\b/i;

const clip = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n)} …`);

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

export function readDirectives(raw: unknown): AgentDirective[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is AgentDirective => typeof d === 'object' && d !== null
    && (d.kind === 'accepted' || d.kind === 'committed') && typeof d.id === 'string' && typeof d.entryId === 'string'
    && typeof d.text === 'string' && Number.isInteger(d.start) && Number.isInteger(d.end) && typeof d.gen === 'number');
}

/**
 * Selects, from the messages first compacted now (`fresh`, oldest first, with the messages
 * before them in `all` for context), the plans the operator approved and the agent's commitments.
 * Returns the previous directives plus the new ones; a commitment the operator now approves is
 * promoted to `accepted`.
 */
export async function selectDirectives(
  previous: readonly AgentDirective[],
  all: readonly BranchMessage[],
  fresh: ReadonlySet<string>,
  gen: number,
  asker: DirectiveAsker,
  options: DirectiveOptions = DEFAULT_DIRECTIVE_OPTIONS,
): Promise<{ directives: AgentDirective[]; log: Record<string, number> }> {
  const out = previous.map(d => ({ ...d }));
  const have = new Set(out.map(d => d.id));
  const log = { approvals_asked: 0, approvals_cut: 0, approvals_none: 0, approvals_low: 0, accepted_new: 0, commits_asked: 0, commits_not_offered: 0, committed_new: 0, promoted: 0, errors: 0 };
  const byEntry = new Map(all.map(m => [m.entryId, m]));
  const store = (m: BranchMessage, kind: AgentDirective['kind'], approvedBy?: string) => {
    for (const p of paragraphs(m, options.minParagraphChars)) {
      if (!verifyStep(p, m.text)) continue;
      const id = `p:${p.entryId}:${p.start}`;
      const existing = out.find(d => d.id === id);
      if (existing) {
        if (kind === 'accepted' && existing.kind === 'committed') { existing.kind = 'accepted'; existing.approvedBy = approvedBy; log.promoted++; }
        continue;
      }
      out.push({ id, kind, entryId: p.entryId, start: p.start, end: p.end, text: p.text, ...(approvedBy ? { approvedBy } : {}), gen });
      have.add(id);
      if (kind === 'accepted') log.accepted_new++;
    }
  };

  // Accepted: for each fresh operator message, which of the last few agent messages does it approve?
  for (let i = 0; i < all.length; i++) {
    const m = all[i]!;
    if (m.role !== 'user' || !fresh.has(m.entryId) || m.text.trim().length === 0) continue;
    // The agent messages since the previous operator message, newest first (at most approveCandidates).
    let from = i - 1;
    while (from >= 0 && all[from]!.role !== 'user') from--;
    const since = all.slice(from + 1, i).filter(x => x.role === 'assistant' && x.text.trim().length >= options.minParagraphChars);
    if (since.length > options.approveCandidates) log.approvals_cut++;
    const candidates = since.slice(-options.approveCandidates).reverse();
    if (candidates.length === 0) continue;
    const labels = new Map<string, BranchMessage>();
    const criteria: Record<string, string> = { none: 'It approves none of them (it asks something new, corrects, or only acknowledges).' };
    candidates.forEach((c, k) => { labels.set(`M${k + 1}`, c); criteria[`M${k + 1}`] = clip(c.text, options.showChars); });
    log.approvals_asked++;
    try {
      const { answers } = await asker.ask({ operator_message: clip(m.text, options.showChars) }, {
        approves: {
          type: 'choice',
          instructions: 'Does operator_message approve, accept or say to go ahead with a plan or proposal the agent made in one of these agent messages? Choose that message, or none.',
          criteria,
        },
      });
      const read = readChoice(answers.approves);
      if (!read || read.choice === 'none') log.approvals_none++;
      else if (read.p < options.approveThreshold) log.approvals_low++;
      const chosen = read && read.p >= options.approveThreshold ? labels.get(read.choice) : undefined;
      if (chosen) store(chosen, 'accepted', `u:${m.entryId}`);
    } catch {
      log.errors++;
    }
  }

  // Committed: fresh agent paragraphs with a future or plan marker, asked yes/no.
  const freshParagraphs = all.filter(m => m.role === 'assistant' && fresh.has(m.entryId)).flatMap(m => paragraphs(m, options.minParagraphChars));
  log.commits_not_offered = freshParagraphs.filter(p => !COMMIT_MARKER.test(p.text)).length;
  const commitCandidates = freshParagraphs
    .filter(p => COMMIT_MARKER.test(p.text))
    .filter(p => !have.has(`p:${p.entryId}:${p.start}`))
    .slice(-options.maxCommitCandidates);
  if (commitCandidates.length > 0) {
    const questions: Parameters<DirectiveAsker['ask']>[1] = {};
    commitCandidates.forEach((p, k) => {
      questions[`commits_${k}`] = {
        type: 'noul',
        instructions: `Is this paragraph, written by the agent, a commitment to the operator about what it will deliver or how it will do the work (not a routine next step such as reading a file)? Paragraph: ${clip(p.text, options.showChars)}`,
      };
    });
    log.commits_asked = commitCandidates.length;
    try {
      const { answers } = await asker.ask({}, questions);
      commitCandidates.forEach((p, k) => {
        const n = readNoul(answers[`commits_${k}`]);
        const m = byEntry.get(p.entryId);
        if (n === undefined || n < options.commitThreshold || !m || !verifyStep(p, m.text)) return;
        out.push({ id: `p:${p.entryId}:${p.start}`, kind: 'committed', entryId: p.entryId, start: p.start, end: p.end, text: p.text, gen });
        log.committed_new++;
      });
    } catch {
      log.errors++;
    }
  }
  return { directives: out, log };
}

export function renderDirectives(directives: readonly AgentDirective[]): string {
  const accepted = directives.filter(d => d.kind === 'accepted');
  const committed = directives.filter(d => d.kind === 'committed');
  if (accepted.length === 0 && committed.length === 0) return '';
  const lines: string[] = [];
  if (accepted.length > 0) {
    lines.push('Plans the operator accepted (the agent\'s words, oldest first):');
    for (const d of accepted) lines.push(`[accepted ${d.id}${d.approvedBy ? `, approved by ${d.approvedBy}` : ''}]`, d.text, '');
  }
  if (committed.length > 0) {
    lines.push('Commitments the agent made (its own words, oldest first):');
    for (const d of committed) lines.push(`[committed ${d.id}]`, d.text, '');
  }
  return lines.join('\n');
}
