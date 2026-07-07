import { createReadStream, createWriteStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TrimOptions, TrimResult } from "./types.ts";
import { squashToolResult, squashToolUseInput } from "./squash.ts";
import { isUserTextTurn } from "./records.ts";

/**
 * Masked tool_results get the SAME elision string claude-code's own
 * microcompact writes ("[Read output elided]"). The model has seen this
 * exact format in production constantly, so it can't teach a bad pattern
 * the way a novel "[redacted by claudecompress]" marker could — and it
 * avoids the empty-content shape the Messages API rejects.
 */
function elisionMarker(toolName: string | undefined): string {
  return toolName ? `[${toolName} output elided]` : "[output elided]";
}

/**
 * Appended wherever we hard-truncate a string (tool inputs, banded
 * truncation). Without it a truncated old_string looks like a complete
 * small edit — actively misleading on resume. Deterministic/byte-stable
 * so repeated trims of the same content re-cache identically.
 */
const TRUNCATION_MARKER = "…[truncated]";

// Any string matching this pattern is an old trim marker. When we re-trim
// a session that was already trimmed, we strip the old marker before
// prepending the new one so titles don't accumulate
// "[TRIMMED …][TRIMMED …][TRIMMED …]". Matches both timestamped
// ("[TRIMMED by claudecompress · 2026-04-23 20:42]") and legacy
// ("[TRIMMED by claudecompress]") variants.
const TRIM_MARKER_RE = /^\[TRIMMED by claudecompress(?:\s*·\s*[^\]]+)?\]\s*/;

function buildTrimMarker(): string {
  // YYYY-MM-DD HH:MM in local time; short enough for a prefix.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `[TRIMMED by claudecompress · ${stamp}] `;
}

function stripOldMarker(s: string): string {
  // Peel off any accumulated trim markers (in case older builds chained them).
  let out = s;
  while (TRIM_MARKER_RE.test(out)) out = out.replace(TRIM_MARKER_RE, "");
  return out;
}

function redactToolResult(blk: any, toolName: string | undefined): any {
  // Error outputs are exempt from masking: failed tool calls carry
  // debugging state the model needs on continuation (arXiv 2606.00408
  // found masking errors hurts adaptive debugging). The universal squash
  // pass still bounds their size.
  if (blk.is_error) return blk;
  return {
    type: "tool_result",
    tool_use_id: blk.tool_use_id,
    content: elisionMarker(toolName),
  };
}

