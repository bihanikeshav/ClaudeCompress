import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TrimOptions } from "./types.ts";
import { squashToolResult, squashToolUseInput } from "./squash.ts";

const TRIM_MARKER = "[TRIMMED by claudecompress] ";
const REDACT_PLACEHOLDER = "";

function redactToolResult(blk: any): any {
  const out: Record<string, unknown> = {
    type: "tool_result",
    tool_use_id: blk.tool_use_id,
    content: REDACT_PLACEHOLDER,
  };
  if (blk.is_error) out.is_error = true;
  return out;
}

function trimRecordRedact(rec: any, newSid: string): any | null {
  const out = { ...rec };
  if ("sessionId" in out) out.sessionId = newSid;
  const msg = out.message;
  if (msg && typeof msg === "object" && Array.isArray(msg.content)) {
    const newContent = msg.content.map((blk: any) => {
      if (!blk || typeof blk !== "object") return blk;
      if (blk.type === "tool_result") return redactToolResult(blk);
      if (blk.type === "image") return null;
      return blk;
    }).filter(Boolean);
    out.message = { ...msg, content: newContent };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Banded per-component trimming (Sift and Distill)
// ---------------------------------------------------------------------------

type BandAction =
  | { kind: "keep" }
  | { kind: "truncate"; chars: number }
  | { kind: "drop" };

type ComponentKey =
  | "user_text"
  | "assistant_text"
  | "thinking"
  | "tool_use"
  | "tool_result_read"
  | "tool_result_bash"
  | "tool_result_grep"
  | "tool_result_edit"
  | "tool_result_agent"
  | "tool_result_mcp_browser"
  | "tool_result_web"
  | "tool_result_other";

type BandRules = Record<ComponentKey, [BandAction, BandAction, BandAction]>;
//                                     band 0         band 1         band 2
//                                     (0-5 turns)    (6-15)         (16+)

const KEEP: BandAction = { kind: "keep" };
const DROP: BandAction = { kind: "drop" };
const T = (chars: number): BandAction => ({ kind: "truncate", chars });

const DISTILL_RULES: BandRules = {
  user_text:                [KEEP, KEEP, T(600)],
  assistant_text:           [T(800), T(300), DROP],
  thinking:                 [T(500), DROP, DROP],
  tool_use:                 [KEEP, KEEP, KEEP], // name+args kept as skeleton
  tool_result_read:         [T(1500), T(300), DROP],
  tool_result_bash:         [T(800), T(200), DROP],
  tool_result_grep:         [T(400), DROP, DROP],
  tool_result_edit:         [T(150), T(80), T(80)],
  tool_result_agent:        [KEEP, T(600), T(200)],
  tool_result_mcp_browser:  [T(200), DROP, DROP],
  tool_result_web:          [T(300), DROP, DROP],
  tool_result_other:        [T(300), DROP, DROP],
};

function classifyToolResult(toolName: string | undefined): ComponentKey {
  if (!toolName) return "tool_result_other";
  const n = toolName;
  if (n === "Read") return "tool_result_read";
  if (n === "Bash") return "tool_result_bash";
  if (n === "Grep" || n === "Glob" || n === "LS") return "tool_result_grep";
  if (n === "Edit" || n === "Write" || n === "MultiEdit" || n === "NotebookEdit") return "tool_result_edit";
  if (n === "Task" || n === "Agent") return "tool_result_agent";
  if (n === "WebFetch" || n === "WebSearch") return "tool_result_web";
  if (/^mcp__.*(chrome|playwright|browser)/i.test(n)) return "tool_result_mcp_browser";
  return "tool_result_other";
}

function applyBandAction(blk: any, action: BandAction): any | null {
  if (action.kind === "keep") return blk;
  if (action.kind === "drop") return null;
  const n = action.chars;
  if (blk.type === "text" && typeof blk.text === "string") {
    return blk.text.length <= n ? blk : { ...blk, text: blk.text.slice(0, n) };
  }
  if (blk.type === "thinking" && typeof blk.thinking === "string") {
    return blk.thinking.length <= n ? blk : { ...blk, thinking: blk.thinking.slice(0, n) };
  }
  if (blk.type === "tool_result") {
    const c = blk.content;
    if (typeof c === "string") {
      return c.length <= n ? blk : { ...blk, content: c.slice(0, n) };
    }
    if (Array.isArray(c)) {
      const trimmed = c.map((b: any) => {
        if (b?.type === "text" && typeof b.text === "string") {
          return b.text.length <= n ? b : { ...b, text: b.text.slice(0, n) };
        }
        if (b?.type === "image") return null;
        return b;
      }).filter(Boolean);
      return { ...blk, content: trimmed };
    }
  }
  return blk;
}

function trimRecordBanded(
  rec: any,
  newSid: string,
  band: 0 | 1 | 2,
  toolUseNames: Map<string, string>,
): any | null {
  const rules = DISTILL_RULES;
  const t = rec?.type;
  if (t !== "user" && t !== "assistant") {
    // Meta records (attachments, snapshots, etc.) — drop when older, keep recent
    return band === 0 ? { ...rec, ...(rec.sessionId ? { sessionId: newSid } : {}) } : null;
  }
  const out = { ...rec };
  if ("sessionId" in out) out.sessionId = newSid;
  const msg = out.message;
  if (!msg || typeof msg !== "object") return out;

  // Capture tool_use → name mapping before we trim blocks.
  if (Array.isArray(msg.content)) {
    for (const blk of msg.content) {
      if (blk?.type === "tool_use" && blk.id && blk.name) {
        toolUseNames.set(blk.id, blk.name);
      }
    }
  }

  const isUser = rec.type === "user";

  if (typeof msg.content === "string") {
    const key: ComponentKey = isUser ? "user_text" : "assistant_text";
    const action = rules[key][band];
    if (action.kind === "drop") return null;
    if (action.kind === "truncate" && msg.content.length > action.chars) {
      out.message = { ...msg, content: msg.content.slice(0, action.chars) };
    }
    return out;
  }

  if (Array.isArray(msg.content)) {
    const newContent: any[] = [];
    for (const blk of msg.content) {
      if (!blk || typeof blk !== "object") { newContent.push(blk); continue; }
      let key: ComponentKey;
      if (blk.type === "text") key = isUser ? "user_text" : "assistant_text";
      else if (blk.type === "thinking") key = "thinking";
      else if (blk.type === "tool_use") key = "tool_use";
      else if (blk.type === "tool_result") key = classifyToolResult(toolUseNames.get(blk.tool_use_id));
      else if (blk.type === "image") continue; // always drop
      else { newContent.push(blk); continue; }
      const action = rules[key][band];
      const applied = applyBandAction(blk, action);
      if (applied !== null) newContent.push(applied);
    }
    if (newContent.length === 0) return null;
    out.message = { ...msg, content: newContent };
  }
  return out;
}

function ultraTrimRecord(rec: any, newSid: string): any | null {
  const t = rec?.type;
  if (t !== "user" && t !== "assistant") return null;
  const msg = rec?.message;
  if (!msg || typeof msg !== "object") return null;
  const c = msg.content;
  let newContent: unknown;
  if (typeof c === "string") {
    if (!c.trim()) return null;
    newContent = c;
  } else if (Array.isArray(c)) {
    const kept = [];
    for (const b of c) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        kept.push({ type: "text", text: b.text });
      }
    }
    if (kept.length === 0) return null;
    newContent = kept;
  } else {
    return null;
  }
  const out = { ...rec, sessionId: newSid, message: { ...msg, content: newContent } };
  return out;
}

