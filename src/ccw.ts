#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  statSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { trimSession } from "./trimmer.ts";
import { tokensFor } from "./tokenCounter.ts";
import { findModel, estimateColdResumeCost } from "./pricing.ts";
import { recordTrim } from "./history.ts";
import { detectCacheState } from "./hook.ts";
import { logError, logEvent } from "./errorLog.ts";
import type { TrimMode, TrimOptions, TrimResult } from "./types.ts";

/**
 * Shape of the signal file produced by the /compress hook when running
 * under ccw (v0.17+). The hook defers the actual trim work to ccw so it
 * doesn't have to kill claude from inside a child process — a dance that
 * was fragile on Windows. ccw reads this after claude exits, runs the
 * trim, then respawns with --resume.
 */
interface PendingTrimSignal {
  v: 1;
  session: string;
  opts: TrimOptions & { force?: boolean; legacyMode?: string; renamedFrom?: string };
}

// One signal file PER ccw INSTANCE. Earlier versions used a single fixed
// path shared by every running ccw — when one session's /compress hook
// wrote it, EVERY ccw watcher saw the mtime change and killed its own
// claude, closing all of the user's parallel sessions at once. Keying on
// pid scopes the compress→respawn dance to the terminal that asked for it.
const SIGNAL_DIR = join(homedir(), ".claude", "claudecompress");
const SIGNAL_FILE = join(SIGNAL_DIR, `next-resume-${process.pid}`);

