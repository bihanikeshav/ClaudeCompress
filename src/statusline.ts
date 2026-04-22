import {
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";

import {
  readCache,
  writeCache,
  isTerminalStopReason,
  inferStopReasonFromContent,
  type StatuslineCache,
} from "./statusline-cache.ts";

interface StatuslineInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 250).unref?.();
  });
}

/**
 * Claude Code writes several user records when the user runs a local slash
 * command like /context, /clear, /compact. None of them represent a message
 * awaiting an assistant response — they're client-side UI artifacts:
 *   1. " /context"                      (literal typed command)
 *   2. "<local-command-caveat>…"        (the caveat header)
 *   3. "<command-name>…</command-name>" (the command wrapper)
 *   4. "<local-command-stdout>…"        (captured stdout, if any)
 *
 * Treating these as "user newer than assistant" locks our statusLine into
 * "agent working" forever. Filter them out when picking the latest real
 * user turn.
 *
 * Tool_result user records (array content, not string) pass through — those
 * DO correspond to real mid-turn activity.
 */
function isClientSideCommandRecord(rec: any): boolean {
  const content = rec?.message?.content;
  if (typeof content !== "string") return false;
  const trimmed = content.trimStart();
  if (
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<command-message>") ||
    trimmed.startsWith("<command-args>")
  ) {
    return true;
  }
  // Bare typed slash command like "/context" or "/compact foo". Slash
  // commands never expect an assistant reply of their own; Claude Code
  // handles them either client-side or by injecting new content.
  return /^\/[a-zA-Z][\w:-]*(\s|$)/.test(trimmed);
}

/**
 * Claude Code writes a synthetic user record when the user aborts mid-turn
 * (ESC / Ctrl-C). Two shapes observed in the wild:
 *   content: [{ type:"text", text:"[Request interrupted by user]" }]
 *   content: [{ type:"text", text:"[Request interrupted by user for tool use]" }]
 *
 * After this, no API call is coming until the user prompts again — the
 * session is idle and the cache is decaying from the interrupt timestamp.
 */
function isInterruptRecord(rec: any): boolean {
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return false;
  for (const blk of content) {
    if (
      blk?.type === "text" &&
      typeof blk.text === "string" &&
      blk.text.startsWith("[Request interrupted by user")
    ) {
      return true;
    }
  }
  return false;
}

function readTail(path: string, size: number, maxBytes = 500_000): string {
  if (size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const offset = size - maxBytes;
    readSync(fd, buf, 0, maxBytes, offset);
    let s = buf.toString("utf8");
    const nl = s.indexOf("\n");
    if (nl >= 0) s = s.slice(nl + 1);
    return s;
  } finally {
    closeSync(fd);
  }
}

/**
 * Walk the tail of the JSONL backwards, collecting the latest user timestamp
 * and the latest assistant record that carries cache usage info + its
 * stop_reason.
 */
