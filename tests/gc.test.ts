import { test, expect, describe } from "bun:test";
import { readdirSync, statSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseSize,
  parseDuration,
  hasTrimMarker,
  planGc,
  executeGcPlan,
  type GcOptions,
} from "../src/gc.ts";
import type { TrimEvent } from "../src/history.ts";
import {
  makeTmpDir,
  writeJsonl,
  userTextRecord,
  assistantTextRecord,
  toolResultRecord,
} from "./helpers.ts";

/**
 * gc must never trim the wrong thing: candidate selection is the safety
 * boundary between "reclaim cold sessions" and "churn out duplicate trims
 * of files that were already trimmed". History-based skips are tested with
 * injected fixture events — planGc never touches the real ~/.claude.
 */

const HOUR = 3_600_000;

function baseOpts(overrides: Partial<GcOptions> = {}): GcOptions {
  return {
    mode: "safe",
    keepLastN: 5,
    minSizeBytes: 1000,
    minAgeMs: 24 * HOUR,
    ...overrides,
  };
}

/**
 * Write a session of at least `minBytes` with `turns` user/assistant pairs,
 * each carrying a tool_use/tool_result cycle so trimming has something to
 * mask (a pure-text session can slightly GROW after trim: the [TRIMMED …]
 * marker outweighs the savings).
 */
function writeSession(path: string, opts: { minBytes?: number; turns?: number } = {}): string {
  const turns = opts.turns ?? 4;
  const minBytes = opts.minBytes ?? 2000;
  const pad = "x".repeat(Math.ceil(minBytes / (turns * 3)));
  const records: any[] = [];
  for (let i = 1; i <= turns; i += 1) {
    records.push(userTextRecord(`question ${i} ${pad}`));
    const asst: any = assistantTextRecord(`answer ${i} ${pad}`);
    asst.message.content.push({
      type: "tool_use",
      id: `toolu_${i}`,
      name: "Bash",
      input: { command: `echo ${i}` },
    });
    records.push(asst);
    records.push(toolResultRecord(`output ${i} ${pad}`, `toolu_${i}`));
  }
  return writeJsonl(path, records);
}

/** Backdate a file's mtime by `ms`. */
function ageFile(path: string, ms: number, now = Date.now()): void {
  const t = new Date(now - ms);
  utimesSync(path, t, t);
}

function makeEvent(overrides: Partial<TrimEvent>): TrimEvent {
  return {
    timestamp: new Date().toISOString(),
    mode: "safe",
    model: "claude-opus-4-8",
    sourcePath: "",
    outputPath: "",
    bytesBefore: 1000,
    bytesAfter: 500,
    tokensBefore: 100,
    tokensAfter: 50,
    costBefore: 0.1,
    costAfter: 0.05,
    ...overrides,
  };
}

describe("gc: flag parsers", () => {
  test("parseSize handles units and bare bytes", () => {
    expect(parseSize("500kb")).toBe(512_000);
    expect(parseSize("2mb")).toBe(2_097_152);
    expect(parseSize("2MB")).toBe(2_097_152);
    expect(parseSize("1gb")).toBe(1_073_741_824);
    expect(parseSize("1234")).toBe(1234);
    expect(parseSize("1.5kb")).toBe(1536);
  });

  test("parseSize rejects garbage", () => {
    expect(() => parseSize("lots")).toThrow();
    expect(() => parseSize("10 parsecs")).toThrow();
    expect(() => parseSize("")).toThrow();
  });

  test("parseDuration handles m/h/d", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("6h")).toBe(6 * HOUR);
    expect(parseDuration("2d")).toBe(48 * HOUR);
    expect(parseDuration("90s")).toBe(90_000);
  });

  test("parseDuration rejects unitless and garbage input", () => {
    // A bare number is ambiguous (minutes? hours?) — refuse rather than guess.
    expect(() => parseDuration("30")).toThrow();
    expect(() => parseDuration("soon")).toThrow();
    expect(() => parseDuration("2w")).toThrow();
  });
});

