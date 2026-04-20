import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { SizeReport, SessionSummary } from "./types.ts";

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
