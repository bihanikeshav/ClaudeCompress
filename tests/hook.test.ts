import { test, expect, describe } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectCacheState, parseCompressArgs } from "../src/hook.ts";
import {
  makeTmpDir,
  userTextRecord,
  assistantTextRecord,
} from "./helpers.ts";

/**
 * H3 regression: detectCacheState used to only read the last 500KB of the
 * session JSONL. In long sessions where the most recent cache-bearing
 * assistant record is further back (e.g. a run of tool_result records
 * totalling >500KB follows it), the tail window missed it and the function
 * returned `remainingSec: null`. The /compress hook treats null as "cold"
 * and lets the user trim a warm-cache session — burning the cache they
 * were about to reuse.
 */

function buildPaddingUserRecord(kb: number): any {
  // A user record with a long-running tool_result-shaped content block.
  // No `usage` field, so it contributes bytes but not cache signal.
  const chunk = "x".repeat(1024);
  const blob = Array.from({ length: kb }, () => chunk).join("");
  return {
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "fake-tool-id", content: blob }],
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
    userType: "external",
  };
}

describe("detectCacheState (H3 regression)", () => {
  test("finds cache-bearing assistant record buried past 500KB of tail", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const p = join(dir, "session.jsonl");

      const cacheTs = new Date(Date.now() - 30_000).toISOString();
      const asst = {
        parentUuid: null,
        isSidechain: false,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation: {
              ephemeral_5m_input_tokens: 5000,
              ephemeral_1h_input_tokens: 0,
            },
            cache_read_input_tokens: 0,
          },
        },
        uuid: crypto.randomUUID(),
        timestamp: cacheTs,
        sessionId: "test-session",
      };

      // 12 × 60KB = ~720KB of padding, well past the 500KB tail window.
      const padding: any[] = [];
      for (let i = 0; i < 12; i += 1) padding.push(buildPaddingUserRecord(60));

      const body = [asst, ...padding].map((r) => JSON.stringify(r)).join("\n") + "\n";
      writeFileSync(p, body);

      const state = detectCacheState(p);

      expect(state.mode).toBe("5m");
      expect(state.anchorMs).not.toBeNull();
      expect(state.remainingSec).not.toBeNull();
      expect(state.remainingSec!).toBeGreaterThan(200);
      expect(state.remainingSec!).toBeLessThan(300);
    } finally {
      cleanup();
    }
  });

  test("returns fallback (null remainingSec) when no cache-bearing record exists", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const p = join(dir, "session.jsonl");
      const records = [
        userTextRecord("hello"),
        assistantTextRecord("hi there"),
      ];
      const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      writeFileSync(p, body);

      const state = detectCacheState(p);
      expect(state.anchorMs).toBeNull();
      expect(state.remainingSec).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("picks the LATEST cache-bearing assistant when multiple exist", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const p = join(dir, "session.jsonl");

      const older = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old" }],
          usage: {
            cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 },
          },
        },
        uuid: crypto.randomUUID(),
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        sessionId: "test-session",
      };
      const newer = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "new" }],
          usage: {
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1 },
          },
        },
        uuid: crypto.randomUUID(),
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        sessionId: "test-session",
      };

      const body = [older, newer].map((r) => JSON.stringify(r)).join("\n") + "\n";
      writeFileSync(p, body);

      const state = detectCacheState(p);
      // Newer record uses 1h mode — that's what should come back.
      expect(state.mode).toBe("1h");
      expect(state.remainingSec!).toBeGreaterThan(3000);
    } finally {
      cleanup();
    }
  });

  test("small-file fast path still finds the first-line assistant record", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const p = join(dir, "session.jsonl");
      const asst = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          usage: {
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
          },
        },
        uuid: crypto.randomUUID(),
        timestamp: new Date(Date.now() - 5_000).toISOString(),
        sessionId: "test-session",
      };
      writeFileSync(p, JSON.stringify(asst) + "\n");
      const state = detectCacheState(p);
      expect(state.mode).toBe("5m");
      expect(state.remainingSec!).toBeGreaterThan(290);
    } finally {
      cleanup();
    }
  });
});

describe("parseCompressArgs: legacy-mode handling", () => {
  test("current modes pass through unchanged", () => {
    for (const mode of ["lossless", "safe", "smart", "slim"] as const) {
      const r = parseCompressArgs(`/compress ${mode}`);
      expect(r).not.toBeNull();
      expect(r!.mode).toBe(mode);
      expect(r!.renamedFrom).toBeUndefined();
      expect(r!.legacyMode).toBeUndefined();
    }
  });

  test("no mode arg defaults to safe without flagging", () => {
    const r = parseCompressArgs("/compress");
    expect(r).not.toBeNull();
    expect(r!.mode).toBe("safe");
    expect(r!.renamedFrom).toBeUndefined();
    expect(r!.legacyMode).toBeUndefined();
  });

  test("archive is a rename to slim (not a removal — old banner was wrong)", () => {
    const r = parseCompressArgs("/compress archive");
    expect(r).not.toBeNull();
    expect(r!.mode).toBe("slim");
    expect(r!.renamedFrom).toBe("archive");
    expect(r!.legacyMode).toBeUndefined();
  });

  test("v0.11 renames map correctly and are flagged as renames", () => {
    const cases: Array<[string, string]> = [
      ["recency", "safe"],
      ["distill", "smart"],
      ["focus", "slim"],
    ];
    for (const [old, current] of cases) {
      const r = parseCompressArgs(`/compress ${old}`);
      expect(r).not.toBeNull();
      expect(r!.mode).toBe(current);
      expect(r!.renamedFrom).toBe(old);
      expect(r!.legacyMode).toBeUndefined();
    }
  });

  test("v0.10-removed modes fall back to safe and flag legacyMode", () => {
    for (const removed of ["redact", "truncate", "sift"]) {
      const r = parseCompressArgs(`/compress ${removed}`);
      expect(r).not.toBeNull();
      expect(r!.mode).toBe("safe");
      expect(r!.legacyMode).toBe(removed);
      expect(r!.renamedFrom).toBeUndefined();
    }
  });

  test("unknown tokens flag legacyMode so the user sees their typo", () => {
    const r = parseCompressArgs("/compress nonsense");
    expect(r).not.toBeNull();
    expect(r!.mode).toBe("safe");
    expect(r!.legacyMode).toBe("nonsense");
  });

  test("force is parsed and stripped from the mode slot", () => {
    const r = parseCompressArgs("/compress safe force");
    expect(r).not.toBeNull();
    expect(r!.mode).toBe("safe");
    expect(r!.force).toBe(true);

    const r2 = parseCompressArgs("/compress --force");
    expect(r2).not.toBeNull();
    expect(r2!.mode).toBe("safe");
    expect(r2!.force).toBe(true);
  });

  test("numeric second token becomes keepLastN for safe/slim", () => {
    const r = parseCompressArgs("/compress safe 10");
    expect(r).not.toBeNull();
    expect(r!.keepLastN).toBe(10);
  });

  test("non-/compress prompts return null", () => {
    expect(parseCompressArgs("/break")).toBeNull();
    expect(parseCompressArgs("hello there")).toBeNull();
    expect(parseCompressArgs("")).toBeNull();
  });
});
