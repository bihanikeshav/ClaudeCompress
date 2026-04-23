export type TrimMode = "lossless" | "safe" | "smart" | "slim" | "archive";

/**
 * Legacy mode names from earlier versions, kept parseable so old slash
 * commands don't silently fail. The hook maps them to current names.
 * v0.11 rename: recency→safe, distill→smart, focus→slim, ultra→archive.
 * v0.10 removals: redact, truncate, sift, old "smart" (per-tool rules).
 */
export type LegacyTrimMode =
  | "recency" | "distill" | "focus" | "ultra"
  | "redact" | "truncate" | "sift";

export interface TrimOptions {
  mode: TrimMode;
  keepChars?: number;
  keepLastN?: number;
  dropThinking?: boolean;
}

export interface SizeReport {
  path: string;
  bytes: number;
  lines: number;
  sizes: Record<string, number>;
  counts: Record<string, number>;
}

export interface SessionSummary {
  path: string;
  sessionId: string;
  bytes: number;
  mtime: Date;
  firstUserMessage: string;
}