function trimRecordRedact(
  rec: any,
  newSid: string,
  toolUseNames: Map<string, string>,
): any | null {
  const out = { ...rec };
  if ("sessionId" in out) out.sessionId = newSid;
  const msg = out.message;
  if (msg && typeof msg === "object" && Array.isArray(msg.content)) {
    const newContent = msg.content.map((blk: any) => {
      if (!blk || typeof blk !== "object") return blk;
      if (blk.type === "tool_result")
        return redactToolResult(blk, toolUseNames.get(blk.tool_use_id));
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

function applyBandAction(
  blk: any,
  action: BandAction,
  toolName?: string,
): any | null {
  if (action.kind === "keep") return blk;
  if (action.kind === "drop") {
    // tool_result blocks must NEVER be removed while their tool_use
    // skeleton stays — that leaves positionally unpaired tool calls the
    // API rejects on resume. "Drop" for a tool_result means "elide the
    // body, keep the pairing".
    if (blk.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: blk.tool_use_id,
        content: elisionMarker(toolName),
      };
    }
    return null;
  }
  const n = action.chars;
  const cut = (s: string) =>
    s.length <= n ? s : s.slice(0, n) + TRUNCATION_MARKER;
  if (blk.type === "text" && typeof blk.text === "string") {
    return blk.text.length <= n ? blk : { ...blk, text: cut(blk.text) };
  }
  if (blk.type === "thinking" && typeof blk.thinking === "string") {
    return blk.thinking.length <= n ? blk : { ...blk, thinking: cut(blk.thinking) };
  }
  if (blk.type === "tool_result") {
    const c = blk.content;
    if (typeof c === "string") {
      return c.length <= n ? blk : { ...blk, content: cut(c) };
    }
    if (Array.isArray(c)) {
      const trimmed = c.map((b: any) => {
        if (b?.type === "text" && typeof b.text === "string") {
          return b.text.length <= n ? b : { ...b, text: cut(b.text) };
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
      let toolName: string | undefined;
      if (blk.type === "text") key = isUser ? "user_text" : "assistant_text";
      else if (blk.type === "thinking") key = "thinking";
      else if (blk.type === "tool_use") key = "tool_use";
      else if (blk.type === "tool_result") {
        // Error outputs survive banding untouched — failed calls carry
        // debugging state; the universal squash still bounds their size.
        if (blk.is_error) { newContent.push(blk); continue; }
        toolName = toolUseNames.get(blk.tool_use_id);
        key = classifyToolResult(toolName);
      }
      else if (blk.type === "image") continue; // always drop
      else { newContent.push(blk); continue; }
      const action = rules[key][band];
      const applied = applyBandAction(blk, action, toolName);
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
  const marker = buildTrimMarker();
  const copy = { ...rec, message: { ...msg } };
  if (typeof c === "string") {
    copy.message.content = marker + stripOldMarker(c);
    return copy;
  }
  if (Array.isArray(c)) {
    const newList: any[] = [];
    let injected = false;
    for (const b of c) {
      if (!injected && b?.type === "text") {
        const cleaned = stripOldMarker(b.text ?? "");
        newList.push({ ...b, text: marker + cleaned });
        injected = true;
      } else {
        newList.push(b);
      }
    }
    if (!injected) {
      newList.unshift({ type: "text", text: marker.trim() });
    }
    copy.message.content = newList;
    return copy;
  }
  return copy;
}

// Recency cutoff is derived from the single prescan in trimSession — no
// separate function needed. Kept as an inline `cutoffFor(N)` closure.

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
): Promise<TrimResult> {
  const newSid = randomUUID();
  const outPath = join(dirname(inputPath), `${newSid}.jsonl`);

  const outStream = createWriteStream(outPath, { encoding: "utf8" });

  let marked = false;
  let lastKeptUuid: string | null = null;
  let originalLines = 0;
  let trimmedLines = 0;
  const toolUseNames = new Map<string, string>();
  const toolUseInputs = new Map<string, any>();

  // Single streaming pass that collects everything we need:
  //  - tool_use → (name, input) map for squash lookups
  //  - array of record indices where each user turn begins, so we can
  //    derive keep-last-N cutoffs for any N without re-reading the file.
  //  - latestReadId: file_path → tool_use_id of the LAST Read on that file
  //    (earlier Reads are stale — dedup by replacing their tool_result)
  //  - latestTodoWriteId: tool_use_id of the last TodoWrite (older Todo
  //    states are overwritten; keep only the most recent)
  //  - cached line strings so the transform pass doesn't re-read from disk
  //
  // Before v0.16.7 this was two full-file reads: an in-memory split() for
  // the prescan and a streaming read for the transform. On 40MB sessions
  // that doubled peak memory (string + split-array) and doubled disk IO.
  // The single-pass version halves both — we still parse each line twice
  // (once for prescan signal extraction, once for transform) but at least
  // the raw bytes only traverse the filesystem once.
  const lines: string[] = [];
  const userTurnAtRecord: number[] = [];
  const latestReadIdByPath = new Map<string, string>();
  const readRecIdxById = new Map<string, number>();
  const lastWriteIdxByPath = new Map<string, number>();
  let latestTodoWriteId: string | null = null;
  const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  {
    const rl = createInterface({
      input: createReadStream(inputPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let recIdx = -1;
    for await (const line of rl) {
      if (!line) continue;
      recIdx += 1;
      originalLines += 1;
      lines.push(line);
      try {
        const rec = JSON.parse(line);
        const content = rec?.message?.content;
        if (Array.isArray(content)) {
          for (const blk of content) {
            if (blk?.type === "tool_use" && blk.id) {
              if (blk.name) toolUseNames.set(blk.id, blk.name);
              if (blk.input) toolUseInputs.set(blk.id, blk.input);
              if (blk.name === "Read" && typeof blk.input?.file_path === "string") {
                latestReadIdByPath.set(blk.input.file_path, blk.id);
                readRecIdxById.set(blk.id, recIdx);
              }
              // Track the last write per path: a Read result is expired
              // the moment a later Edit/Write touches the same file
              // ("expired info" — the strongest drop signal per AgentDiet).
              if (WRITE_TOOLS.has(blk.name) && typeof blk.input?.file_path === "string") {
                lastWriteIdxByPath.set(blk.input.file_path, recIdx);
              }
              if (blk.name === "TodoWrite") {
                latestTodoWriteId = blk.id;
              }
            }
          }
        }
        if (isUserTextTurn(rec)) {
          userTurnAtRecord.push(recIdx);
        }
      } catch {
        // Malformed line — still counted (keeps indexing aligned with the
        // transform pass) and still passed through to the output below.
      }
    }
  }

  const isSupersededTool = (tool_use_id: string): boolean => {
    const name = toolUseNames.get(tool_use_id);
    if (name === "Read") {
      const fp = toolUseInputs.get(tool_use_id)?.file_path;
      if (typeof fp !== "string") return false;
      if (latestReadIdByPath.get(fp) !== tool_use_id) return true;
      // Even the latest Read is expired if a later Edit/Write changed
      // the file — the model would need to re-Read anyway.
      const readIdx = readRecIdxById.get(tool_use_id);
      const writeIdx = lastWriteIdxByPath.get(fp);
      return readIdx !== undefined && writeIdx !== undefined && writeIdx > readIdx;
    }
    if (name === "TodoWrite") {
      return latestTodoWriteId !== tool_use_id;
    }
    return false;
  };

  const cutoffFor = (keepLastN: number): number => {
    if (userTurnAtRecord.length <= keepLastN) return 0;
    return userTurnAtRecord[userTurnAtRecord.length - keepLastN]!;
  };

  const needsCutoff = opts.mode === "safe" || opts.mode === "slim";
  const cutoffRecordIdx = needsCutoff ? cutoffFor(opts.keepLastN ?? 5) : 0;

  const isBanded = opts.mode === "smart";
  const band0Cutoff = isBanded ? cutoffFor(5) : 0;
  const band1Cutoff = isBanded ? cutoffFor(15) : 0;

  const thinkingKeepN = opts.keepLastN ?? 5;
  const thinkingCutoffIdx = opts.dropThinking
    ? cutoffFor(thinkingKeepN)
    : 0;

  let recordIdx = -1;

  // Transform pass — iterates the in-memory line cache built during the
  // prescan above. Parses each line fresh (the prescan only needed a few
  // fields and we don't want to keep every parsed record in memory for
  // large sessions).
  for (const line of lines) {
    // Increment BEFORE the parse. If we incremented only after a
    // successful parse, a single malformed line would shift all
    // subsequent record indices by one relative to prescan — meaning
    // the cutoff boundaries (band0/band1/keepLastN/thinkingCutoff) would
    // land on the wrong records, silently trimming recent turns that the
    // user expected to keep verbatim.
    recordIdx += 1;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      outStream.write(line + "\n");
      trimmedLines += 1;
      continue;
    }

    // file-history-snapshot records are harness metadata for /rewind, not
    // model-reasoning context. Drop them universally — every mode benefits
    // and nothing downstream needs them on resume.
    if (rec?.type === "file-history-snapshot") continue;

    // The /compact summary record is SACRED in every mode. claude-code's
    // /resume replays from the LAST such record — it IS the distilled
    // replacement for everything before it. Truncating it destroys the
    // summarized context; dropping it resurrects the entire pre-compact
    // history on resume. (Found live: smart's band rules were mangling it,
    // reporting phantom 83% savings on a freshly-compacted session.)
    if (rec?.isCompactSummary === true) {
      const kept = { ...rec, ...(rec.sessionId ? { sessionId: newSid } : {}) };
      if (opts.mode === "slim") {
        // Keep the reparenting chain intact around the preserved record.
        kept.parentUuid = lastKeptUuid ?? kept.parentUuid ?? null;
        lastKeptUuid = kept.uuid ?? lastKeptUuid;
      }
      outStream.write(JSON.stringify(kept) + "\n");
      trimmedLines += 1;
      continue;
    }

    const inRecent = needsCutoff && recordIdx >= cutoffRecordIdx;
    let newRec: any | null;
    if (opts.mode === "lossless") {
      // Pass the record through unchanged (modulo sessionId). Only the
      // universal squash step below will touch tool_results.
      newRec = { ...rec, ...(rec.sessionId ? { sessionId: newSid } : {}) };
    } else if (opts.mode === "safe") {
      newRec = inRecent
        ? { ...rec, ...(rec.sessionId ? { sessionId: newSid } : {}) }
        : trimRecordRedact(rec, newSid, toolUseNames);
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
    // Universal squash: compress tool outputs, dedup superseded Reads /
    // TodoWrites, and (for non-lossless modes outside the recent window)
    // compress tool_use INPUTS + truncate verbose older assistant text.
    if (newRec?.message && Array.isArray(newRec.message.content)) {
      const compressInputs =
        (opts.mode === "safe" || opts.mode === "slim") ? !inRecent
        : opts.mode === "smart" ? recordIdx < band0Cutoff
        : /* lossless */ false;

      const isAssistantRec = newRec.type === "assistant";

      const squashed = newRec.message.content.map((blk: any) => {
        if (blk?.type === "tool_result") {
          // Dedup: if this tool_result is from a Read or TodoWrite that
          // was superseded later in the session (a newer Read of the same
          // path, a later Edit/Write to it, or a newer Todo state), elide
          // its body. The tool_use block stays as breadcrumb; error
          // results are exempt (debugging state).
          if (blk.tool_use_id && !blk.is_error && isSupersededTool(blk.tool_use_id)) {
            return { ...blk, content: elisionMarker(toolUseNames.get(blk.tool_use_id)) };
          }
          const toolName = toolUseNames.get(blk.tool_use_id);
          const toolInput = toolUseInputs.get(blk.tool_use_id);
          return squashToolResult(blk, toolName, toolInput);
        }
        if (blk?.type === "tool_use" && compressInputs) {
          return squashToolUseInput(blk, blk.name);
        }
        // Truncate older assistant text. On safe/slim, observation masking
        // only touches tool_results — assistant prose otherwise passes
        // through intact, but filler lines ("Great, I'll now...", "Let me
        // check...") are rarely load-bearing. Cap at 400 chars outside
        // the recent window. Skipped for smart mode because its per-band
        // rules already govern assistant_text length (T(800)/T(300)/DROP),
        // and for lossless (which is, by definition, not supposed to cut).
        if (
          blk?.type === "text" &&
          compressInputs &&
          isAssistantRec &&
          (opts.mode === "safe" || opts.mode === "slim")
        ) {
          const t = blk.text;
          if (typeof t === "string" && t.length > 400) {
            return { ...blk, text: t.slice(0, 400) + TRUNCATION_MARKER };
          }
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
    trimmedLines += 1;
  }
  await new Promise<void>((resolve, reject) => {
    outStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  const originalBytes = statSync(inputPath).size;
  const trimmedBytes = statSync(outPath).size;
  const reductionPct = originalBytes === 0
    ? 0
    : Math.round(((originalBytes - trimmedBytes) / originalBytes) * 1000) / 10;
  return {
    path: outPath,
    newSessionId: newSid,
    originalBytes,
    trimmedBytes,
    originalLines,
    trimmedLines,
    reductionPct,
  };
}
