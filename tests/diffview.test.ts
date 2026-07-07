import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { trimSession } from "../src/trimmer.ts";
import { buildDiffHtml } from "../src/diffview.ts";
import {
  makeTmpDir,
  writeJsonl,
  userTextRecord,
  assistantTextRecord,
  toolResultRecord,
} from "./helpers.ts";

/**
 * The diff report is the trust surface for lossy modes — if it misattributes
 * or fails to escape, it either lies about the trim or XSSes the reader.
 * These tests run a REAL trim (not hand-built fixtures) so record shapes
 * stay honest against trimmer behavior drift.
 */

function assistantToolUseRecord(toolUseId: string, name: string, input: any): any {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name, input }],
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
  };
}

/** Session with an old tool cycle (gets elided in safe mode) + recent turns. */
function buildSession(dir: string, opts: { payload: string }): string {
  const readId = `toolu_${randomUUID().slice(0, 8)}`;
  const records = [
    userTextRecord("please read the config file"),
    assistantToolUseRecord(readId, "Read", { file_path: "/tmp/config.ts" }),
    toolResultRecord(opts.payload, readId),
    assistantTextRecord("done reading, config looks fine"),
    // Dropped universally by every trim mode — guarantees a "dropped" record.
    {
      type: "file-history-snapshot",
      uuid: randomUUID(),
      messageId: randomUUID(),
      snapshot: { files: {} },
      timestamp: new Date().toISOString(),
    },
    userTextRecord("great, now summarize it"),
    assistantTextRecord("summary: it is a config file"),
  ];
  return writeJsonl(join(dir, "original.jsonl"), records);
}

describe("buildDiffHtml against a real trim", () => {
  test("categorizes records and reports per-tool savings", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      // Large payload so elision saves real bytes; must exceed the
      // squash threshold anyway since safe-mode redaction replaces it.
      const payload = "export const config = { verbose: true };\n".repeat(200);
      const original = buildSession(dir, { payload });
      const result = await trimSession(original, { mode: "safe", keepLastN: 1 });

      const { html, stats } = buildDiffHtml(original, result.path);

      expect(stats.bytesBefore).toBeGreaterThan(stats.bytesAfter);
      // file-history-snapshot is always dropped.
      expect(stats.dropped).toBeGreaterThanOrEqual(1);
      expect(stats.droppedBytes).toBeGreaterThan(0);
      // At minimum: the elided tool_result and the [TRIMMED …]-marked
      // first user record are modified.
      expect(stats.modified).toBeGreaterThanOrEqual(2);
      expect(stats.modifiedBytesSaved).toBeGreaterThan(0);
      // Recent turns inside keep-last-N survive verbatim.
      expect(stats.unchanged).toBeGreaterThanOrEqual(1);

      // Per-tool table: the Read tool_result was elided.
      const read = stats.perTool.find((t) => t.tool === "Read");
      expect(read).toBeDefined();
      expect(read!.bytesSaved).toBeGreaterThan(0);
      expect(html).toContain("Read");
      expect(html).toContain("Savings by tool");
    } finally {
      cleanup();
    }
  });

  test("escapes HTML in shown content — no raw script tags leak through", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const hostile = `<script>alert("xss")</script><img src=x onerror=alert(1)>\n`;
      const original = buildSession(dir, { payload: hostile.repeat(100) });
      const result = await trimSession(original, { mode: "safe", keepLastN: 1 });

      const { html } = buildDiffHtml(original, result.path);

      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain(`<script>alert`);
      expect(html).not.toContain("<img src=x");
    } finally {
      cleanup();
    }
  });

  test("caps oversized snippets with a showing-first-N note", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const payload = "x".repeat(20_000);
      const original = buildSession(dir, { payload });
      const result = await trimSession(original, { mode: "safe", keepLastN: 1 });

      const { html } = buildDiffHtml(original, result.path);
      expect(html).toMatch(/showing first \d+ of \d+ chars/);
    } finally {
      cleanup();
    }
  });

  test("lossless trim of text-only turns reads as mostly unchanged", async () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const original = writeJsonl(join(dir, "original.jsonl"), [
        userTextRecord("hello"),
        assistantTextRecord("hi there"),
        userTextRecord("bye"),
        assistantTextRecord("goodbye"),
      ]);
      const result = await trimSession(original, { mode: "lossless" });

      const { stats } = buildDiffHtml(original, result.path);
      // Only the first user record changes (the [TRIMMED …] marker);
      // sessionId rewrites must NOT count as modifications.
      expect(stats.modified).toBe(1);
      expect(stats.dropped).toBe(0);
      expect(stats.unchanged).toBe(3);
    } finally {
      cleanup();
    }
  });
});