function markFirstUser(rec: any): any {
  if (rec?.type !== "user") return rec;
  const msg = rec.message;
  if (!msg) return rec;
  const c = msg.content;
  const copy = { ...rec, message: { ...msg } };
  if (typeof c === "string") {
    copy.message.content = TRIM_MARKER + c;
    return copy;
  }
  if (Array.isArray(c)) {
    const newList: any[] = [];
    let injected = false;
    for (const b of c) {
      if (!injected && b?.type === "text") {
        newList.push({ ...b, text: TRIM_MARKER + (b.text ?? "") });
        injected = true;
      } else {
        newList.push(b);
      }
    }
    if (!injected) {
      newList.unshift({ type: "text", text: TRIM_MARKER.trim() });
    }
    copy.message.content = newList;
    return copy;
  }
  return copy;
}

/**
 * A "conversational exchange" is anchored by a user text message. Each time
 * the user says something, everything that follows (tool calls, tool
 * results, assistant replies, thinking) belongs to that exchange until the
 * next user text turn. Tool_result records (type: "user" with array
 * content) and client-side command records are NOT exchange starts.
 */
function isUserTextTurn(rec: any): boolean {
  if (rec?.type !== "user") return false;
  const content = rec?.message?.content;
  if (typeof content !== "string") return false;
  const trimmed = content.trimStart();
  if (
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<command-message>") ||
    trimmed.startsWith("<command-args>")
  ) {
    return false;
  }
  // Bare typed slash commands aren't conversational exchanges either.
  if (/^\/[a-zA-Z][\w:-]*(\s|$)/.test(trimmed)) return false;
  return true;
}

