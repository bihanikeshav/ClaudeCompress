import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Create a fresh tmp dir for one test. Caller is responsible for cleanup
 * via the returned disposer.
 */
export function makeTmpDir(prefix = "ccw-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Build a minimal valid JSONL record. Caller passes overrides to tune.
 * Every record gets a unique uuid and the sessionId baked in.
 *
 * The shape matches what Claude Code actually writes — close enough that
 * the trimmer's real-world heuristics apply (isUserTextTurn pattern match,
 * tool_use/tool_result pairing, etc.).
 */
export function userTextRecord(text: string, opts: { sessionId?: string; parentUuid?: string | null } = {}): any {
  return {
    parentUuid: opts.parentUuid ?? null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: text },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: opts.sessionId ?? "test-session",
    userType: "external",
    cwd: "/tmp",
    version: "1.0.0",
  };
}

export function assistantTextRecord(text: string, opts: { sessionId?: string; parentUuid?: string | null; usage?: any } = {}): any {
  const rec: any = {
    parentUuid: opts.parentUuid ?? null,
    isSidechain: false,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: opts.usage,
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: opts.sessionId ?? "test-session",
  };
  if (!opts.usage) delete rec.message.usage;
  return rec;
}

export function toolResultRecord(content: string, toolUseId: string, opts: { sessionId?: string } = {}): any {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: opts.sessionId ?? "test-session",
    userType: "external",
  };
}

/** Write a sequence of records as JSONL to `path` and return it. */
export function writeJsonl(path: string, records: any[]): string {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, body);
  return path;
}

/** Read a JSONL file and return the parsed records (skipping blank lines). */
export function readJsonl(path: string): any[] {
  const data = readFileSync(path, "utf8");
  const out: any[] = [];
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {
      out.push({ __malformed: true, raw: line });
    }
  }
  return out;
}