function ensureDir(): void {
  try {
    mkdirSync(SIGNAL_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

/**
 * Remove leftover signal files from previous ccw runs: the legacy fixed
 * "next-resume" path and any pid-suffixed sibling older than a day (its
 * ccw is long gone; pids recycle, so a stale file could otherwise trigger
 * a phantom kill in a future run that reuses the pid).
 */
function cleanupStaleSignals(): void {
  try {
    for (const f of readdirSync(SIGNAL_DIR)) {
      if (!f.startsWith("next-resume")) continue;
      const p = join(SIGNAL_DIR, f);
      if (p === SIGNAL_FILE) continue;
      try {
        const st = statSync(p);
        const isLegacy = f === "next-resume";
        if (isLegacy || Date.now() - st.mtimeMs > 24 * 3600 * 1000) unlinkSync(p);
      } catch {
        // ignore per-file races
      }
    }
  } catch {
    // dir may not exist yet
  }
}

function clearSignal(): void {
  try {
    unlinkSync(SIGNAL_FILE);
  } catch {
    // ignore
  }
}

function readSignal(): string | null {
  if (!existsSync(SIGNAL_FILE)) return null;
  try {
    const s = readFileSync(SIGNAL_FILE, "utf8").trim();
    unlinkSync(SIGNAL_FILE);
    return s || null;
  } catch {
    return null;
  }
}

function resolveClaudeCmd(): string {
  const custom = process.env.CCW_CLAUDE_CMD?.trim();
  return custom && custom.length > 0 ? custom : "claude";
}

/**
 * Kill the entire process tree rooted at `pid`. On Windows we use
 * taskkill /T because child.kill() only terminates the direct child
 * and leaves claude's sub-processes (hooks, shells, MCP servers) as
 * orphans. On Unix we spawn claude in a new process group via
 * `detached: true` so we can signal the whole group with a negative
 * pid — that catches claude plus every shell/subprocess it forked.
 * Falls back to a direct kill if the group signal fails (e.g. the
 * group leader already exited).
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } catch (err) {
      logError("ccw.killTree", err, { pid });
    }
    return;
  }
  try {
    // Negative pid = signal the entire process group. Works only if the
    // child was spawned with detached:true so it became a group leader.
    process.kill(-pid, "SIGTERM");
    return;
  } catch (err) {
    // Group kill can fail if the child exited before we got here or if
    // detached:true wasn't honored. Fall through to direct pid kill.
    logError("ccw.killTree.group", err, { pid });
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    logError("ccw.killTree.fallback", err, { pid });
  }
}

function runClaude(args: string[]): Promise<number> {
  const cmd = resolveClaudeCmd();
  return new Promise((resolve) => {
    const startMs = Date.now();
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        CCW_SIGNAL_FILE: SIGNAL_FILE,
        CCW_ACTIVE: "1",
      },
      shell: process.platform === "win32" || cmd !== "claude",
      // On Unix, put the child in its own process group so killTree can
      // signal the whole tree (claude + hook shells + MCP subprocesses)
      // via process.kill(-pid). Windows has taskkill /T so detach isn't
      // needed — and detaching there changes console semantics in ways
      // that break stdio inheritance.
      detached: process.platform !== "win32",
    });

    // When ccw itself receives a terminate signal (user hits Ctrl+C on
    // the wrapper, or the OS sends SIGTERM), forward it to the whole
    // child group instead of dying silently and leaving claude running.
    // With detached:true the child group no longer shares our signal
    // handling by default, so we do it explicitly.
    const forwardSignal = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          // Windows doesn't have process groups; direct kill is best we can do.
          child.kill(sig);
        } else {
          process.kill(-child.pid, sig);
        }
      } catch {
        // child already gone
      }
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    // Watch the signal file in parallel with the child process.
    // When the /compress hook writes a signal, we kill claude from
    // OUT HERE (parent → child, rock-solid on every OS) instead of
    // asking the hook to suicide its own parent (a mess on Windows).
    // A short grace period lets the hook finish flushing its banner
    // to the user before we pull claude down.
    let armed = true;
    const watcher = setInterval(() => {
      if (!armed || !child.pid) return;
      try {
        const st = statSync(SIGNAL_FILE);
        // Only react to a signal written AFTER this claude spawn —
        // old/stale files from a previous run get ignored.
        if (st.mtimeMs >= startMs) {
          armed = false;
          clearInterval(watcher);
          setTimeout(() => {
            if (child.exitCode === null && child.pid) killTree(child.pid);
          }, 400);
        }
      } catch {
        // file doesn't exist yet → no signal → keep watching
      }
    }, 200);

    child.on("exit", (code) => {
      armed = false;
      clearInterval(watcher);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve(code ?? 0);
    });
    child.on("error", (err) => {
      armed = false;
      clearInterval(watcher);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      logError("ccw.runClaude", err, { cmd, args });
      process.stderr.write(
        `[ccw] failed to spawn ${cmd}: ${err.message}\n` +
          `      is ${cmd === "claude" ? "the Claude Code CLI" : `\`${cmd}\``} on your PATH?\n` +
          (cmd === "claude"
            ? "      (tip: set CCW_CLAUDE_CMD if you launch Claude Code via a wrapper or alias)\n"
            : ""),
      );
      resolve(1);
    });
  });
}

/**
 * Preserve the user's original flags across auto-resume, but:
 *  - strip any existing --resume / -r / --resume=<id>
 *  - strip positional args (we don't want to replay an initial prompt)
 *  - append --resume <hash>
 *
 * We can't know which flags take a value (claude's CLI schema isn't public),
 * so we keep the flag and — if the very next arg doesn't itself start with `-`
 * — assume it's that flag's value and keep it too. This is correct for the
 * common flags (`--model <id>`, `--cwd <path>`, etc.) and only misfires if the
 * user mixed a boolean flag immediately before a positional arg.
 */
function mergeResumeArgs(original: string[], hash: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < original.length; i += 1) {
    const a = original[i]!;
    if (a === "--resume" || a === "-r") {
      i += 1; // also skip its value
      continue;
    }
    if (a.startsWith("--resume=")) continue;
    if (a.startsWith("-")) {
      out.push(a);
      if (!a.includes("=")) {
        const next = original[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          out.push(next);
          i += 1;
        }
      }
    }
    // drop bare positional args (initial prompts) — they shouldn't replay
  }
  out.push("--resume", hash);
  return out;
}

/**
 * Parse the signal file contents. v0.17+ writes a JSON pending-trim
 * request; older hooks wrote a plain hash. Accept both for backward
 * compatibility with mismatched hook/ccw installs.
 */
function parseSignal(raw: string): PendingTrimSignal | string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.v === 1 && typeof parsed.session === "string" && parsed.opts) {
        return parsed as PendingTrimSignal;
      }
    } catch {
      // fall through: treat as plain string
    }
  }
  return trimmed;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${(n / 1_000_000).toFixed(2)}M tok`;
}

/**
 * Append a synthetic user turn to the trimmed JSONL so that on resume, claude
 * sees a fresh prompt describing what just happened and produces one assistant
 * response — which rehydrates the freshly-compressed session. We clone metadata
 * (cwd, version, userType, permissionMode…) from the last user record found in
 * the file so the new entry blends in with the rest of the transcript.
 */
/**
 * Zero out cache-related usage fields on the last assistant record in the
 * trimmed JSONL. Claude Code's status line reads these to decide whether to
 * show "cache active" — after a trim, the server-side cache keyed on the
 * original content is stale, so those fields are a lie. Resetting them lets
 * the UI reflect reality (cold cache) until the next real API call.
 */
function scrubLastAssistantCacheUsage(outPath: string): void {
  try {
    const data = readFileSync(outPath, "utf8");
    const lines = data.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.type !== "assistant" || !rec?.message?.usage) continue;
      const u = rec.message.usage;
      u.cache_creation_input_tokens = 0;
      u.cache_read_input_tokens = 0;
      if (u.cache_creation && typeof u.cache_creation === "object") {
        u.cache_creation.ephemeral_5m_input_tokens = 0;
        u.cache_creation.ephemeral_1h_input_tokens = 0;
      }
      lines[i] = JSON.stringify(rec);
      writeFileSync(outPath, lines.join("\n"), "utf8");
      return;
    }
  } catch (err) {
    // Non-fatal: status line will just lie until first real request.
    logError("ccw.scrubLastAssistantCacheUsage", err, { outPath });
  }
}

function appendRehydrateTurn(
  outPath: string,
  stats: TrimResult,
  opts: TrimOptions,
  tokensBefore: number,
  tokensAfter: number,
  tokenReductionPct: number,
  approx: boolean,
  apiBefore: number,
  apiAfter: number,
): void {
  const data = readFileSync(outPath, "utf8");
  const lines = data.split("\n").filter(Boolean);
  if (lines.length === 0) return;

  // Find the last record (for parent UUID) and the last user record
  // (for metadata template).
  let lastRec: any = null;
  let lastUserTemplate: any = null;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      lastRec = rec;
      if (rec?.type === "user" && rec?.message?.role === "user") {
        lastUserTemplate = rec;
      }
    } catch {
      // skip bad lines
    }
  }
  if (!lastRec || !lastUserTemplate) return;

  const pct = tokenReductionPct.toFixed(1);
  const apiPct = apiBefore === 0 ? "0.0" : (((apiBefore - apiAfter) / apiBefore) * 100).toFixed(1);
  const apiTag = approx ? " (est)" : "";
  const modeStr = `${opts.mode}${opts.dropThinking ? " · drop thinking" : ""}`;

  const content =
    `<ccw-compressed>\n` +
    `Session auto-compressed by claudecompress. Earlier tool outputs and ` +
    `assistant replies were trimmed; user turns are intact.\n` +
    `\n` +
    `  /context   ${formatTokens(tokensBefore).padStart(9)}  →  ${formatTokens(tokensAfter).padStart(9)}   (${pct}% smaller)\n` +
    `  api cost   ${formatTokens(apiBefore).padStart(9)}  →  ${formatTokens(apiAfter).padStart(9)}   (${apiPct}% smaller)${apiTag}\n` +
    `  messages   ${String(stats.originalLines).padStart(9)}  →  ${String(stats.trimmedLines).padStart(9)}\n` +
    `  mode       ${modeStr}\n` +
    `\n` +
    `Cache is COLD — this reply rebuilds it. Please acknowledge briefly ` +
    `(no tool calls) and I'll resume normal work on the next turn.\n` +
    `</ccw-compressed>`;

  const newRec: Record<string, unknown> = {
    parentUuid: lastRec.uuid ?? null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType: "external",
    sessionId: stats.newSessionId,
  };
  // Copy over fields that Claude Code expects but that don't vary turn-to-turn.
  for (const k of ["cwd", "version", "gitBranch", "entrypoint", "permissionMode"] as const) {
    if (lastUserTemplate[k] !== undefined) newRec[k] = lastUserTemplate[k];
  }

  appendFileSync(outPath, JSON.stringify(newRec) + "\n", "utf8");
}