/**
 * Scan the JSONL once and return the record index of the Nth-from-last user
 * text turn. The trim loop treats records at or after this index as "recent"
 * (kept verbatim); records before it are trimmed per the mode.
 *
 * Returns 0 if there are fewer than N user turns total (keep everything).
 */
function findRecencyCutoffRecordIndex(path: string, keepLastN: number): number {
  const data = readFileSync(path, "utf8");
  const lines = data.split("\n");
  const userTurnAtRecord: number[] = [];
  let recordIdx = -1;
  for (const line of lines) {
    if (!line) continue;
    recordIdx += 1;
    try {
      const r = JSON.parse(line);
      if (isUserTextTurn(r)) userTurnAtRecord.push(recordIdx);
    } catch {
      // skip
    }
  }
  if (userTurnAtRecord.length <= keepLastN) return 0;
  return userTurnAtRecord[userTurnAtRecord.length - keepLastN];
}

function dropThinkingBlocks(rec: any): any | null {
  const msg = rec?.message;
  if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) return rec;
  const filtered = msg.content.filter(
    (b: any) => !(b && typeof b === "object" && b.type === "thinking"),
  );
  if (filtered.length === msg.content.length) return rec;
  if (filtered.length === 0) return null;
  return { ...rec, message: { ...msg, content: filtered } };
}

