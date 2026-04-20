import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { SizeReport, SessionSummary } from "./types.ts";
import { estimateTokens, type ModelInfo } from "./pricing.ts";

const BUCKET_META_TYPES = new Set([
  "file-history-snapshot",
  "attachment",
  "permission-mode",
  "queue-operation",
  "last-prompt",
  "system",
]);

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function analyze(path: string): SizeReport {
  const sizes: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const add = (key: string, n: number) => {
    sizes[key] = (sizes[key] ?? 0) + n;
    counts[key] = (counts[key] ?? 0) + 1;
  };

  const data = readFileSync(path, "utf8");
  let lines = 0;
  let total = 0;
  for (const line of data.split("\n")) {
    if (!line) continue;
    lines += 1;
    total += utf8Bytes(line) + 1; // +1 for newline
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      add("malformed", utf8Bytes(line));
      continue;
    }
    const t = rec?.type ?? "unknown";
    if (BUCKET_META_TYPES.has(t)) {
      add(t, utf8Bytes(line));
      continue;
    }
    const msg = rec?.message;
    if (typeof msg !== "object" || msg === null) {
      add(`${t}/meta`, utf8Bytes(line));
      continue;
    }
    const content = msg.content;
    if (typeof content === "string") {
      add(`${t}/text-str`, utf8Bytes(content));
      continue;
    }
    if (Array.isArray(content)) {
      for (const blk of content) {
        if (!blk || typeof blk !== "object") continue;
        const kind = blk.type ?? "?";
        add(`${t}/${kind}`, utf8Bytes(JSON.stringify(blk)));
      }
    }
  }
  return { path, bytes: total, lines, sizes, counts };
}

function extractFirstUserMessage(path: string): string {
  const data = readFileSync(path, "utf8");
  for (const line of data.split("\n")) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== "user") continue;
    const msg = rec?.message;
    if (!msg) continue;
    const c = msg.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "text" && typeof b.text === "string") return b.text;
      }
    }
  }
  return "(no user message found)";
}

/**
 * Count chars of content that would actually be replayed to the API on /resume.
 * Skips JSONL framing, metadata records, and non-API-visible fields.
 */
export function apiRelevantChars(path: string): number {
  let chars = 0;
  const data = readFileSync(path, "utf8");
  for (const line of data.split("\n")) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const t = rec?.type;
    if (t !== "user" && t !== "assistant") continue;
    const msg = rec?.message;
    if (!msg || typeof msg !== "object") continue;
    const c = msg.content;
    if (typeof c === "string") {
      chars += c.length;
      continue;
    }
    if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== "object") continue;
        const kind = b.type;
        if (kind === "text") chars += (b.text ?? "").length;
        else if (kind === "thinking") chars += (b.thinking ?? "").length;
        else if (kind === "tool_use") {
          chars += (b.name ?? "").length;
          try {
            chars += JSON.stringify(b.input ?? {}).length;
          } catch {
            // ignore
          }
        } else if (kind === "tool_result") {
          const tc = b.content;
          if (typeof tc === "string") chars += tc.length;
          else if (Array.isArray(tc)) {
            for (const sb of tc) {
              if (sb?.type === "text") chars += (sb.text ?? "").length;
            }
          }
        }
      }
    }
  }
  return chars;
}

export function estimateSessionTokens(path: string, model: ModelInfo): number {
  return estimateTokens(apiRelevantChars(path), model);
}

export function summarizeSession(path: string): SessionSummary {
  const st = statSync(path);
  const sessionId = basename(path, ".jsonl");
  const firstUserMessage = extractFirstUserMessage(path);
  return {
    path,
    sessionId,
    bytes: st.size,
    mtime: st.mtime,
    firstUserMessage,
  };
}
