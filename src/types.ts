export type TrimMode = "ultra" | "redact" | "truncate" | "smart" | "recency";

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
