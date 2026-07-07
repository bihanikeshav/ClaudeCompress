import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { renderCacheLine } from "../src/statusline.ts";
import { makeTmpDir, writeJsonl, userTextRecord, assistantTextRecord } from "./helpers.ts";

/**
 * Regression tests for the "stuck on cache active" statusline bugs:
 *
 *  1. /compact writes its summary as a *user* record (isCompactSummary).
 *     The state machine treated "user record newest" as "API call in
 *     flight" and showed 'cache active · agent working' forever.
 *  2. Same for any stale user-newest state (session closed mid-prompt,
 *     crashed call): with no grace cap it never fell back to the countdown.
 *
 * renderCacheLine is called with sessionId="" so the mtime-keyed disk
 * cache is bypassed (readCache returns null, writeCache no-ops).
 */

function agoIso(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function cacheAssistant(text: string, secondsAgo: number): any {
  const rec = assistantTextRecord(text, {
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
    },
  });
  rec.timestamp = agoIso(secondsAgo);
  rec.message.stop_reason = "end_turn";
  return rec;
}

describe("statusline: compact + stale-working regressions", () => {
  test("compact summary record does NOT read as 'agent working'", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const path = join(dir, "s.jsonl");
      const a = cacheAssistant("done", 120); // 2 min ago, 5m cache → warm
      const compact = userTextRecord("Summary of the conversation so far: ...");
      compact.isCompactSummary = true;
      compact.isMeta = true;
      compact.timestamp = agoIso(60); // newer than the assistant
      writeJsonl(path, [a, compact]);

      const line = renderCacheLine(path, "");
      expect(line).not.toContain("agent working");
      expect(line).toContain("cache warm");
    } finally {
      cleanup();
    }
  });

  test("fresh real user message still reads as 'agent working'", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const path = join(dir, "s.jsonl");
      const a = cacheAssistant("done", 120);
      const u = userTextRecord("next question");
      u.timestamp = agoIso(30);
      writeJsonl(path, [a, u]);

      const line = renderCacheLine(path, "");
      expect(line).toContain("agent working");
    } finally {
      cleanup();
    }
  });

  test("user-newest state older than the grace window falls back to countdown", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const path = join(dir, "s.jsonl");
      const a = cacheAssistant("done", 20 * 60); // 20 min ago
      const u = userTextRecord("prompt that never got a reply");
      u.timestamp = agoIso(15 * 60); // 15 min ago — way past the 10m grace
      writeJsonl(path, [a, u]);

      const line = renderCacheLine(path, "");
      expect(line).not.toContain("agent working");
      expect(line).toContain("cache cold"); // 5m TTL long expired
    } finally {
      cleanup();
    }
  });
});
