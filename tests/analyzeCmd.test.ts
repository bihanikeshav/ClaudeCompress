import { test, expect, describe } from "bun:test";
import { readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { analyzeProject, projectSavingsSample } from "../src/analyzeCmd.ts";
import {
  makeTmpDir,
  writeJsonl,
  userTextRecord,
  assistantTextRecord,
  toolResultRecord,
} from "./helpers.ts";

const HOUR = 3_600_000;

function ageFile(path: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
}

/** A session with a realistic mix: user text, assistant text, tool cycle. */
function writeSession(path: string, opts: { turns?: number; pad?: number } = {}): string {
  const turns = opts.turns ?? 3;
  const pad = "x".repeat(opts.pad ?? 400);
  const records: any[] = [];
  for (let i = 1; i <= turns; i += 1) {
    records.push(userTextRecord(`question ${i} ${pad}`));
    const asst: any = assistantTextRecord(`answer ${i} ${pad}`);
    asst.message.content.push({
      type: "tool_use",
      id: `toolu_${i}`,
      name: "Read",
      input: { file_path: `/tmp/f${i}.ts` },
    });
    records.push(asst);
    records.push(toolResultRecord(`file contents ${i} ${pad}${pad}`, `toolu_${i}`));
  }
  return writeJsonl(path, records);
}

describe("analyze: analyzeProject", () => {
  test("aggregates sessions, cache states, categories, and top sessions", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const big = writeSession(join(dir, "big.jsonl"), { turns: 8 });
      const small = writeSession(join(dir, "small.jsonl"), { turns: 2 });
      ageFile(big, 48 * HOUR); // very-cold
      ageFile(small, 10 * 60_000); // 10m → cold

      const report = analyzeProject(dir);
      expect(report.sessionCount).toBe(2);
      expect(report.totalBytes).toBeGreaterThan(0);
      expect(report.totalTokens).toBeGreaterThan(0);
      expect(report.cacheStates).toEqual({ warm: 0, cold: 1, "very-cold": 1 });

      // Top sessions are size-ordered with previews and priced cold-resume cost.
      expect(report.topSessions.length).toBe(2);
      expect(report.topSessions[0]!.path).toBe(big);
      expect(report.topSessions[0]!.bytes).toBeGreaterThan(report.topSessions[1]!.bytes);
      expect(report.topSessions[0]!.preview).toContain("question 1");
      expect(report.topSessions[0]!.coldResumeCost).toBeGreaterThan(0);

      // Category breakdown shows WHERE the bytes go: user text, assistant
      // text, tool_use and tool_result must all be represented.
      const cats = Object.keys(report.categories.sizes);
      expect(cats).toContain("user/text-str");
      expect(cats).toContain("assistant/text");
      expect(cats).toContain("assistant/tool_use");
      expect(cats).toContain("user/tool_result");
      // tool_result carries the doubled padding → it dominates.
      expect(report.categories.sizes["user/tool_result"]!).toBeGreaterThan(
        report.categories.sizes["assistant/text"]!,
      );
    } finally {
      cleanup();
    }
  });

  test("tolerates a malformed session without dropping the rest", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      writeSession(join(dir, "good.jsonl"));
      writeJsonl(join(dir, "junk.jsonl"), []); // empty file
      const report = analyzeProject(dir);
      expect(report.sessionCount).toBe(2);
      expect(report.totalTokens).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("empty / missing project dir yields an empty report", () => {
    const report = analyzeProject(join("Z:", "definitely", "not", "a", "real", "dir"));
    expect(report.sessionCount).toBe(0);
    expect(report.totalBytes).toBe(0);
    expect(report.topSessions).toEqual([]);
  });
});

describe("analyze: projectSavingsSample", () => {
  test("measures all four modes and leaves the project dir untouched", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const src = writeSession(join(dir, "session.jsonl"), { turns: 10, pad: 600 });
      ageFile(src, 48 * HOUR);
      const before = readdirSync(dir).sort();

      const savings = await projectSavingsSample([src], { keepLastN: 2 });
      expect(savings.map((s) => s.mode)).toEqual(["lossless", "safe", "smart", "slim"]);
      for (const s of savings) {
        expect(s.sessionsSampled).toBe(1);
        expect(s.tokensBefore).toBeGreaterThan(0);
        // lossless adds the [TRIMMED …] marker (~8 tokens) and only squashes
        // what its rules cover, so allow marker-sized growth in the floor.
        expect(s.tokensAfter).toBeLessThanOrEqual(s.tokensBefore + 16);
        expect(s.costSaved).toBeGreaterThanOrEqual(0);
      }
      // The aggressive modes must show real shrink on tool-heavy content.
      const byMode = new Map(savings.map((s) => [s.mode, s]));
      expect(byMode.get("safe")!.tokensAfter).toBeLessThan(byMode.get("safe")!.tokensBefore);
      expect(byMode.get("slim")!.tokensAfter).toBeLessThan(byMode.get("slim")!.tokensBefore);
      // The sample trims temp COPIES — no siblings may appear in the real dir.
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  test("skips unreadable sessions without throwing", async () => {
    const savings = await projectSavingsSample([join("Z:", "nope", "missing.jsonl")]);
    for (const s of savings) expect(s.sessionsSampled).toBe(0);
  });
});