function parseLatest(
  path: string,
  size: number,
): Omit<StatuslineCache, "jsonl_mtime_ms" | "jsonl_size"> {
  let data: string;
  try {
    data = readTail(path, size);
  } catch {
    return {
      last_assistant_ts: null,
      last_user_ts: null,
      last_stop_reason: null,
      is_1h_cache: false,
    };
  }
  const lines = data.split("\n");
  let assistant: {
    ts: string | null;
    usage: Usage;
    stop_reason: string | null;
  } | null = null;
  let lastUserTs: string | null = null;
  let lastUserInterrupted = false;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const ts: string | null = rec?.timestamp ?? null;
    if (!lastUserTs && rec?.type === "user" && !isClientSideCommandRecord(rec)) {
      lastUserTs = ts;
      lastUserInterrupted = isInterruptRecord(rec);
    }
    if (!assistant && rec?.type === "assistant") {
      const msg = rec?.message;
      const usage: Usage | undefined = msg?.usage;
      if (!usage) continue;
      const hasCache =
        (usage.cache_creation_input_tokens ?? 0) > 0 ||
        (usage.cache_read_input_tokens ?? 0) > 0 ||
        (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0 ||
        (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0;
      if (!hasCache) continue;
      const stop_reason =
        (msg?.stop_reason as string | undefined) ??
        inferStopReasonFromContent(msg?.content) ??
        null;
      assistant = { ts, usage, stop_reason };
    }
    if (assistant && lastUserTs) break;
  }

  return {
    last_assistant_ts: assistant?.ts ?? null,
    last_user_ts: lastUserTs,
    last_stop_reason: assistant?.stop_reason ?? null,
    is_1h_cache:
      (assistant?.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0,
    last_user_interrupted: lastUserInterrupted,
  };
}

/**
 * Grace window for a fresh assistant(tool_use) record. Within this window the
 * tool is assumed to be executing normally (fast tools return in <1s; even a
 * slow one is probably just working). Past it, we treat the session as blocked
 * — on a permission prompt, a TTY subprocess, or a genuinely long tool — and
 * start showing the countdown. Cache keeps decaying from the assistant ts
 * regardless; the grace just controls whether we hide that fact behind
 * "agent working" momentarily.
 */
const TOOL_USE_GRACE_SEC = 30;

function fmtRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

// ANSI color helpers. Kept minimal — no TrueColor or unusual sequences, so
// this works across Windows Terminal, Git Bash, iTerm2, Kitty, Linux ttys.
// NO_COLOR env var (https://no-color.org) and non-TTY stdout disable colors.
const COLORS_ENABLED = !process.env.NO_COLOR;
const R = COLORS_ENABLED ? "\x1b[0m" : "";
const DIM = COLORS_ENABLED ? "\x1b[2m" : "";
const GREEN = COLORS_ENABLED ? "\x1b[32m" : "";
const YELLOW = COLORS_ENABLED ? "\x1b[33m" : "";
const RED = COLORS_ENABLED ? "\x1b[31m" : "";
const CYAN = COLORS_ENABLED ? "\x1b[36m" : "";

function dim(s: string): string {
  return `${DIM}${s}${R}`;
}
function color(c: string, s: string): string {
  return `${c}${s}${R}`;
}

export async function runStatusline(): Promise<void> {
  const raw = await readStdin();
  let input: StatuslineInput = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // keep going; render what we can
  }
  const path = input.transcript_path;
  const sessionId = input.session_id ?? "";
  if (!path) {
    process.stdout.write("");
    return;
  }

  // --- cache lookup -------------------------------------------------------
  let mtime_ms: number;
  let size: number;
  try {
    const st = statSync(path);
    mtime_ms = st.mtimeMs;
    size = st.size;
  } catch {
    process.stdout.write("◉ new session · cache not yet seeded");
    return;
  }

  const cached = readCache(sessionId);
  let latest: Omit<StatuslineCache, "jsonl_mtime_ms" | "jsonl_size">;
  if (
    cached &&
    cached.jsonl_mtime_ms === mtime_ms &&
    cached.jsonl_size === size
  ) {
    latest = cached;
  } else {
    latest = parseLatest(path, size);
    writeCache(sessionId, { jsonl_mtime_ms: mtime_ms, jsonl_size: size, ...latest });
  }

  // --- render -------------------------------------------------------------
  const modelLabel =
    input.model?.display_name ?? input.model?.id?.replace(/^claude-/, "") ?? "";
  const modelTag = modelLabel ? dim(` · ${modelLabel}`) : "";

  const assistantTs = latest.last_assistant_ts
    ? new Date(latest.last_assistant_ts)
    : null;
  const userTs = latest.last_user_ts ? new Date(latest.last_user_ts) : null;

  // State machine (four cases, only two outputs):
  //
  //  A. user record is newer AND it's NOT an interrupt
  //     → tool_result landed, or user just prompted; an API call is in-flight
  //     → "agent working" (cache being actively read, no countdown useful)
  //
  //  B. assistant record is newer with non-terminal stop_reason
  //     (tool_use / pause_turn), AND age < 30s
  //     → tool just dispatched, probably running fast
  //     → "agent working" (cache was just refreshed by the API call that
  //        emitted this record; grace window before we declare "blocked")
  //
  //  C. user record is newer AND IS an interrupt marker
  //     → user hit ESC; session idle, cache decaying from interrupt ts
  //     → countdown from max(userTs, assistantTs)
  //
  //  D. assistant with tool_use AND age ≥ 30s
  //     → blocked on permission prompt / TTY / genuinely slow tool;
  //        from the cache's POV this is indistinguishable from idle
  //     → countdown from assistantTs
  //
  //  E. assistant with terminal stop_reason (end_turn, max_tokens, …)
  //     → normal idle between turns
  //     → countdown from assistantTs
  //
  // The countdown anchor is max(userTs, assistantTs) — for C this picks the
  // interrupt ts; for D/E it picks the assistant ts (user records are older
  // in those cases).
  const userNewer =
    userTs !== null &&
    (assistantTs === null || userTs.getTime() > assistantTs.getTime());
  const midTurn =
    assistantTs !== null && !isTerminalStopReason(latest.last_stop_reason);

  let working = false;
  if (userNewer && !latest.last_user_interrupted) {
    working = true; // case A
  } else if (midTurn && assistantTs) {
    const ageSec = (Date.now() - assistantTs.getTime()) / 1000;
    if (ageSec < TOOL_USE_GRACE_SEC) working = true; // case B
    // else fall through to countdown (case D)
  }

  if (working) {
    process.stdout.write(
      `${color(CYAN, "◉")} ${color(CYAN, "cache active")} ${dim("·")} agent working${modelTag}`,
    );
    return;
  }

  if (!assistantTs) {
    // No cache-bearing assistant record yet. Interrupt in a fresh session
    // lands here too (no cache to expire anyway).
    process.stdout.write(
      `${dim("◉ new session · cache not yet seeded")}${modelTag}`,
    );
    return;
  }

  // Countdown anchor: whichever of the two is more recent. For interrupts,
  // that's the user record; for terminal/blocked assistants, the assistant.
  const anchorMs = Math.max(
    assistantTs.getTime(),
    userTs?.getTime() ?? -Infinity,
  );
  const ttlSec = latest.is_1h_cache ? 3600 : 300;
  const ageSec = (Date.now() - anchorMs) / 1000;
  const remainingSec = ttlSec - ageSec;
  const mode = latest.is_1h_cache ? "1h" : "5m";

  if (remainingSec > 0) {
    const lowWater = ttlSec * 0.25;
    const tone = remainingSec > lowWater ? GREEN : YELLOW;
    process.stdout.write(
      `${color(tone, "◉")} ${color(tone, "cache warm")} ${dim("·")} ${mode} ${dim("·")} ${color(tone, fmtRemaining(remainingSec) + " left")}${modelTag}`,
    );
  } else {
    process.stdout.write(
      `${color(RED, "○")} ${color(RED, "cache cold")} ${dim("·")} ${fmtElapsed(-remainingSec)} past${modelTag} ${dim("·")} ${color(YELLOW, "/compress recommended")}`,
    );
  }
}
