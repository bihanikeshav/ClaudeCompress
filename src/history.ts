import { mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOME } from "./paths.ts";
import type { TrimMode } from "./types.ts";

export const HISTORY_DIR = join(CLAUDE_HOME, "claudecompress");
export const HISTORY_PATH = join(HISTORY_DIR, "history.jsonl");

export interface TrimEvent {
  timestamp: string;
  mode: TrimMode;
  model: string;
  sourcePath: string;
  outputPath: string;
  bytesBefore: number;
  bytesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  costBefore: number;
  costAfter: number;
}

export function recordTrim(event: TrimEvent): void {
  try {
    if (!existsSync(HISTORY_DIR)) {
      mkdirSync(HISTORY_DIR, { recursive: true });
    }
    appendFileSync(HISTORY_PATH, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // history is best-effort; never block the trim itself
  }
}

export function readHistory(): TrimEvent[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const data = readFileSync(HISTORY_PATH, "utf8");
    const events: TrimEvent[] = [];
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    return events;
  } catch {
    return [];
  }
}

export interface HistorySummary {
  count: number;
  tokensSaved: number;
  costSaved: number;
  bytesSaved: number;
}

export function summarizeHistory(events: TrimEvent[] = readHistory()): HistorySummary {
  let tokensSaved = 0;
  let costSaved = 0;
  let bytesSaved = 0;
  for (const e of events) {
    tokensSaved += Math.max(0, e.tokensBefore - e.tokensAfter);
    costSaved += Math.max(0, e.costBefore - e.costAfter);
    bytesSaved += Math.max(0, e.bytesBefore - e.bytesAfter);
  }
  return { count: events.length, tokensSaved, costSaved, bytesSaved };
}
