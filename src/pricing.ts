/**
 * Per-model pricing and token-estimation ratios.
 *
 * Pricing is USD per 1M tokens, sourced from platform.claude.com/docs/en/pricing.
 *
 * `inputPerMillion` is the base input rate (no cache).
 * `cachedInputPerMillion` is the cache read rate (~10% of base input).
 *
 * Cold /resume on Claude Code rebuilds the full session into prompt cache.
 * Per Anthropic's pricing: 1h cache write = 2× base input, 5m write = 1.25×.
 * estimateColdResumeCost takes the detected cache mode so the multiplier
 * matches what the user's session actually uses (subscription defaults to
 * 1h; API-key/Bedrock/Vertex default to 5m).
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
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    charsPerToken: 3.6,
  },
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
    id: "claude-fable-5",
    label: "Fable 5",
    inputPerMillion: 10,
    cachedInputPerMillion: 1,
    charsPerToken: 3.6,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    inputPerMillion: 3,
    cachedInputPerMillion: 0.3,
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

/**
 * Resolve a model id (possibly a dated snapshot like
 * "claude-opus-4-7-20260115") to pricing info. Falls back by family
 * (opus/sonnet/haiku/fable) so unknown future ids still price sensibly,
 * then to the first entry.
 */
export function findModel(id: string): ModelInfo {
  const exact = MODELS.find((m) => m.id === id);
  if (exact) return exact;
  const prefix = MODELS.find((m) => id.startsWith(m.id));
  if (prefix) return prefix;
  const lower = id.toLowerCase();
  for (const family of ["opus", "fable", "sonnet", "haiku"]) {
    if (lower.includes(family)) {
      const fam = MODELS.find((m) => m.id.includes(family));
      if (fam) return fam;
    }
  }
  return MODELS[0]!;
}

export function estimateTokens(chars: number, model: ModelInfo): number {
  return Math.round(chars / model.charsPerToken);
}

/**
 * Cost of a cold /resume: the full session gets re-cached at the cache
 * write rate — 2× base input for 1h cache, 1.25× for 5m — per Anthropic's
 * pricing. Claude Code uses 1h cache for subscription auth (the default
 * assumption here) and 5m for API-key auth.
 */
export function estimateColdResumeCost(
  tokens: number,
  model: ModelInfo,
  cacheMode: "5m" | "1h" = "1h",
): number {
  const writeMultiplier = cacheMode === "1h" ? 2 : 1.25;
  return (tokens / 1_000_000) * model.inputPerMillion * writeMultiplier;
}

export function formatUSD(n: number): string {
  if (n < 0.01) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}
