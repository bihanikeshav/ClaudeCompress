export type TrimMode = "ultra" | "recency" | "focus" | "distill";

/**
 * Legacy modes kept parseable so old slash commands don't silently fail.
 * The hook maps any legacy mode to `recency` and prints a deprecation note.
 */
export type LegacyTrimMode = "redact" | "smart" | "truncate" | "sift";

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
