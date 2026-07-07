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
  copyFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";

import { encodeCwd, humanBytes, projectDirForCwd } from "./paths.ts";
import { summarizeHistory, readHistory } from "./history.ts";
import { probeSession } from "./probes.ts";
import { resolveDiffTarget, writeDiffReport, openInBrowser } from "./diffview.ts";
import { planGc } from "./gc.ts";
import { analyzeProject } from "./analyzeCmd.ts";
import { trimSession } from "./trimmer.ts";
import { detectSessionModel } from "./analyzer.ts";
import { tokensFor, roughContextTokens } from "./tokenCounter.ts";
import { recordTrim } from "./history.ts";
import { estimateColdResumeCost, findModel, formatUSD, type ModelInfo } from "./pricing.ts";
import { logError, logEvent } from "./errorLog.ts";
import { readStdin } from "./stdin.ts";
import { renderCacheLine } from "./statusline.ts";
import type { TrimMode, TrimOptions } from "./types.ts";

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
  /** PreCompact only: what initiated the compaction. */
  trigger?: "manual" | "auto";
  /** PreCompact only: user-supplied /compact instructions (unused here). */
  custom_instructions?: string;
}


const VALID_MODES: TrimMode[] = ["lossless", "safe", "smart", "slim"];

// Legacy mode aliases that still resolve to a current mode. When a user
// passes one of these, we preserve their intent and surface a note in
// the banner so they know to migrate. Split by rename vs removed so the
// banner can use accurate wording.
//
// v0.11 rename wave: recency→safe, distill→smart, focus→slim
// v0.16 rename:     archive→slim (archive's behavior was dominated by
//                   slim on every axis we measured)
const RENAMED_MODES: Record<string, TrimMode> = {
  recency: "safe",
  distill: "smart",
  focus: "slim",
  archive: "slim",
};
// v0.10 fully-removed mode names — no direct equivalent, fall back to safe.
const REMOVED_MODES = new Set(["redact", "truncate", "sift"]);