function printCompressBanner(
  stats: TrimResult,
  opts: TrimOptions,
  shortOrig: string,
  tokensBefore: number,
  tokensAfter: number,
  tokenReductionPct: number,
  approx: boolean,
  apiBefore: number,
  apiAfter: number,
): void {
  const pct = tokenReductionPct.toFixed(1);
  const apiPct = apiBefore === 0 ? "0.0" : (((apiBefore - apiAfter) / apiBefore) * 100).toFixed(1);
  const short = (sid: string) => sid.slice(0, 8);
  const bar = "─".repeat(58);
  const apiLabel = approx ? " (est)" : "";
  const out = [
    "",
    `┌─ ccw compress ${bar.slice(0, 43)}┐`,
    `  ✓ /context   ${formatTokens(tokensBefore)} → ${formatTokens(tokensAfter)}  (${pct}% smaller)`,
    `    api cost   ${formatTokens(apiBefore)} → ${formatTokens(apiAfter)}  (${apiPct}% smaller)${apiLabel}`,
    `  messages     ${stats.originalLines} → ${stats.trimmedLines}`,
    `  mode         ${opts.mode}${opts.dropThinking ? " · drop thinking" : ""}`,
    `  session      ${shortOrig}… → ${short(stats.newSessionId)}…`,
    `  cache        ⚠  COLD — /context may still show stale "active"; send a message to rehydrate`,
    `└${"─".repeat(59)}┘`,
    "",
  ];
  process.stdout.write(out.join("\n"));
}

