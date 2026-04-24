import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";

import { encodeCwd } from "./paths.ts";
import { trimSession } from "./trimmer.ts";
import { estimateSessionTokens } from "./analyzer.ts";
import { estimateColdResumeCost, findModel, formatUSD, type ModelInfo } from "./pricing.ts";
import type { TrimMode, TrimOptions } from "./types.ts";

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    setTimeout(done, 750).unref?.();
  });
}

const VALID_MODES: TrimMode[] = ["lossless", "safe", "smart", "slim"];
// v0.16 removal: `archive` was dominated by `slim` on every axis. Map it
// to slim so users with old /compress habits don't silently fail.
const RENAMED: Record<string, TrimMode> = { archive: "slim" };

function parseCompressArgs(
  prompt: string,
): (TrimOptions & { force?: boolean }) | null {
  const m = prompt.trim().match(/^\/compress\b\s*(.*)$/);
  if (!m) return null;
  const allTokens = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const force = allTokens.includes("force") || allTokens.includes("--force");
  const tokens = allTokens.filter((t) => t !== "force" && t !== "--force");
  const modeTok = tokens[0] ?? "safe";

  const mode: TrimMode = (VALID_MODES as string[]).includes(modeTok)
    ? (modeTok as TrimMode)
    : (RENAMED[modeTok] ?? "safe");

  const opts: TrimOptions & { force?: boolean } = { mode };
  if (force) opts.force = true;
  if (mode === "safe" || mode === "slim")
    opts.keepLastN = Number(tokens[1]) || 5;
  opts.dropThinking = true;
  return opts;
}

function parseBreakArgs(prompt: string): { minutes: number } | null {
  const m = prompt.trim().match(/^\/break\b\s*(.*)$/);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  const minutes = rest ? Number(rest) : 15;
  if (!Number.isFinite(minutes) || minutes <= 0) return { minutes: 15 };
  return { minutes: Math.min(minutes, 240) }; // cap at 4h
}

/**
 * Normalize a path that Claude Code might pass in any of: Windows native
 * (`C:/Users/...`), bash/MSYS style (`/c/Users/...`), or a
 * backslash mix. Returns the first variant that actually exists on disk.
 */
function firstExisting(...paths: (string | undefined | null)[]): string | null {
  for (const p of paths) {
    if (!p) continue;
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

function msysToWin(p: string): string | null {
  // /c/Users/Keshav/... → C:/Users/Keshav/...
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1]!.toUpperCase()}:/${m[2]}` : null;
}

function winToMsys(p: string): string | null {
  // C:/Users/Keshav/... → /c/Users/Keshav/...
  const m = p.match(/^([a-zA-Z]):[\\/](.*)$/);
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}` : null;
}

