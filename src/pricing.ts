/**
 * Per-model pricing and token-estimation ratios.
 *
 * Pricing is USD per 1M tokens on cold input (no cache hit).
 * Prompt-cache hits are ~10% of input rate, cache writes ~125%.
 * Cold /resume after a cache expiry pays full input on every replayed token.
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
    inputPerMillion: 15,
    cachedInputPerMillion: 1.5,
    charsPerToken: 3.6,
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    inputPerMillion: 15,
    cachedInputPerMillion: 1.5,
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
    inputPerMillion: 0.8,
    cachedInputPerMillion: 0.08,
    charsPerToken: 3.6,
  },
];

export function findModel(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

export function estimateTokens(chars: number, model: ModelInfo): number {
  return Math.round(chars / model.charsPerToken);
}

export function estimateColdResumeCost(tokens: number, model: ModelInfo): number {
  return (tokens / 1_000_000) * model.inputPerMillion;
}

export function formatUSD(n: number): string {
  if (n < 0.01) return `<$0.01`;
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}