async function performPendingTrim(sig: PendingTrimSignal): Promise<string | null> {
  const shortOrig = basename(sig.session, ".jsonl").slice(0, 8);
  logEvent("ccw.performPendingTrim", "compress start", {
    session: sig.session,
    shortOrig,
    mode: sig.opts.mode,
    keepLastN: sig.opts.keepLastN,
    dropThinking: sig.opts.dropThinking,
    force: sig.opts.force,
  });
  process.stdout.write(`\n[ccw] compressing ${shortOrig}… (mode: ${sig.opts.mode})\n`);
  try {
    const tb = await tokensFor(sig.session);
    const result = await trimSession(sig.session, sig.opts);
    const ta = await tokensFor(result.path);
    const tokensBefore = tb.contextLike;
    const tokensAfter = ta.contextLike;
    const apiBefore = tb.apiCost;
    const apiAfter = ta.apiCost;
    const approx = tb.approx || ta.approx;
    const tokenReductionPct = tokensBefore === 0
      ? 0
      : Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 1000) / 10;
    try {
      scrubLastAssistantCacheUsage(result.path);
    } catch (err) {
      // Non-fatal — proceed with rehydrate turn.
      logError("ccw.performPendingTrim.scrub", err, { path: result.path });
    }
    try {
      appendRehydrateTurn(result.path, result, sig.opts, tokensBefore, tokensAfter, tokenReductionPct, approx, apiBefore, apiAfter);
    } catch (err) {
      // Non-fatal — the trimmed session still resumes fine without
      // auto-rehydration; the user just has to type the first message.
      logError("ccw.performPendingTrim.rehydrate", err, {
        path: result.path,
        newSessionId: result.newSessionId,
      });
      process.stderr.write(
        `[ccw] note: could not append rehydrate turn (${String(err instanceof Error ? err.message : err)})\n`,
      );
    }
    printCompressBanner(result, sig.opts, shortOrig, tokensBefore, tokensAfter, tokenReductionPct, approx, apiBefore, apiAfter);
    // Log to the lifetime-savings history (previously only interactive-CLI
    // trims were recorded, so /compress-driven savings never showed up in
    // `claudecompress history`). Priced against the session's detected
    // model and cache mode.
    try {
      const model = findModel(tb.model);
      const cacheMode = detectCacheState(sig.session).mode;
      recordTrim({
        timestamp: new Date().toISOString(),
        mode: sig.opts.mode,
        model: model.id,
        sourcePath: sig.session,
        outputPath: result.path,
        bytesBefore: result.originalBytes,
        bytesAfter: result.trimmedBytes,
        tokensBefore: apiBefore,
        tokensAfter: apiAfter,
        costBefore: estimateColdResumeCost(apiBefore, model, cacheMode),
        costAfter: estimateColdResumeCost(apiAfter, model, cacheMode),
      });
    } catch (err) {
      logError("ccw.performPendingTrim.recordTrim", err);
    }
    logEvent("ccw.performPendingTrim", "compress success", {
      originalLines: result.originalLines,
      trimmedLines: result.trimmedLines,
      tokensBefore,
      tokensAfter,
      apiBefore,
      apiAfter,
      newSessionId: result.newSessionId,
    });
    return result.newSessionId;
  } catch (err) {
    logError("ccw.performPendingTrim", err, {
      session: sig.session,
      mode: sig.opts.mode,
    });
    process.stderr.write(
      `[ccw] compress failed: ${String(err instanceof Error ? err.message : err)}\n` +
        `[ccw] resuming ORIGINAL (uncompressed) session instead\n`,
    );
    // Fall back to the original session's hash so the user doesn't
    // lose their conversation when the trim errors.
    return basename(sig.session, ".jsonl");
  }
}

