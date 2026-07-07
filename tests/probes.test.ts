import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  extractSignals,
  scoreRetention,
  readJsonlRecords,
  scoreFileAnswer,
  extractPathCandidates,
} from "../src/probes.ts";
import { trimSession } from "../src/trimmer.ts";
import {
  makeTmpDir,
  writeJsonl,
  userTextRecord,
  assistantTextRecord,
  toolResultRecord,
} from "./helpers.ts";

/**
 * Deterministic probe tests only — no network. The probe module's job is to
 * measure what a trim mode destroys, so the assertions here pin the two
 * behaviors the README table depends on:
 *
 *   - safe keeps the tool_use skeleton (observation masking only touches
 *     tool_result bodies) → skeleton/artifact retention stay 1.0
 *   - slim drops tool_use blocks outside the keep-last-N window → skeleton
 *     retention measurably falls below 1.0
 */

/** Assistant record whose content is a single tool_use block. */
function assistantToolUseRecord(name: string, id: string, input: any): any {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
  };
}

/** User record carrying an is_error tool_result. */
function errorResultRecord(content: string, toolUseId: string): any {
  const rec = toolResultRecord(content, toolUseId);
  rec.message.content[0].is_error = true;
  return rec;
}

/**
 * Fixture: an early "work phase" (user ask → Edit + Write tool cycles, one
 * error) followed by enough later user turns that keepLastN=2 pushes the
 * whole work phase outside the recent window.
 */
function buildFixture(): any[] {
  const records: any[] = [];
  records.push(userTextRecord("please refactor the parser and add a config file"));
  records.push(
    assistantToolUseRecord("Edit", "toolu_edit_1", {
      file_path: "/proj/src/parser.ts",
      old_string: "const old = 1;\n".repeat(40),
      new_string: "const shiny = 2;\n".repeat(40),
    }),
  );
  records.push(toolResultRecord("ok, edited /proj/src/parser.ts", "toolu_edit_1"));
  records.push(
    assistantToolUseRecord("Write", "toolu_write_1", {
      file_path: "/proj/config.json",
      content: JSON.stringify({ some: "config" }),
    }),
  );
  records.push(toolResultRecord("wrote file", "toolu_write_1"));
  records.push(
    assistantToolUseRecord("Bash", "toolu_bash_1", { command: "bun test tests/" }),
  );
  records.push(
    errorResultRecord("error: 3 tests failed\nExpected 2 but received 1", "toolu_bash_1"),
  );
  records.push(assistantTextRecord("The edit is done; tests need a follow-up fix."));
  // Later turns: these become the keepLastN=2 recent window.
  records.push(userTextRecord("now write the release notes"));
  records.push(assistantTextRecord("Drafted the release notes."));
  records.push(userTextRecord("thanks, ship it"));
  records.push(assistantTextRecord("Shipping."));
  return records;
}