export async function trimSession(
  inputPath: string,
  opts: TrimOptions,
): Promise<string> {
  const newSid = randomUUID();
  const outPath = join(dirname(inputPath), `${newSid}.jsonl`);

  const rl = createInterface({
    input: createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const outStream = createWriteStream(outPath, { encoding: "utf8" });

  let marked = false;
  let lastKeptUuid: string | null = null;
  const toolUseNames = new Map<string, string>();
  const toolUseInputs = new Map<string, any>();

  // Prescan: collect every tool_use → (name, input) so squash can look them
  // up by tool_use_id when it encounters a tool_result. Streaming the file
  // in order already sees tool_use before the matching tool_result, so we
  // could populate this inline, but banded mode's record-skipping logic
  // makes the prescan safer.
  {
    const fd = readFileSync(inputPath, "utf8");
    for (const line of fd.split("\n")) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        const content = rec?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const blk of content) {
          if (blk?.type === "tool_use" && blk.id) {
            if (blk.name) toolUseNames.set(blk.id, blk.name);
            if (blk.input) toolUseInputs.set(blk.id, blk.input);
          }
        }
      } catch {}
    }
  }

  // safe and slim both need a cutoff; archive doesn't (drops everything structural).
  const needsCutoff = opts.mode === "safe" || opts.mode === "slim";
  const cutoffRecordIdx = needsCutoff
    ? findRecencyCutoffRecordIndex(inputPath, opts.keepLastN ?? 5)
    : 0;

  // smart mode uses two cutoffs for three bands:
  //   band 0: <= 5 user turns back
  //   band 1: 6–15 user turns back
  //   band 2: 16+ user turns back
  const isBanded = opts.mode === "smart";
  const band0Cutoff = isBanded ? findRecencyCutoffRecordIndex(inputPath, 5) : 0;
  const band1Cutoff = isBanded ? findRecencyCutoffRecordIndex(inputPath, 15) : 0;

  // Preserve thinking blocks within the last N user turns regardless of mode.
  // On Opus 4.5+, thinking blocks are preserved by default (see Anthropic's
  // context editing docs). Dropping recent thinking would remove signal the
  // model actively uses on the next turn. Default window: 5 user turns if
  // the mode doesn't specify its own keepLastN.
  const thinkingKeepN = opts.keepLastN ?? 5;
  const thinkingCutoffIdx = opts.dropThinking && opts.mode !== "archive"
    ? findRecencyCutoffRecordIndex(inputPath, thinkingKeepN)
    : 0;

  let recordIdx = -1;

  for await (const line of rl) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      if (opts.mode !== "archive") outStream.write(line + "\n");
      continue;
    }
    recordIdx += 1;
    const inRecent = needsCutoff && recordIdx >= cutoffRecordIdx;
    let newRec: any | null;
    if (opts.mode === "archive") {
      newRec = ultraTrimRecord(rec, newSid);
      if (!newRec) continue;
      newRec.parentUuid = lastKeptUuid;
      lastKeptUuid = newRec.uuid ?? lastKeptUuid;
    } else if (opts.mode === "lossless") {
      // Pass the record through unchanged (modulo sessionId). Only the
      // universal squash step below will touch tool_results.
      newRec = { ...rec, ...(rec.sessionId ? { sessionId: newSid } : {}) };
    } else if (opts.mode === "safe") {
      newRec = inRecent
        ? { ...rec, ...(rec.sessionId ? { sessionId: newSid } : {}) }
        : trimRecordRedact(rec, newSid);
      if (!newRec) continue;
    } else if (opts.mode === "smart") {
      const band: 0 | 1 | 2 =
        recordIdx >= band0Cutoff ? 0
        : recordIdx >= band1Cutoff ? 1
        : 2;
      newRec = trimRecordBanded(rec, newSid, band, toolUseNames);
      if (!newRec) continue;
    } else {
      // slim
      const isTurn = rec.type === "user" || rec.type === "assistant";
      if (!isTurn) {
        if (!inRecent) continue;
        newRec = { ...rec };
        if ("sessionId" in newRec) newRec.sessionId = newSid;
      } else if (!inRecent) {
        newRec = ultraTrimRecord(rec, newSid);
        if (!newRec) continue;
        newRec.parentUuid = lastKeptUuid;
        lastKeptUuid = newRec.uuid ?? lastKeptUuid;
      } else {
        newRec = { ...rec, sessionId: newSid };
        newRec.parentUuid = lastKeptUuid ?? newRec.parentUuid ?? null;
        lastKeptUuid = newRec.uuid ?? lastKeptUuid;
      }
    }
    // Universal squash: compress bloated tool outputs per-tool.
    // Runs across all non-archive modes. Archive has no tool_results.
    //
    // Separately, for records OUTSIDE the last-N window (safe/slim) or
    // outside band 0 (smart), also compress tool_use INPUTS — Edit's
    // old_string/new_string, Write's content, etc. These account for
    // ~46% of session tokens on typical coding sessions. The model can
    // re-Read the current file state if it needs detail on old diffs.
    //
    // Lossless preserves tool_use inputs verbatim (its contract).
    if (opts.mode !== "archive" && newRec?.message && Array.isArray(newRec.message.content)) {
      const compressInputs =
        (opts.mode === "safe" || opts.mode === "slim") ? !inRecent
        : opts.mode === "smart" ? recordIdx < band0Cutoff
        : /* lossless */ false;

      const squashed = newRec.message.content.map((blk: any) => {
        if (blk?.type === "tool_result") {
          const toolName = toolUseNames.get(blk.tool_use_id);
          const toolInput = toolUseInputs.get(blk.tool_use_id);
          return squashToolResult(blk, toolName, toolInput);
        }
        if (blk?.type === "tool_use" && compressInputs) {
          return squashToolUseInput(blk, blk.name);
        }
        return blk;
      });
      newRec = { ...newRec, message: { ...newRec.message, content: squashed } };
    }

    // drop-thinking applies only to safe/slim — smart handles thinking in its
    // per-band rules, and archive strips everything structural anyway.
    if (opts.dropThinking && (opts.mode === "safe" || opts.mode === "slim")) {
      const inThinkingWindow = recordIdx >= thinkingCutoffIdx;
      if (!inThinkingWindow) {
        newRec = dropThinkingBlocks(newRec);
        if (!newRec) continue;
      }
    }
    if (!marked && newRec.type === "user") {
      newRec = markFirstUser(newRec);
      marked = true;
    }
    outStream.write(JSON.stringify(newRec) + "\n");
  }
  await new Promise<void>((resolve, reject) => {
    outStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  return outPath;
}