/**
 * Expand ccw-level shortcuts into real claude flags before we hand args off
 * to claude. Shortcuts are always rewritten in place so --resume merging and
 * later respawns carry them forward unchanged.
 *
 *   --dsp  →  --dangerously-skip-permissions
 */
function expandShortcuts(args: string[]): string[] {
  return args.map((a) => (a === "--dsp" ? "--dangerously-skip-permissions" : a));
}

async function main(): Promise<void> {
  ensureDir();
  cleanupStaleSignals();
  clearSignal();
  const originalArgs = expandShortcuts(process.argv.slice(2));
  logEvent("ccw.main", "ccw started", { argv: originalArgs });
  let args = originalArgs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const code = await runClaude(args);
    const raw = readSignal();
    if (!raw) process.exit(code);

    const sig = parseSignal(raw);
    let hash: string | null;
    if (typeof sig === "string") {
      // Legacy plain-hash signal (pre-v0.17 hook).
      hash = sig;
    } else {
      hash = await performPendingTrim(sig);
    }
    if (!hash) process.exit(code);

    logEvent("ccw.main", "resume", { hash });
    process.stdout.write(
      `[ccw] resuming compressed session ${hash}\n` +
      `[ccw] cache is COLD — send any message to rehydrate (the /context cache indicator will lie until you do)\n\n`,
    );
    args = mergeResumeArgs(originalArgs, hash);
  }
}

main().catch((err) => {
  logError("ccw.main", err);
  process.stderr.write(
    `[ccw] ${String(err instanceof Error ? err.message : err)}\n`,
  );
  process.exit(1);
});
