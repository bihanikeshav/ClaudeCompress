import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TrimOptions } from "./types.ts";
import { applyRuleToText, matchRule } from "./rules.ts";

const TRIM_MARKER = "[TRIMMED by claudecompress] ";
const IMAGE_PLACEHOLDER = "[image stripped by claudecompress]";
const REDACT_PLACEHOLDER = "[tool response redacted by claudecompress]";

function redactToolResult(blk: any): any {
  const out: Record<string, unknown> = {
    type: "tool_result",
    tool_use_id: blk.tool_use_id,
    content: REDACT_PLACEHOLDER,
  };
  if (blk.is_error) out.is_error = true;
  return out;
}

function truncateToolResult(blk: any, maxChars: number): any {
  const content = blk.content;
  if (typeof content === "string") {
    if (content.length > maxChars) {
      return {
        ...blk,
        content:
          content.slice(0, maxChars) +
          `\n\n[... ${content.length - maxChars} chars trimmed by claudecompress]`,
      };
    }
    return blk;
  }
  if (Array.isArray(content)) {
    const newList = content.map((b: any) => {
      if (!b || typeof b !== "object") return b;
      if (b.type === "text" && typeof b.text === "string" && b.text.length > maxChars) {
        return {
          ...b,
          text:
            b.text.slice(0, maxChars) +
            `\n\n[... ${b.text.length - maxChars} chars trimmed]`,
        };
      }
      if (b.type === "image") {
        return { type: "text", text: IMAGE_PLACEHOLDER };
      }
      return b;
    });
    return { ...blk, content: newList };
  }
  return blk;
}

function stripImage(): any {
  return { type: "text", text: IMAGE_PLACEHOLDER };
}

function trimRecordRedact(rec: any, newSid: string, keepChars?: number): any | null {
  const out = { ...rec };
  if ("sessionId" in out) out.sessionId = newSid;
  const msg = out.message;
  if (msg && typeof msg === "object" && Array.isArray(msg.content)) {
    const newContent = msg.content.map((blk: any) => {
      if (!blk || typeof blk !== "object") return blk;
      if (blk.type === "tool_result") {
        return keepChars === undefined
          ? redactToolResult(blk)
          : truncateToolResult(blk, keepChars);
      }
      if (blk.type === "image") return stripImage();
      return blk;
    });
    out.message = { ...msg, content: newContent };
  }
  return out;
}

function smartTrimResult(blk: any, toolName: string | undefined): any {
  const rule = matchRule(toolName ?? "*");
  if (rule.action.kind === "keep") return blk;
  if (rule.action.kind === "redact") return redactToolResult(blk);

  const content = blk.content;
  if (typeof content === "string") {
    const trimmed = applyRuleToText(content, rule.action);
    if (trimmed === content) return blk;
    return { ...blk, content: trimmed };
  }
  if (Array.isArray(content)) {
    const newList = content.map((b: any) => {
      if (!b || typeof b !== "object") return b;
      if (b.type === "text" && typeof b.text === "string") {
        const nt = applyRuleToText(b.text, rule.action);
        return nt === b.text ? b : { ...b, text: nt };
      }
      if (b.type === "image") return { type: "text", text: IMAGE_PLACEHOLDER };
      return b;
    });
    return { ...blk, content: newList };
  }
  return blk;
}

function trimRecordSmart(
  rec: any,
  newSid: string,
  toolUseNames: Map<string, string>,
): any | null {
  const out = { ...rec };
  if ("sessionId" in out) out.sessionId = newSid;
  const msg = out.message;
  if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) return out;

  // First pass on this record: capture any tool_use names it introduces.
  for (const blk of msg.content) {
    if (blk?.type === "tool_use" && blk.id && blk.name) {
      toolUseNames.set(blk.id, blk.name);
    }
  }

  const newContent = msg.content.map((blk: any) => {
    if (!blk || typeof blk !== "object") return blk;
    if (blk.type === "tool_result") {
      const name = toolUseNames.get(blk.tool_use_id);
      return smartTrimResult(blk, name);
    }
    if (blk.type === "image") return stripImage();
    return blk;
  });
  out.message = { ...msg, content: newContent };
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

function dropThinkingBlocks(rec: any): any {
  const msg = rec?.message;
  if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) return rec;
  const filtered = msg.content.filter(
    (b: any) => !(b && typeof b === "object" && b.type === "thinking"),
  );
  if (filtered.length === msg.content.length) return rec;
  if (filtered.length === 0) {
    // Would leave an empty message — keep a tiny placeholder so API stays valid
    filtered.push({ type: "text", text: "[thinking dropped]" });
  }
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

  const needsCutoff = opts.mode === "recency" || opts.mode === "focus";
  const cutoffRecordIdx = needsCutoff
    ? findRecencyCutoffRecordIndex(inputPath, opts.keepLastN ?? 15)
    : 0;
  let recordIdx = -1;

  for await (const line of rl) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      if (opts.mode !== "ultra") outStream.write(line + "\n");
      continue;
    }
    recordIdx += 1;
    const inRecent = needsCutoff && recordIdx >= cutoffRecordIdx;
    let newRec: any | null;
    if (opts.mode === "ultra") {
      newRec = ultraTrimRecord(rec, newSid);
      if (!newRec) continue;
      newRec.parentUuid = lastKeptUuid;
      lastKeptUuid = newRec.uuid ?? lastKeptUuid;
    } else if (opts.mode === "smart") {
      newRec = trimRecordSmart(rec, newSid, toolUseNames);
      if (!newRec) continue;
    } else if (opts.mode === "recency") {
      newRec = inRecent
        ? { ...rec, ...(rec.sessionId ? { sessionId: newSid } : {}) }
        : trimRecordRedact(rec, newSid);
      if (!newRec) continue;
    } else if (opts.mode === "focus") {
      const isTurn = rec.type === "user" || rec.type === "assistant";

      if (!isTurn) {
        // Meta records (attachments, snapshots, queue ops, etc.) — drop them
        // in the trimmed phase, keep verbatim once we're past the cutoff.
        if (!inRecent) continue;
        newRec = { ...rec };
        if ("sessionId" in newRec) newRec.sessionId = newSid;
      } else if (!inRecent) {
        // Old phase: dialog-only trail.
        newRec = ultraTrimRecord(rec, newSid);
        if (!newRec) continue;
        newRec.parentUuid = lastKeptUuid;
        lastKeptUuid = newRec.uuid ?? lastKeptUuid;
      } else {
        newRec = { ...rec, sessionId: newSid };
        newRec.parentUuid = lastKeptUuid ?? newRec.parentUuid ?? null;
        lastKeptUuid = newRec.uuid ?? lastKeptUuid;
      }
    } else {
      newRec = trimRecordRedact(
        rec,
        newSid,
        opts.mode === "truncate" ? opts.keepChars : undefined,
      );
      if (!newRec) continue;
    }
    if (opts.dropThinking && opts.mode !== "ultra") {
      newRec = dropThinkingBlocks(newRec);
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
