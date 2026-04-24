/**
 * Per-model pricing and token-estimation ratios.
 *
 * Pricing is USD per 1M tokens, sourced from platform.claude.com/docs/en/about-claude/pricing.
 *
 * `inputPerMillion` is the base input rate (no cache).
 * `cachedInputPerMillion` is the cache read rate (~10% of base input).
 *
 * Cold /resume on Claude Code writes the full session into 1h cache. Per
 * Anthropic's pricing: 1h cache write = 2× base input. So cold rebuild cost
 * is `inputPerMillion * 2 * tokens / 1M`. estimateColdResumeCost handles this.
 *
 * `charsPerToken` is an empirical ratio used for quick estimation without
 * shipping a full tokenizer. Claude's tokenizer isn't publicly distributed,
 * so we approximate with a slightly-below-4 ratio that tracks mixed
 * English + code content in practice. Marked (approx) in the UI.
 */

export interface ModelInfo {
  id: string;
  label: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  charsPerToken: number;
}

export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    charsPerToken: 3.6,
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    charsPerToken: 3.6,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    inputPerMillion: 3,
    cachedInputPerMillion: 0.3,
    charsPerToken: 3.6,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    charsPerToken: 3.6,
  },
];

export function findModel(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

export function estimateTokens(chars: number, model: ModelInfo): number {
  return Math.round(chars / model.charsPerToken);
}

/**
 * Cost of a cold /resume: the full session gets re-cached at 1h cache write
 * rate (2× base input per Anthropic's pricing). Claude Code uses 1h cache
 * breakpoints by default, so this is the realistic cold rebuild cost.
 */
export function estimateColdResumeCost(tokens: number, model: ModelInfo): number {
  return (tokens / 1_000_000) * model.inputPerMillion * 2;
}

export function formatUSD(n: number): string {
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}
