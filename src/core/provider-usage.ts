/**
 * Settled pressure is provider-counted, never a chars/4 fallback or foreign usage.
 * Same rule as Pi's `calculateContextTokens` (core/compaction/compaction.js): totalTokens, else the
 * four components. pi-ai normalizes `input` to EXCLUDE cache reads/writes in every adapter
 * (openai-completions: prompt - cacheRead - cacheWrite; openai-responses: input_tokens minus both;
 * anthropic: input_tokens is uncached by API contract), so the component sum does not double-count.
 */
export function settledProviderTokens(branch: readonly any[], leafId: string, model: { provider?: string; id?: string } | undefined): number | null {
  const leaf = branch.find(e => e.id === leafId), m = leaf?.message;
  if (leaf?.type !== 'message' || m?.role !== 'assistant' || m.stopReason !== 'stop' ||
      !model?.provider || !model?.id || m.provider !== model.provider || m.model !== model.id) return null;
  const u = m.usage;
  if (!u || typeof u !== 'object') return null;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (valid(u.totalTokens) && u.totalTokens > 0) return u.totalTokens;
  const parts = [u.input, u.output, u.cacheRead, u.cacheWrite];
  if (!parts.every(valid)) return null;
  const tokens = parts.reduce((a, b) => a + b, 0);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}