describe("gc: candidate selection", () => {
  test("filters by min-size and min-age", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const bigOld = writeSession(join(dir, "big-old.jsonl"), { minBytes: 2000 });
      const smallOld = writeSession(join(dir, "small-old.jsonl"), { minBytes: 100, turns: 1 });
      const bigFresh = writeSession(join(dir, "big-fresh.jsonl"), { minBytes: 2000 });
      ageFile(bigOld, 48 * HOUR);
      ageFile(smallOld, 48 * HOUR);
      // bigFresh keeps its just-written mtime → too young

      // small-old really is under the threshold
      expect(statSync(smallOld).size).toBeLessThan(1000);

      const plan = planGc([dir], baseOpts());
      expect(plan.candidates.map((c) => c.path)).toEqual([bigOld]);
      expect(plan.candidates[0]!.tokens).toBeGreaterThan(0);
      expect(plan.totalBytes).toBe(statSync(bigOld).size);
    } finally {
      cleanup();
    }
  });

  test("skips trim products via the [TRIMMED …] marker in the file head", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const normal = writeSession(join(dir, "normal.jsonl"), { minBytes: 2000 });
      const records: any[] = [
        userTextRecord("[TRIMMED by claudecompress · 2026-01-01 00:00] original question " + "x".repeat(1500)),
        assistantTextRecord("answer " + "x".repeat(1500)),
      ];
      const trimmed = writeJsonl(join(dir, "trim-product.jsonl"), records);
      ageFile(normal, 48 * HOUR);
      ageFile(trimmed, 48 * HOUR);

      expect(hasTrimMarker(trimmed)).toBe(true);
      expect(hasTrimMarker(normal)).toBe(false);

      const plan = planGc([dir], baseOpts());
      expect(plan.candidates.map((c) => c.path)).toEqual([normal]);
    } finally {
      cleanup();
    }
  });

  test("skips files known to history as outputPath", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const product = writeSession(join(dir, "product.jsonl"), { minBytes: 2000 });
      ageFile(product, 48 * HOUR);
      const history = [makeEvent({ sourcePath: join(dir, "gone.jsonl"), outputPath: product })];
      const plan = planGc([dir], baseOpts(), history);
      expect(plan.candidates).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("skips sessions that already have a NEWER trimmed sibling in history", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const src = writeSession(join(dir, "source.jsonl"), { minBytes: 2000 });
      ageFile(src, 48 * HOUR);
      // Trim happened 24h ago — after the session's last activity (48h ago),
      // so the existing trim is still current and gc must skip.
      const newerTrim = makeEvent({
        sourcePath: src,
        outputPath: join(dir, "sibling.jsonl"),
        timestamp: new Date(Date.now() - 24 * HOUR).toISOString(),
      });
      expect(planGc([dir], baseOpts(), [newerTrim]).candidates).toEqual([]);

      // But if the session was ACTIVE after its last trim, it's fair game again.
      const olderTrim = makeEvent({
        sourcePath: src,
        outputPath: join(dir, "sibling.jsonl"),
        timestamp: new Date(Date.now() - 72 * HOUR).toISOString(),
      });
      expect(planGc([dir], baseOpts(), [olderTrim]).candidates.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("planning is read-only (dry-run creates no files)", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const src = writeSession(join(dir, "source.jsonl"), { minBytes: 2000 });
      ageFile(src, 48 * HOUR);
      const before = readdirSync(dir).sort();
      const plan = planGc([dir], baseOpts());
      expect(plan.candidates.length).toBe(1);
      // --dry-run stops after planGc, so this is the full dry-run write surface.
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });
});

describe("gc: executeGcPlan", () => {
  test("writes trimmed siblings, keeps originals, records via injected sink", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const src = writeSession(join(dir, "source.jsonl"), { minBytes: 4000, turns: 10 });
      ageFile(src, 48 * HOUR);
      const originalBytes = statSync(src).size;

      const plan = planGc([dir], baseOpts());
      expect(plan.candidates.length).toBe(1);

      const recorded: TrimEvent[] = [];
      const result = await executeGcPlan(plan, baseOpts({ keepLastN: 2, dropThinking: true }), {
        record: (e) => recorded.push(e),
      });

      expect(result.trimmed.length).toBe(1);
      expect(result.failures).toEqual([]);
      const out = result.trimmed[0]!.outputPath;
      expect(existsSync(out)).toBe(true);
      expect(out).not.toBe(src);
      // Original untouched — same path, same bytes.
      expect(statSync(src).size).toBe(originalBytes);

      expect(recorded.length).toBe(1);
      expect(recorded[0]!.sourcePath).toBe(src);
      expect(recorded[0]!.outputPath).toBe(out);
      expect(recorded[0]!.mode).toBe("safe");
      expect(result.trimmed[0]!.tokensAfter).toBeLessThanOrEqual(result.trimmed[0]!.tokensBefore);
    } finally {
      cleanup();
    }
  });

  test("continues past a failing candidate", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const good = writeSession(join(dir, "good.jsonl"), { minBytes: 2000 });
      ageFile(good, 48 * HOUR);
      const plan = planGc([dir], baseOpts());
      // Inject a candidate whose file doesn't exist to force a failure.
      plan.candidates.unshift({
        path: join(dir, "vanished.jsonl"),
        sessionId: "vanished",
        bytes: 9999,
        mtimeMs: 0,
        ageLabel: "1d ago",
        tokens: null,
      });

      const recorded: TrimEvent[] = [];
      const result = await executeGcPlan(plan, baseOpts(), { record: (e) => recorded.push(e) });
      expect(result.failures.length).toBe(1);
      expect(result.failures[0]!.path).toContain("vanished");
      expect(result.trimmed.length).toBe(1);
      expect(recorded.length).toBe(1);
    } finally {
      cleanup();
    }
  });
});