function resolveSessionFile(input: HookInput): string | null {
  const tried: string[] = [];
  const tp = input.transcript_path;
  if (tp) {
    const found = firstExisting(tp, msysToWin(tp), winToMsys(tp));
    if (found) return found;
    tried.push(tp);
  }
  if (input.session_id && input.cwd) {
    const cwdVariants = [input.cwd, msysToWin(input.cwd), winToMsys(input.cwd)];
    for (const cwd of cwdVariants) {
      if (!cwd) continue;
      const path = join(
        homedir(),
        ".claude",
        "projects",
        encodeCwd(cwd),
        `${input.session_id}.jsonl`,
      );
      const found = firstExisting(path, msysToWin(path), winToMsys(path));
      if (found) return found;
      tried.push(path);
    }
  }
  // Emit a diagnostic log so the user can see what paths we tried.
  try {
    const logPath = join(homedir(), ".claude", "claudecompress", "hook-debug.log");
    writeFileSync(
      logPath,
      `resolveSessionFile failed at ${new Date().toISOString()}\n` +
        `input.transcript_path: ${tp}\n` +
        `input.cwd: ${input.cwd}\n` +
        `input.session_id: ${input.session_id}\n` +
        `tried:\n  ${tried.join("\n  ")}\n---\n`,
      { flag: "a" },
    );
  } catch {}
  return null;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function modeLabel(opts: TrimOptions): string {
  if (opts.mode === "safe" || opts.mode === "slim")
    return `${opts.mode} (last ${opts.keepLastN})`;
  if (opts.mode === "smart") return "smart (per-component)";
  return "lossless (squash only)";
}

interface CacheState {
  mode: "5m" | "1h";
  /** ms since epoch of the last cache-touching assistant turn, or null if none found */
  anchorMs: number | null;
  /** TTL seconds remaining at wall-clock now (negative = cold) */
  remainingSec: number | null;
}

/**
 * Tail-read the session JSONL and find the latest assistant record with
 * cache info. Returns mode + anchor timestamp so callers can decide if
 * the cache is likely still warm at wall-clock now.
 */
function detectCacheState(sessionPath: string): CacheState {
  const fallback: CacheState = { mode: "5m", anchorMs: null, remainingSec: null };
  try {
    const st = statSync(sessionPath);
    const size = st.size;
    let data: string;
    if (size > 2_000_000) {
      const fd = openSync(sessionPath, "r");
      const len = 500_000;
      const buf = Buffer.allocUnsafe(len);
      const pos = Math.max(0, size - len);
      readSync(fd, buf, 0, len, pos);
      closeSync(fd);
      data = buf.toString("utf8");
    } else {
      data = readFileSync(sessionPath, "utf8");
    }
    const lines = data.split("\n").reverse();
    for (const line of lines) {
      if (!line) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.type !== "assistant") continue;
      const usage = rec?.message?.usage;
      if (!usage) continue;
      const hits1h = (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0;
      const hits5m = (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0;
      const hitsLegacy = (usage.cache_creation_input_tokens ?? 0) > 0 || (usage.cache_read_input_tokens ?? 0) > 0;
      if (!hits1h && !hits5m && !hitsLegacy) continue;
      const mode: "5m" | "1h" = hits1h ? "1h" : "5m";
      const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
      const anchorMs = Number.isFinite(ts) ? ts : null;
      const ttlSec = mode === "1h" ? 3600 : 300;
      const remainingSec = anchorMs === null ? null : ttlSec - (Date.now() - anchorMs) / 1000;
      return { mode, anchorMs, remainingSec };
    }
  } catch {}
  return fallback;
}

function detectCacheMode(sessionPath: string): "5m" | "1h" {
  return detectCacheState(sessionPath).mode;
}

/**
 * Shape of the signal file ccw reads when auto-resuming.
 *
 * Historical format (v0.16 and earlier): a plain string containing the
 * trimmed-session hash. The hook would do the trim inline and hand ccw
 * the finished hash; ccw just respawned with `--resume <hash>`.
 *
 * Current format (v0.17+): JSON { v, session, opts }. The hook defers
 * the actual trim work to ccw — it writes a "please trim this next time
 * you respawn" request and exits. ccw reads the JSON, does the trim
 * after claude exits, and respawns with the new hash. This removes all
 * the parent-killing machinery the hook used to need on Windows, where
 * the kill path was fragile enough that Claude Code regularly saw the
 * hook's exit as a "non-blocking status code" instead of a clean block.
 *
 * ccw accepts both formats for backward compatibility.
 */
interface PendingTrimSignal {
  v: 1;
  session: string;
  opts: {
    mode: TrimMode;
    force?: boolean;
    keepLastN?: number;
    dropThinking?: boolean;
    legacyMode?: string;
    renamedFrom?: string;
  };
}

// ---------------------------------------------------------------------------
// /compress flow
// ---------------------------------------------------------------------------

async function runCompressHook(
  input: HookInput,
  opts: TrimOptions & { force?: boolean; legacyMode?: string; renamedFrom?: string },
): Promise<void> {
  const sessionFile = resolveSessionFile(input);
  if (!sessionFile) {
    process.stderr.write("[claudecompress] could not locate active session JSONL\n");
    process.exit(2);
  }

  // Refuse to /compress while the prompt cache is still warm.
  // /compress trims → forces --resume → rebuilds cache cold. That only
  // pays off once the cache has expired anyway. While warm, /compact is
  // the right tool: it shrinks the live context without killing the cache.
  if (!opts.force) {
    const cache = detectCacheState(sessionFile);
    if (cache.remainingSec !== null && cache.remainingSec > 0) {
      const mins = Math.floor(cache.remainingSec / 60);
      const secs = Math.floor(cache.remainingSec % 60);
      const remaining = mins > 0 ? `${mins}m${String(secs).padStart(2, "0")}s` : `${secs}s`;
      process.stderr.write(
        [
          "",
          "┌─ claudecompress ────────────────────────────────────────┐",
          `  cache:   ${cache.mode} TTL · ${remaining} remaining (still warm)`,
          "│",
          "  /compress forces a resume and rebuilds the cache cold.",
          "  While the cache is warm, /compact is cheaper:",
          "  it shrinks context in place, no rebuild needed.",
          "│",
          "  When cache is cold, /compress wins.  For now, either:",
          "    • /compact           (cheap now, lossy summary)",
          "    • keep working       (cache is warm, next message is fast)",
          "    • /compress force    (trim anyway — forces cold rebuild)",
          "└─────────────────────────────────────────────────────────┘",
          "",
        ].join("\n"),
      );
      process.exit(2);
    }
  }

  // Under ccw: defer the actual trim to ccw's respawn loop. Just write a
  // pending-trim request and exit 2 cleanly. ccw will do the trim work
  // after claude exits (ctrl+C) and respawn with the trimmed session.
  // This keeps the hook lean and avoids the Windows-fragile job of
  // killing Claude Code from inside its own child process.
  const signalFile = process.env.CCW_SIGNAL_FILE;
  if (signalFile) {
    try {
      const pending: PendingTrimSignal = {
        v: 1,
        session: sessionFile,
        opts: {
          mode: opts.mode,
          force: opts.force,
          keepLastN: opts.keepLastN,
          dropThinking: opts.dropThinking,
          legacyMode: opts.legacyMode,
          renamedFrom: opts.renamedFrom,
        },
      };
      mkdirSync(dirname(signalFile), { recursive: true });
      writeFileSync(signalFile, JSON.stringify(pending));

      const lines: string[] = [
        "",
        "┌─ claudecompress ────────────────────────────────────────┐",
      ];
      if (opts.legacyMode) {
        lines.push(`│ note     '${opts.legacyMode}' was removed → using safe instead`);
      }
      if (opts.renamedFrom) {
        lines.push(`│ note     '${opts.renamedFrom}' was renamed to '${opts.mode}' in v0.11`);
      }
      lines.push(
        `│ mode     ${modeLabel(opts)}${opts.dropThinking ? " · drop thinking" : ""}`,
        `│ session  ${basename(sessionFile, ".jsonl").slice(0, 8)}…`,
        `│`,
        `│ ccw will exit claude, compress this session, and`,
        `│ auto-resume with a rehydrate prompt. Cache resets cold.`,
        "└─────────────────────────────────────────────────────────┘",
        "",
      );
      process.stderr.write(lines.join("\n"));
      process.exit(2);
    } catch (err) {
      // Signal write failed — fall through and trim inline as best-effort.
      process.stderr.write(
        `[claudecompress] warning: couldn't write ccw signal (${String(err instanceof Error ? err.message : err)}); trimming inline\n`,
      );
    }
  }

  // Not under ccw (or signal write failed): do the trim here and tell
  // the user how to resume manually.
  try {
    const model = findModel("claude-opus-4-7")!;
    const beforeTokens = estimateSessionTokens(sessionFile, model);
    const beforeCost = estimateColdResumeCost(beforeTokens, model);

    const { path: outPath } = await trimSession(sessionFile, opts);
    const afterTokens = estimateSessionTokens(outPath, model);
    const afterCost = estimateColdResumeCost(afterTokens, model);
    const newHash = basename(outPath, ".jsonl");

    const savedTokens = Math.max(0, beforeTokens - afterTokens);
    const savedCost = Math.max(0, beforeCost - afterCost);

    const lines: string[] = [
      "",
      "┌─ claudecompress ────────────────────────────────────────┐",
    ];
    if (opts.legacyMode) {
      lines.push(`  note:   '${opts.legacyMode}' was removed → using safe instead`);
    }
    if (opts.renamedFrom) {
      lines.push(`  note:   '${opts.renamedFrom}' was renamed to '${opts.mode}' in v0.11`);
    }
    lines.push(
      `  mode:   ${modeLabel(opts)}${opts.dropThinking ? " · drop thinking (outside last-N window)" : ""}`,
      `  tokens: ${fmtTokens(beforeTokens)} → ${fmtTokens(afterTokens)}   (saved ≈ ${fmtTokens(savedTokens)})`,
      `  cold $ ${formatUSD(beforeCost)} → ${formatUSD(afterCost)}   (saved ≈ ${formatUSD(savedCost)})  [Opus 4.7]`,
      `  trimmed session: ${newHash}`,
      "└─────────────────────────────────────────────────────────┘",
      "",
      "  Exit this session (Ctrl+C twice) and run one of:",
      `    claude --resume ${newHash}`,
      `    claude --resume ${newHash} --dangerously-skip-permissions`,
      "",
    );
    process.stderr.write(lines.join("\n"));
    process.exit(2);
  } catch (err) {
    process.stderr.write(
      `[claudecompress] error: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// /break flow
// ---------------------------------------------------------------------------

function runBreakHook(input: HookInput, args: { minutes: number }): void {
  const sessionFile = resolveSessionFile(input);
  const cacheMode: "5m" | "1h" = sessionFile ? detectCacheMode(sessionFile) : "5m";

  const ttlSec = cacheMode === "1h" ? 3600 : 300;
  // Ping 30 seconds before expiry to leave safety margin for network + processing.
  const intervalSec = Math.max(30, ttlSec - 30);
  const breakSec = args.minutes * 60;

  const pingsNeeded = breakSec <= intervalSec ? 0 : Math.ceil(breakSec / intervalSec);

  const fmtInterval = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (sec === 0) return `${m}m`;
    return `${m}m${String(sec).padStart(2, "0")}s`;
  };

  const lines: string[] = [
    "",
    "┌─ claudecompress /break ─────────────────────────────────┐",
    `  break:      ${args.minutes} min`,
    `  cache:      ${cacheMode} TTL`,
  ];

  if (pingsNeeded === 0) {
    lines.push(
      `  pings:      0 (cache outlasts break)`,
      "└─────────────────────────────────────────────────────────┘",
      "",
      `  Your ${cacheMode} cache will survive a ${args.minutes}-minute break.`,
      `  Just step away; cache stays warm on return.`,
      "",
    );
  } else {
    // Rough cost: each ping = cache read on ~session tokens.
    // Without the session here we can only give a ballpark formula.
    let costNote = "";
    if (sessionFile) {
      try {
        const model = findModel("claude-opus-4-7")!;
        const tokens = estimateSessionTokens(sessionFile, model);
        const readRate = pickCacheReadRate(model, tokens);
        const perPing = (tokens / 1_000_000) * readRate;
        const total = perPing * pingsNeeded;
        costNote = `  cost/ping:  ${formatUSD(perPing)}  (cache read · ${fmtTokens(tokens)} tokens)`;
        lines.push(
          `  pings:      ~${pingsNeeded} (every ${fmtInterval(intervalSec)})`,
          costNote,
          `  total:      ~${formatUSD(total)}`,
          "└─────────────────────────────────────────────────────────┘",
          "",
        );
      } catch {
        lines.push(
          `  pings:      ~${pingsNeeded} (every ${fmtInterval(intervalSec)})`,
          "└─────────────────────────────────────────────────────────┘",
          "",
        );
      }
    } else {
      lines.push(
        `  pings:      ~${pingsNeeded} (every ${fmtInterval(intervalSec)})`,
        "└─────────────────────────────────────────────────────────┘",
        "",
      );
    }
    lines.push(
      `  To hold the cache warm during your break, run:`,
      `    /loop ${fmtInterval(intervalSec)} .`,
      `  Ctrl+C the loop when you're back.`,
      "",
    );
  }

  process.stderr.write(lines.join("\n"));
  process.exit(2); // block the /break prompt itself; it's informational only
}

function pickCacheReadRate(model: ModelInfo, _tokens: number): number {
  // Opus 4.5+ bills the full 1M context at flat per-token rates, so
  // cache-read cost scales linearly with session size.
  return model.cachedInputPerMillion;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function runHook(): Promise<void> {
  const logPath = join(homedir(), ".claude", "claudecompress", "hook-debug.log");
  try {
    const raw = await readStdin();
    // Debug log: capture exactly what Claude Code sends so we can diagnose
    // session-resolution issues on Windows (bash-style vs native paths, etc.).
    // Appends so history survives across turns; rotates at ~256KB.
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      try {
        if (statSync(logPath).size > 256 * 1024) writeFileSync(logPath, "");
      } catch {}
      writeFileSync(
        logPath,
        `${new Date().toISOString()}\n${raw}\n---\n`,
        { flag: "a" },
      );
    } catch {}

    let input: HookInput = {};
    try {
      input = JSON.parse(raw);
    } catch {
      process.exit(0);
    }

    const prompt = input.prompt ?? "";

    const compressOpts = parseCompressArgs(prompt);
    if (compressOpts) {
      await runCompressHook(input, compressOpts);
      return;
    }

    const breakArgs = parseBreakArgs(prompt);
    if (breakArgs) {
      runBreakHook(input, breakArgs);
      return;
    }

    process.exit(0); // unknown prompt — allow through
  } catch (err) {
    // Top-level safety net — surfaces any crash as stderr + exit 2 so the
    // user sees WHY the hook failed instead of a silent "non-blocking
    // status code" from Claude Code. Also persist to the debug log so the
    // error survives past Claude Code's UI, which may swallow stderr.
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    process.stderr.write(`[claudecompress] hook crashed:\n${msg}\n`);
    try {
      writeFileSync(
        logPath,
        `CRASH ${new Date().toISOString()}\n${msg}\n---\n`,
        { flag: "a" },
      );
    } catch {}
    process.exit(2);
  }
}