// Exported so tests can verify the legacy-mode mapping without having
// to drive the full hook pipeline.
export function parseCompressArgs(
  prompt: string,
): (TrimOptions & { force?: boolean; legacyMode?: string; renamedFrom?: string }) | null {
  const m = prompt.trim().match(/^\/compress\b\s*(.*)$/);
  if (!m) return null;
  const allTokens = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const force = allTokens.includes("force") || allTokens.includes("--force");
  const tokens = allTokens.filter((t) => t !== "force" && t !== "--force");
  const modeTok = tokens[0] ?? "safe";

  let mode: TrimMode;
  let renamedFrom: string | undefined;
  let legacyMode: string | undefined;

  if ((VALID_MODES as string[]).includes(modeTok)) {
    mode = modeTok as TrimMode;
  } else if (RENAMED_MODES[modeTok] !== undefined) {
    mode = RENAMED_MODES[modeTok]!;
    renamedFrom = modeTok;
  } else if (REMOVED_MODES.has(modeTok)) {
    mode = "safe";
    legacyMode = modeTok;
  } else {
    // Unknown token — default to safe but flag so the banner can show
    // the user their input wasn't recognized.
    mode = "safe";
    if (modeTok !== "safe") legacyMode = modeTok;
  }

  const opts: TrimOptions & { force?: boolean; legacyMode?: string; renamedFrom?: string } = { mode };
  if (force) opts.force = true;
  if (renamedFrom) opts.renamedFrom = renamedFrom;
  if (legacyMode) opts.legacyMode = legacyMode;
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

export function parseTtlArgs(prompt: string): {} | null {
  const m = prompt.trim().match(/^\/ttl\b/);
  return m ? {} : null;
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
  logError("hook.resolveSessionFile", new Error("session file not found"), {
    transcript_path: tp,
    cwd: input.cwd,
    session_id: input.session_id,
    tried,
  });
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
  } catch (err) {
    logError("hook.resolveSessionFile.writeDebug", err);
  }
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
 * Scan the session JSONL backwards for the latest assistant record with
 * cache-usage info. Returns mode + anchor timestamp so callers can
 * decide if the cache is likely still warm at wall-clock now.
 *
 * The scan starts from the tail and expands the window progressively if
 * it comes up empty. An earlier version of this function stopped at a
 * fixed 500KB tail, which silently returned `remainingSec: null` (→ the
 * warm-cache guard treated it as cold) for any session where the last
 * cache-bearing assistant was further back. On sessions with many
 * consecutive tool_result records that's surprisingly easy to hit.
 *
 * Exported so tests can verify detection on crafted JSONL fixtures.
 */
export function detectCacheState(sessionPath: string): CacheState {
  const fallback: CacheState = { mode: "5m", anchorMs: null, remainingSec: null };
  const scanLines = (lines: string[]): CacheState | null => {
    // Walk newest-first so the first hit is the most recent cache record.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
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
    return null;
  };
  try {
    const st = statSync(sessionPath);
    const size = st.size;
    // Small files: one read, done.
    if (size <= 4_000_000) {
      const lines = readFileSync(sessionPath, "utf8").split("\n");
      return scanLines(lines) ?? fallback;
    }
    // Large files: progressively expand the tail window. Doubling strategy
    // bounds total bytes read at ~2× the position where we find the hit,
    // and worst case reads the whole file once.
    const fd = openSync(sessionPath, "r");
    try {
      let len = 500_000;
      while (len < size * 2) {
        const readLen = Math.min(len, size);
        const pos = Math.max(0, size - readLen);
        const buf = Buffer.allocUnsafe(readLen);
        readSync(fd, buf, 0, readLen, pos);
        const data = buf.toString("utf8");
        // Unless we started at position 0, the first line is likely a
        // fragment from a larger record — drop it to avoid parse noise.
        const lines = data.split("\n");
        if (pos > 0) lines.shift();
        const hit = scanLines(lines);
        if (hit) return hit;
        if (pos === 0) break; // already read the whole file
        len *= 4; // aggressive growth so we bail to full-file fast
      }
    } finally {
      closeSync(fd);
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

/**
 * Detects which Claude Code surface the hook is running under, so the
 * compress banner can give resume instructions that actually apply.
 *
 * Reads the unofficial `CLAUDE_CODE_ENTRYPOINT` env var. It isn't part of
 * any documented API and could change or disappear in a future release, so
 * any value we don't recognize (including it being unset) falls back to
 * "cli" — the terminal is the only surface where the plain `claude --resume`
 * instructions are guaranteed to be correct, and it's also the original/most
 * common surface this hook was written for.
 */
export function detectSurface(): "cli" | "vscode" | "desktop" {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint === "claude-vscode") return "vscode";
  if (entrypoint === "claude-desktop") return "desktop";
  return "cli";
}

async function runCompressHook(
  input: HookInput,
  opts: TrimOptions & { force?: boolean; legacyMode?: string; renamedFrom?: string },
): Promise<void> {
  logEvent("hook.runCompressHook", "compress hook invoked", {
    mode: opts.mode,
    keepLastN: opts.keepLastN,
    dropThinking: opts.dropThinking,
    force: opts.force,
    under_ccw: Boolean(process.env.CCW_SIGNAL_FILE),
  });
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
        lines.push(`│ note     '${opts.legacyMode}' is not a mode I know → using safe`);
      }
      if (opts.renamedFrom) {
        lines.push(`│ note     '${opts.renamedFrom}' was renamed to '${opts.mode}'`);
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
      logError("hook.runCompressHook.signalWrite", err, { signalFile, sessionFile });
      process.stderr.write(
        `[claudecompress] warning: couldn't write ccw signal (${String(err instanceof Error ? err.message : err)}); trimming inline\n`,
      );
    }
  }

  // Not under ccw (or signal write failed): do the trim here and tell
  // the user how to resume manually.
  try {
    // Same accurate path ccw uses: /context-calibrated heuristic for the
    // headline, real count_tokens for cost, model detected from the JSONL.
    // The old char-based estimator here disagreed with /context by 2-3x
    // on tool-heavy sessions.
    const tb = await tokensFor(sessionFile);
    const trimResult = await trimSession(sessionFile, opts);
    const outPath = trimResult.path;
    const ta = await tokensFor(outPath);
    const model = findModel(tb.model);
    const cacheMode = detectCacheState(sessionFile).mode;
    const beforeCost = estimateColdResumeCost(tb.apiCost, model, cacheMode);
    const afterCost = estimateColdResumeCost(ta.apiCost, model, cacheMode);
    const newHash = basename(outPath, ".jsonl");

    const savedTokens = Math.max(0, tb.apiCost - ta.apiCost);
    const savedCost = Math.max(0, beforeCost - afterCost);
    const approxTag = tb.approx || ta.approx ? " (est)" : "";

    try {
      recordTrim({
        timestamp: new Date().toISOString(),
        mode: opts.mode,
        model: model.id,
        sourcePath: sessionFile,
        outputPath: outPath,
        bytesBefore: trimResult.originalBytes,
        bytesAfter: trimResult.trimmedBytes,
        tokensBefore: tb.apiCost,
        tokensAfter: ta.apiCost,
        costBefore: beforeCost,
        costAfter: afterCost,
      });
    } catch (err) {
      logError("hook.runCompressHook.recordTrim", err);
    }

    const lines: string[] = [
      "",
      "┌─ claudecompress ────────────────────────────────────────┐",
    ];
    if (opts.legacyMode) {
      lines.push(`  note:   '${opts.legacyMode}' is not a mode I know → using safe`);
    }
    if (opts.renamedFrom) {
      lines.push(`  note:   '${opts.renamedFrom}' was renamed to '${opts.mode}'`);
    }
    lines.push(
      `  mode:    ${modeLabel(opts)}${opts.dropThinking ? " · drop thinking (outside last-N window)" : ""}`,
      `  context: ${fmtTokens(tb.contextLike)} → ${fmtTokens(ta.contextLike)}   (matches /context)`,
      `  tokens:  ${fmtTokens(tb.apiCost)} → ${fmtTokens(ta.apiCost)}   (saved ≈ ${fmtTokens(savedTokens)})${approxTag}`,
      `  cold $  ${formatUSD(beforeCost)} → ${formatUSD(afterCost)}   (saved ≈ ${formatUSD(savedCost)})  [${model.label} · ${cacheMode} cache]`,
      `  trimmed session: ${newHash}`,
      "└─────────────────────────────────────────────────────────┘",
      "",
    );
    const surface = detectSurface();
    if (surface === "vscode") {
      lines.push(
        "  Open a terminal and run:  claude --resume " + newHash,
        "  (or pick the trimmed session from the extension's session list)",
        "",
      );
    } else if (surface === "desktop") {
      lines.push(
        "  The desktop app can't resume trimmed sessions from its sidebar.",
        "  Open a terminal and run:  claude --resume " + newHash,
        "",
      );
    } else {
      lines.push(
        "  Exit this session (Ctrl+C twice) and run one of:",
        `    claude --resume ${newHash}`,
        `    claude --resume ${newHash} --dangerously-skip-permissions`,
        "",
      );
    }
    process.stderr.write(lines.join("\n"));
    process.exit(2);
  } catch (err) {
    logError("hook.runCompressHook.inlineTrim", err, { sessionFile, mode: opts.mode });
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
        const model = findModel(detectSessionModel(sessionFile) ?? "claude-opus-4-8");
        const tokens = roughContextTokens(sessionFile);
        const readRate = pickCacheReadRate(model);
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

function pickCacheReadRate(model: ModelInfo): number {
  // Opus 4.5+ bills the full 1M context at flat per-token rates, so
  // cache-read cost scales linearly with session size.
  return model.cachedInputPerMillion;
}

// ---------------------------------------------------------------------------
// /ttl flow
// ---------------------------------------------------------------------------

function runTtlHook(input: HookInput): void {
  logEvent("hook.runTtlHook", "ttl hook invoked", {
    under_ccw: Boolean(process.env.CCW_SIGNAL_FILE),
  });
  const sessionFile = resolveSessionFile(input);
  if (!sessionFile) {
    process.stderr.write("[claudecompress] could not locate active session JSONL\n");
    process.exit(2);
  }
  const line = renderCacheLine(sessionFile, input.session_id ?? "");
  process.stderr.write("\n" + line + "\n\n");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// PreCompact flow — snapshot the transcript before Claude Code's native
// summarizer replaces earlier history, so nothing is ever lost to /compact.
// ---------------------------------------------------------------------------

const ARCHIVE_MAX_FILES = 40;
const ARCHIVE_MAX_BYTES = 500 * 1024 * 1024; // ~500 MB

function defaultArchiveDir(): string {
  return join(homedir(), ".claude", "claudecompress", "archives");
}

function archiveStamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/**
 * Prune `dir` down to at most `maxFiles` archives and `maxBytes` total,
 * deleting oldest-mtime first. Only *.jsonl regular files inside `dir`
 * itself are ever considered — nothing outside the dir is touched.
 * Returns the paths that were deleted. Exported for tests.
 */
export function pruneArchives(
  dir: string,
  maxFiles: number = ARCHIVE_MAX_FILES,
  maxBytes: number = ARCHIVE_MAX_BYTES,
): string[] {
  const deleted: string[] = [];
  let entries: { path: string; mtimeMs: number; size: number }[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        entries.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }
  } catch {
    return deleted; // dir unreadable/missing — nothing to prune
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let count = entries.length;
  let total = entries.reduce((s, e) => s + e.size, 0);
  for (const e of entries) {
    if (count <= maxFiles && total <= maxBytes) break;
    try {
      unlinkSync(e.path);
      deleted.push(e.path);
      count -= 1;
      total -= e.size;
    } catch (err) {
      logError("hook.pruneArchives", err, { path: e.path });
    }
  }
  return deleted;
}

/**
 * Copy `sessionPath` into `archiveDir` as
 * `<first-8-of-session-id>-<YYYYMMDD-HHMMSS>.jsonl`, then prune the dir
 * to the retention caps. The original is never mutated. Returns the
 * archive path. Pure (no process.exit) — exported for tests, which pass
 * explicit temp dirs and small caps.
 */
export function archiveSession(
  sessionPath: string,
  archiveDir: string,
  opts: { sessionId?: string; now?: Date; maxFiles?: number; maxBytes?: number } = {},
): string {
  mkdirSync(archiveDir, { recursive: true });
  const id =
    (opts.sessionId && opts.sessionId.trim()) || basename(sessionPath, ".jsonl");
  const stamp = archiveStamp(opts.now ?? new Date());
  const stem = `${id.slice(0, 8)}-${stamp}`;
  let target = join(archiveDir, `${stem}.jsonl`);
  // Two compactions within the same second: suffix rather than overwrite.
  for (let i = 1; existsSync(target); i += 1) {
    target = join(archiveDir, `${stem}-${i}.jsonl`);
  }
  copyFileSync(sessionPath, target);
  pruneArchives(
    archiveDir,
    opts.maxFiles ?? ARCHIVE_MAX_FILES,
    opts.maxBytes ?? ARCHIVE_MAX_BYTES,
  );
  return target;
}

/**
 * Testable core of the PreCompact hook: resolve the session file and
 * archive it. Returns the archive path, or null if the session couldn't
 * be located. Throws on I/O failure — the runPreCompactHook wrapper
 * catches everything so compaction is never blocked.
 */
export function handlePreCompact(
  input: HookInput,
  archiveDir: string = defaultArchiveDir(),
): string | null {
  const sessionFile = resolveSessionFile(input);
  if (!sessionFile) return null;
  return archiveSession(sessionFile, archiveDir, { sessionId: input.session_id });
}

function runPreCompactHook(input: HookInput): void {
  try {
    logEvent("hook.runPreCompactHook", "precompact hook invoked", {
      trigger: input.trigger,
      session_id: input.session_id,
    });
    const archived = handlePreCompact(input);
    if (archived) {
      process.stderr.write(
        `[claudecompress] archived session before compact → ${archived}\n`,
      );
      logEvent("hook.runPreCompactHook", "session archived", { archived });
    } else {
      process.stderr.write(
        "[claudecompress] precompact: could not locate session transcript; nothing archived\n",
      );
    }
  } catch (err) {
    // Never block compaction — log and move on.
    logError("hook.runPreCompactHook", err, {
      session_id: input.session_id,
      transcript_path: input.transcript_path,
    });
    try {
      process.stderr.write(
        `[claudecompress] precompact archive failed (compaction continues): ${String(
          err instanceof Error ? err.message : err,
        )}\n`,
      );
    } catch {}
  }
  process.exit(0); // ALWAYS allow compaction to proceed
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Simple informational slash commands. Each blocks its own prompt (exit 2)
// and reports via stderr, same pattern as /break and /ttl — the model never
// sees these prompts, so they cost zero tokens.
// --------------------------------------------------------------------------

const SIMPLE_COMMANDS = ["savings", "analyze", "probe", "diff", "gc"] as const;
type SimpleCommand = (typeof SIMPLE_COMMANDS)[number];

export function parseSimpleCommand(prompt: string): SimpleCommand | null {
  const m = prompt.trim().match(/^\/(savings|analyze|probe|diff|gc)\b/);
  return m ? (m[1] as SimpleCommand) : null;
}

function hookProjectDir(input: HookInput): string {
  // Hooks run with cwd set to the project dir, but derive from the payload
  // when present — more robust than trusting process.cwd() (MSYS path
  // mangling on Windows is handled the same way resolveSessionFile does it).
  return input.cwd ? projectDirForCwd(input.cwd) : projectDirForCwd();
}

const pctStr = (f: number): string => `${Math.round(f * 1000) / 10}%`;

function runSavingsHook(): void {
  const s = summarizeHistory();
  const lines = ["", "┌─ claudecompress savings ─────────────────────────────┐"];
  if (s.count === 0) {
    lines.push(
      "  No trims recorded yet.",
      "  Every /compress from now on is logged — savings",
      "  accumulate here automatically.",
    );
  } else {
    lines.push(
      `  trims:         ${s.count}`,
      `  tokens saved:  ${fmtTokens(s.tokensSaved)}  (context you didn't re-pay for)`,
      `  cost saved:    ${formatUSD(s.costSaved)}  (cold-resume cache writes avoided)`,
      `  disk saved:    ${humanBytes(s.bytesSaved)}  (per-resume transcript weight)`,
    );
  }
  lines.push("└──────────────────────────────────────────────────────┘", "");
  process.stderr.write(lines.join("\n"));
  process.exit(2);
}

function runAnalyzeHook(input: HookInput): void {
  const dir = hookProjectDir(input);
  const rep = analyzeProject(dir);
  const lines = ["", "┌─ claudecompress analyze ─────────────────────────────┐"];
  if (rep.sessionCount === 0) {
    lines.push("  No sessions found for this project.");
  } else {
    lines.push(
      `  sessions: ${rep.sessionCount} · ${humanBytes(rep.totalBytes)} · ≈${fmtTokens(rep.totalTokens)} tokens`,
      `  cache:    ${rep.cacheStates.warm} warm · ${rep.cacheStates.cold} cold · ${rep.cacheStates["very-cold"]} very-cold`,
      "",
      "  largest sessions:",
    );
    for (const s of rep.topSessions) {
      const cost = s.coldResumeCost === null ? "?" : formatUSD(s.coldResumeCost);
      lines.push(
        `    ${s.sessionId.slice(0, 8)}…  ${humanBytes(s.bytes).padStart(10)}  ${s.ageLabel.padStart(9)}  cold-resume ≈ ${cost}`,
      );
    }
  }
  lines.push(
    "└──────────────────────────────────────────────────────┘",
    "",
    "  Full report incl. measured per-mode savings:",
    "    claudecompress analyze          (this project)",
    "    claudecompress analyze --all    (every project)",
    "",
  );
  process.stderr.write(lines.join("\n"));
  process.exit(2);
}

async function runProbeHook(input: HookInput): Promise<void> {
  const sessionFile = resolveSessionFile(input);
  if (!sessionFile) {
    process.stderr.write("[claudecompress] /probe: could not locate this session's file.\n");
    process.exit(2);
  }
  const { origTokens, ground, rows, compacted } = await probeSession(sessionFile);
  const lines = [
    "",
    "┌─ claudecompress probe · this session ────────────────────────────┐",
    `  ${fmtTokens(origTokens)} tokens · ${ground.artifacts.length} files modified · ${ground.toolSkeleton.length} tool calls · ${ground.errorSnippets.length} errors`,
  ];
  if (compacted) {
    lines.push(
      "  note: session was /compact'ed — scoring the post-compact window",
      "        (what /resume replays); earlier history is already summarized.",
    );
  }
  lines.push(
    "",
    "  mode       saved   files  skeleton  asks  errors  recent",
    "  ---------------------------------------------------------",
  );
  for (const r of rows) {
    lines.push(
      `  ${r.mode.padEnd(9)}${(r.savedPct.toFixed(1) + "%").padStart(6)}  ${pctStr(r.scores.artifactRetention).padStart(6)}  ${pctStr(r.scores.toolSkeletonRetention).padStart(8)}  ${pctStr(r.scores.userAskRetention).padStart(4)}  ${pctStr(r.scores.errorRetention).padStart(6)}  ${pctStr(r.scores.recentContentRetention).padStart(6)}`,
    );
  }
  lines.push("", "  verdicts:");
  for (const r of rows) lines.push(`    ${r.mode.padEnd(9)} ${r.verdict}`);
  lines.push(
    "└───────────────────────────────────────────────────────────────────┘",
    "",
    "  Trim with the mode you trust: /compress safe · /compress slim",
    "",
  );
  process.stderr.write(lines.join("\n"));
  process.exit(2);
}

function runDiffHook(): void {
  const resolved = resolveDiffTarget([]);
  if ("error" in resolved) {
    process.stderr.write(`\n[claudecompress] /diff: ${resolved.error}\n`);
    process.exit(2);
  }
  if (!existsSync(resolved.originalPath) || !existsSync(resolved.trimmedPath)) {
    process.stderr.write(
      "\n[claudecompress] /diff: the last trim's files are no longer on disk.\n",
    );
    process.exit(2);
  }
  const { outPath, stats } = writeDiffReport(resolved.originalPath, resolved.trimmedPath);
  openInBrowser(outPath, true);
  process.stderr.write(
    [
      "",
      "┌─ claudecompress diff ────────────────────────────────┐",
      `  last trim: ${stats.unchanged} unchanged · ${stats.modified} modified · ${stats.dropped} dropped`,
      `  saved:     ${humanBytes(Math.max(0, stats.bytesBefore - stats.bytesAfter))}`,
      `  report:    ${outPath}`,
      "└──────────────────────────────────────────────────────┘",
      "  (opened in your browser)",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function runGcHook(input: HookInput): void {
  const dir = hookProjectDir(input);
  const plan = planGc(
    [dir],
    { mode: "safe", keepLastN: 5, minSizeBytes: 200 * 1024, minAgeMs: 24 * 3600 * 1000, dropThinking: true },
    readHistory(),
  );
  const lines = ["", "┌─ claudecompress gc · preview ────────────────────────┐"];
  if (plan.candidates.length === 0) {
    lines.push("  Nothing to trim — no cold sessions ≥ 200 KB older than 24h.");
  } else {
    for (const c of plan.candidates) {
      lines.push(
        `  ${c.sessionId.slice(0, 8)}…  ${humanBytes(c.bytes).padStart(10)}  ${c.ageLabel.padStart(9)}  ≈${c.tokens === null ? "?" : fmtTokens(c.tokens)} tokens`,
      );
    }
    lines.push(
      "",
      `  ${plan.candidates.length} session(s) · ${humanBytes(plan.totalBytes)} · ≈${fmtTokens(plan.totalTokens)} tokens`,
    );
  }
  lines.push("└──────────────────────────────────────────────────────┘");
  if (plan.candidates.length > 0) {
    lines.push("", "  To execute (originals are never touched):", "    claudecompress gc --yes", "");
  } else {
    lines.push("");
  }
  process.stderr.write(lines.join("\n"));
  process.exit(2);
}

export async function runHook(): Promise<void> {
  const logPath = join(homedir(), ".claude", "claudecompress", "hook-debug.log");
  try {
    const raw = await readStdin(750);
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
    } catch (err) {
      logError("hook.runHook.parseInput", err, { rawLength: raw.length });
      process.exit(0);
    }

    // PreCompact fires from Claude Code's compaction path, not from a user
    // prompt — dispatch on the event name before any prompt parsing.
    // runPreCompactHook exits 0 on every path (including errors) so a
    // broken archive can never block compaction.
    if (input.hook_event_name === "PreCompact") {
      runPreCompactHook(input);
      return;
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

    const ttlArgs = parseTtlArgs(prompt);
    if (ttlArgs) {
      runTtlHook(input);
      return;
    }

    const simple = parseSimpleCommand(prompt);
    if (simple === "savings") runSavingsHook();
    else if (simple === "analyze") runAnalyzeHook(input);
    else if (simple === "probe") await runProbeHook(input);
    else if (simple === "diff") runDiffHook();
    else if (simple === "gc") runGcHook(input);

    process.exit(0); // unknown prompt — allow through
  } catch (err) {
    // Top-level safety net — surfaces any crash as stderr + exit 2 so the
    // user sees WHY the hook failed instead of a silent "non-blocking
    // status code" from Claude Code. Also persist to the debug log so the
    // error survives past Claude Code's UI, which may swallow stderr.
    logError("hook.runHook", err);
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    process.stderr.write(`[claudecompress] hook crashed:\n${msg}\n`);
    try {
      writeFileSync(
        logPath,
        `CRASH ${new Date().toISOString()}\n${msg}\n---\n`,
        { flag: "a" },
      );
    } catch (writeErr) {
      logError("hook.runHook.writeDebug", writeErr);
    }
    process.exit(2);
  }
}