describe("probes: extractSignals", () => {
  test("collects artifacts, skeleton, user asks, and error snippets", () => {
    const signals = extractSignals(buildFixture());
    expect(signals.artifacts).toEqual(["/proj/src/parser.ts", "/proj/config.json"]);
    expect(signals.toolSkeleton).toEqual(["Edit", "Write", "Bash"]);
    expect(signals.userAsks).toEqual([
      "please refactor the parser and add a config file",
      "now write the release notes",
      "thanks, ship it",
    ]);
    expect(signals.errorSnippets).toHaveLength(1);
    expect(signals.errorSnippets[0]).toStartWith("error: 3 tests failed");
  });

  test("MultiEdit and NotebookEdit inputs contribute artifacts; duplicates dedup", () => {
    const records = [
      assistantToolUseRecord("MultiEdit", "toolu_me_1", {
        file_path: "/proj/src/multi.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      }),
      assistantToolUseRecord("NotebookEdit", "toolu_nb_1", {
        notebook_path: "/proj/nb.ipynb",
        new_source: "print(1)",
      }),
      // Same path edited twice — must not double-count.
      assistantToolUseRecord("Edit", "toolu_e_2", {
        file_path: "/proj/src/multi.ts",
        old_string: "b",
        new_string: "e",
      }),
      // Read is not a write tool — no artifact, but skeleton entry.
      assistantToolUseRecord("Read", "toolu_r_1", { file_path: "/proj/other.ts" }),
    ];
    const signals = extractSignals(records);
    expect(signals.artifacts).toEqual(["/proj/src/multi.ts", "/proj/nb.ipynb"]);
    expect(signals.toolSkeleton).toEqual(["MultiEdit", "NotebookEdit", "Edit", "Read"]);
  });

  test("userAsks keeps only the last 10 real turns and skips command records", () => {
    const records: any[] = [];
    for (let i = 1; i <= 14; i++) records.push(userTextRecord(`ask number ${i}`));
    records.push(userTextRecord("/compact now")); // client-side command, not a turn
    const signals = extractSignals(records);
    expect(signals.userAsks).toHaveLength(10);
    expect(signals.userAsks[0]).toBe("ask number 5");
    expect(signals.userAsks[9]).toBe("ask number 14");
  });
});

describe("probes: retention scoring across trim modes", () => {
  test("safe keeps tool_use skeleton and artifacts -> retention 1.0", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const input = writeJsonl(join(dir, "in.jsonl"), buildFixture());
      const ground = extractSignals(readJsonlRecords(input));

      const result = await trimSession(input, {
        mode: "safe",
        keepLastN: 2,
        dropThinking: true,
      });
      const scores = scoreRetention(ground, readJsonlRecords(result.path));

      // Observation masking elides tool_result BODIES but never the
      // tool_use blocks — the skeleton and the file_path inputs survive.
      expect(scores.toolSkeletonRetention).toBe(1);
      expect(scores.artifactRetention).toBe(1);
      // User text passes through safe mode untouched (modulo the [TRIMMED
      // marker on the first user record, which scoring strips).
      expect(scores.userAskRetention).toBe(1);
      // is_error results are exempt from masking in safe mode.
      expect(scores.errorRetention).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("slim drops tool_use blocks outside the window -> skeleton and errors fall", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const input = writeJsonl(join(dir, "in.jsonl"), buildFixture());
      const ground = extractSignals(readJsonlRecords(input));
      expect(ground.toolSkeleton.length).toBeGreaterThan(0);

      const result = await trimSession(input, {
        mode: "slim",
        keepLastN: 2,
        dropThinking: true,
      });
      const scores = scoreRetention(ground, readJsonlRecords(result.path));

      // All tool activity sits before the last-2-user-turn window; slim's
      // ultra-trim keeps only dialog text there, so the skeleton is gone.
      expect(scores.toolSkeletonRetention).toBeLessThan(1);
      expect(scores.toolSkeletonRetention).toBe(0);
      // The error tool_result is dropped with it.
      expect(scores.errorRetention).toBe(0);
      // User dialog text is exactly what slim preserves.
      expect(scores.userAskRetention).toBe(1);
      // One artifact stays discoverable via the surviving text mention in
      // "ok, edited /proj/src/parser.ts"? No — that tool_result is dropped
      // too. Neither path is mentioned in kept dialog, so artifacts crater.
      expect(scores.artifactRetention).toBeLessThan(1);
    } finally {
      cleanup();
    }
  });

  test("artifact counts as retained when the path survives only in text", () => {
    const ground = extractSignals([
      assistantToolUseRecord("Edit", "toolu_1", {
        file_path: "/proj/src/kept.ts",
        old_string: "x",
        new_string: "y",
      }),
    ]);
    // Trimmed transcript lost the tool_use but an assistant sentence still
    // names the file — "discoverable anywhere" counts that.
    const trimmed = [assistantTextRecord("I updated /proj/src/kept.ts earlier.")];
    const scores = scoreRetention(ground, trimmed);
    expect(scores.artifactRetention).toBe(1);
    expect(scores.toolSkeletonRetention).toBe(0);
  });

  test("user ask counts as retained when a truncated prefix covers half its length", () => {
    const longAsk = "A".repeat(100) + "B".repeat(100);
    const ground = extractSignals([userTextRecord(longAsk)]);
    // 120 of 200 chars survive (>= half) with the trimmer's marker suffix.
    const enough = [userTextRecord(longAsk.slice(0, 120) + "…[truncated]")];
    expect(scoreRetention(ground, enough).userAskRetention).toBe(1);
    // 40 of 200 chars is below half — not retained.
    const tooShort = [userTextRecord(longAsk.slice(0, 40) + "…[truncated]")];
    expect(scoreRetention(ground, tooShort).userAskRetention).toBe(0);
  });

  test("empty ground-truth dimensions score 1.0, not NaN", () => {
    const ground = extractSignals([]);
    const scores = scoreRetention(ground, []);
    expect(scores.artifactRetention).toBe(1);
    expect(scores.toolSkeletonRetention).toBe(1);
    expect(scores.userAskRetention).toBe(1);
    expect(scores.errorRetention).toBe(1);
  });
});

describe("probes: LLM answer scoring (pure, no network)", () => {
  test("extractPathCandidates pulls pathy tokens and ignores prose", () => {
    const answer = "- src/parser.ts\n- `Z:\\proj\\config.json`\nThose are all the files.";
    const candidates = extractPathCandidates(answer);
    expect(candidates).toContain("src/parser.ts");
    expect(candidates).toContain("Z:\\proj\\config.json");
    expect(candidates).not.toContain("Those");
    expect(candidates).not.toContain("files");
  });

  test("scoreFileAnswer matches relative answers against absolute ground truth", () => {
    const ground = ["/proj/src/parser.ts", "/proj/config.json"];
    const { precision, recall } = scoreFileAnswer(
      "src/parser.ts\nconfig.json\nnotes.txt",
      ground,
    );
    expect(recall).toBe(1); // both ground paths matched by suffix
    expect(precision).toBeCloseTo(2 / 3); // notes.txt is a hallucination
  });

  test("scoreFileAnswer handles slash and case differences", () => {
    const ground = ["Z:\\proj\\src\\parser.ts"];
    const { recall } = scoreFileAnswer("The file was Z:/Proj/Src/Parser.ts", ground);
    expect(recall).toBe(1);
  });
});

describe("probes: compact-boundary scoping", () => {
  test("ground truth ignores records before the last compact summary", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { probeSession, sliceFromLastCompact } = await import("../src/probes.ts");
    const { userTextRecord, assistantTextRecord, toolResultRecord } = await import("./helpers.ts");

    const preEdit = assistantTextRecord("editing old file");
    preEdit.message.content = [
      { type: "text", text: "editing old file" },
      { type: "tool_use", id: "t-pre", name: "Edit", input: { file_path: "/pre/old.ts", old_string: "a", new_string: "b" } },
    ];
    const compact = userTextRecord("Summary of everything before this point.");
    (compact as any).isCompactSummary = true;
    const postEdit = assistantTextRecord("editing new file");
    postEdit.message.content = [
      { type: "text", text: "editing new file" },
      { type: "tool_use", id: "t-post", name: "Edit", input: { file_path: "/post/new.ts", old_string: "c", new_string: "d" } },
    ];
    const records = [
      userTextRecord("pre-compact ask"),
      preEdit,
      toolResultRecord("done", "t-pre"),
      compact,
      userTextRecord("post-compact ask"),
      postEdit,
      toolResultRecord("done", "t-post"),
      assistantTextRecord("all set"),
    ];

    const sliced = sliceFromLastCompact(records);
    expect(sliced.compacted).toBe(true);
    expect(sliced.records[0]!.isCompactSummary).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "ccw-probe-compact-"));
    try {
      const path = join(dir, "s.jsonl");
      writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const { ground, rows, compacted } = await probeSession(path, ["safe"]);
      expect(compacted).toBe(true);
      // Only the post-compact artifact counts as ground truth.
      expect(ground.artifacts).toEqual(["/post/new.ts"]);
      // Nothing pre-compact can register as a loss.
      expect(rows[0]!.scores.artifactRetention).toBe(1);
      expect(rows[0]!.scores.toolSkeletonRetention).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
