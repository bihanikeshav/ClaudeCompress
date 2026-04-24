export type TrimMode = "lossless" | "safe" | "smart" | "slim";

/**
 * Legacy mode names from earlier versions, kept parseable so old slash
 * commands don't silently fail. The hook maps them to current names.
 * v0.11 rename: recency→safe, distill→smart, focus→slim, ultra→archive (now removed).
 * v0.16 removal: archive (dominated by slim; see landing rationale).
 * v0.10 removals: redact, truncate, sift, old "smart" (per-tool rules).
 */
export type LegacyTrimMode =
  | "recency" | "distill" | "focus" | "ultra" | "archive"
  | "redact" | "truncate" | "sift";

export interface TrimOptions {
  mode: TrimMode;
  keepLastN?: number;
  dropThinking?: boolean;
}

export interface TrimResult {
  /** Absolute path of the new (trimmed) JSONL. */
  path: string;
  /** Session id of the trimmed file (basename without extension). */
  newSessionId: string;
  originalBytes: number;
  trimmedBytes: number;
  originalLines: number;
  trimmedLines: number;
  /** Bytes saved as a percentage, rounded to 1 decimal (0-100). */
  reductionPct: number;
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
