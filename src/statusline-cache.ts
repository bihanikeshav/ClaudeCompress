import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Tiny JSON sitting next to each active session. StatusLine reads this on
 * every tick and only re-parses the JSONL when the file's mtime or size has
 * changed. Both are used as keys: mtime alone is enough on most filesystems
 * (NTFS: 100ns resolution, ext4: 1ns) but some have 1-2s granularity (FAT32,
 * older NFS); size catches those gaps since the JSONL only ever grows.
 */
export interface StatuslineCache {
  jsonl_mtime_ms: number;
  jsonl_size: number;
  last_assistant_ts: string | null;
  last_user_ts: string | null;
  last_stop_reason: string | null;
  is_1h_cache: boolean;
}

function cacheDir(): string {
  return join(homedir(), ".claude", "claudecompress");
}

function cachePath(sessionId: string): string {
  return join(cacheDir(), `statusline-cache-${sessionId}.json`);
}

export function readCache(sessionId: string): StatuslineCache | null {
  if (!sessionId) return null;
  try {
    return JSON.parse(readFileSync(cachePath(sessionId), "utf8"));
  } catch {
    return null;
  }
}

export function writeCache(sessionId: string, cache: StatuslineCache): void {
  if (!sessionId) return;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cachePath(sessionId), JSON.stringify(cache));
  } catch {
    // Non-fatal — next tick will just re-parse.
  }
}

/**
 * Only these stop reasons mean "assistant's turn is complete — start the
 * TTL countdown from this record's timestamp". Anything else (tool_use,
 * pause_turn, or an unseen future value) is treated as "turn still in
 * progress, cache is actively hot".
 *
 * Rationale: defaulting unknowns to "in progress" is wrong when the response
 * is actually over but we don't recognize the reason — user stares at a
 * frozen "working" state. Defaulting unknowns to "complete" is also wrong
 * when we misread a new mid-turn state. We pick "complete for unknown"
 * because the visible failure mode (a countdown that ticks until the next
 * JSONL write naturally fixes it) is less confusing than a stuck "working".
 */
const TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "refusal",
]);
const NON_TERMINAL_STOP_REASONS = new Set(["tool_use", "pause_turn"]);

export function isTerminalStopReason(reason: string | null): boolean {
  if (!reason) return true;
  if (NON_TERMINAL_STOP_REASONS.has(reason)) return false;
  // Everything else (known terminal, or unknown) → treat as terminal.
  return true;
}

/**
 * Fallback when stop_reason is absent: inspect content blocks. If any is a
 * tool_use, the turn is mid-flight.
 */
export function inferStopReasonFromContent(content: any): string | null {
  if (!Array.isArray(content)) return null;
  for (const blk of content) {
    if (blk?.type === "tool_use") return "tool_use";
  }
  return null;
}
