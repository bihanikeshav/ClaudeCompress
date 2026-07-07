import { test, expect, describe } from "bun:test";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  utimesSync,
} from "node:fs";
import { join, basename } from "node:path";
import { archiveSession, pruneArchives, handlePreCompact } from "../src/hook.ts";
import { makeTmpDir, userTextRecord, assistantTextRecord, writeJsonl } from "./helpers.ts";

/**
 * PreCompact auto-archive: before Claude Code's /compact (manual or auto)
 * replaces earlier history with a summary, the hook snapshots the session
 * JSONL into an archive dir. These tests exercise the pure helpers with
 * explicit temp dirs — the real ~/.claude is never touched.
 */

function makeSessionFile(dir: string, name = "session.jsonl"): string {
  return writeJsonl(join(dir, name), [
    userTextRecord("hello"),
    assistantTextRecord("hi there"),
  ]);
}

describe("archiveSession", () => {
  test("copies the session verbatim into the archive dir with id+timestamp name", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
      const src = makeSessionFile(dir, `${sessionId}.jsonl`);
      const archiveDir = join(dir, "archives");
      const now = new Date(2026, 6, 7, 14, 5, 9); // 2026-07-07 14:05:09 local

      const out = archiveSession(src, archiveDir, { sessionId, now });

      expect(existsSync(out)).toBe(true);
      expect(basename(out)).toBe("abcdef12-20260707-140509.jsonl");
      // Verbatim copy — no injected text, original untouched.
      expect(readFileSync(out, "utf8")).toBe(readFileSync(src, "utf8"));
    } finally {
      cleanup();
    }
  });

  test("falls back to the session filename when session_id is missing", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const src = makeSessionFile(dir, "deadbeefcafe.jsonl");
      const archiveDir = join(dir, "archives");
      const out = archiveSession(src, archiveDir, { now: new Date(2026, 0, 2, 3, 4, 5) });
      expect(basename(out)).toBe("deadbeef-20260102-030405.jsonl");
    } finally {
      cleanup();
    }
  });

  test("does not overwrite an existing archive from the same second", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const src = makeSessionFile(dir);
      const archiveDir = join(dir, "archives");
      const now = new Date(2026, 6, 7, 12, 0, 0);
      const first = archiveSession(src, archiveDir, { sessionId: "same-id-123", now });
      const second = archiveSession(src, archiveDir, { sessionId: "same-id-123", now });
      expect(first).not.toBe(second);
      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("pruneArchives", () => {
  /** Create n dummy archives with strictly increasing mtimes, oldest first. */
  function seedArchives(dir: string, n: number, bytesEach = 10): string[] {
    mkdirSync(dir, { recursive: true });
    const paths: string[] = [];
    const base = Date.now() / 1000 - n * 60;
    for (let i = 0; i < n; i += 1) {
      const p = join(dir, `arch-${String(i).padStart(3, "0")}.jsonl`);
      writeFileSync(p, "x".repeat(bytesEach));
      utimesSync(p, base + i * 60, base + i * 60);
      paths.push(p);
    }
    return paths; // index 0 = oldest
  }

  test("deletes oldest files beyond the max-file cap", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const archiveDir = join(dir, "archives");
      const paths = seedArchives(archiveDir, 7);
      const deleted = pruneArchives(archiveDir, 4, Number.MAX_SAFE_INTEGER);
      expect(deleted.sort()).toEqual(paths.slice(0, 3).sort());
      const remaining = readdirSync(archiveDir).sort();
      expect(remaining).toEqual(paths.slice(3).map((p) => basename(p)).sort());
    } finally {
      cleanup();
    }
  });

  test("deletes oldest files beyond the total-byte cap", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const archiveDir = join(dir, "archives");
      const paths = seedArchives(archiveDir, 5, 100); // 500 bytes total
      // Cap at 250 bytes → the 3 oldest (300 bytes) must go, leaving 200.
      const deleted = pruneArchives(archiveDir, 100, 250);
      expect(deleted.sort()).toEqual(paths.slice(0, 3).sort());
      expect(readdirSync(archiveDir).length).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("leaves everything alone when under both caps", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const archiveDir = join(dir, "archives");
      seedArchives(archiveDir, 3);
      expect(pruneArchives(archiveDir, 40, 500 * 1024 * 1024)).toEqual([]);
      expect(readdirSync(archiveDir).length).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("ignores non-jsonl files and never touches them", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const archiveDir = join(dir, "archives");
      seedArchives(archiveDir, 3);
      const stray = join(archiveDir, "notes.txt");
      writeFileSync(stray, "keep me");
      utimesSync(stray, 0, 0); // oldest mtime of all — still must survive
      pruneArchives(archiveDir, 1, Number.MAX_SAFE_INTEGER);
      expect(existsSync(stray)).toBe(true);
      expect(readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("returns empty for a missing dir instead of throwing", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      expect(pruneArchives(join(dir, "does-not-exist"), 40)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("handlePreCompact (PreCompact stdin JSON → archive flow)", () => {
  test("archives the transcript referenced by a PreCompact hook payload", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const sessionId = "12345678-aaaa-bbbb-cccc-dddddddddddd";
      const src = makeSessionFile(dir, `${sessionId}.jsonl`);
      const archiveDir = join(dir, "archives");

      // Exactly the shape Claude Code sends for PreCompact.
      const input = {
        hook_event_name: "PreCompact",
        session_id: sessionId,
        transcript_path: src,
        cwd: dir,
        trigger: "manual" as const,
        custom_instructions: "",
      };

      const out = handlePreCompact(input, archiveDir);
      expect(out).not.toBeNull();
      expect(existsSync(out!)).toBe(true);
      expect(basename(out!).startsWith("12345678-")).toBe(true);
      expect(readFileSync(out!, "utf8")).toBe(readFileSync(src, "utf8"));
      // Original session file is never mutated or moved.
      expect(existsSync(src)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("auto trigger takes the same path as manual", () => {
    const { dir, cleanup } = makeTmpDir();
    try {
      const src = makeSessionFile(dir);
      const archiveDir = join(dir, "archives");
      const out = handlePreCompact(
        {
          hook_event_name: "PreCompact",
          session_id: "auto-sess-1",
          transcript_path: src,
          cwd: dir,
          trigger: "auto" as const,
        },
        archiveDir,
      );
      expect(out).not.toBeNull();
      expect(existsSync(out!)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
