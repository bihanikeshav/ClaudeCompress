import * as p from "@clack/prompts";
import pc from "picocolors";
import { statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  listProjects,
  listSessions,
  projectDirForCwd,
  staleness,
  humanBytes,
} from "./paths.ts";
import { detectSessionModel } from "./analyzer.ts";
import { roughContextTokens } from "./tokenCounter.ts";
import { trimSession } from "./trimmer.ts";
import { findModel, estimateColdResumeCost, formatUSD } from "./pricing.ts";
import { recordTrim, readHistory, type TrimEvent } from "./history.ts";
import { logError } from "./errorLog.ts";
import type { TrimMode } from "./types.ts";

/**
 * `claudecompress gc` — batch-trim cold sessions. Originals are NEVER
 * mutated or deleted; every trim writes a new sibling (trimSession's
 * contract) and gets recorded in history so a later gc run won't re-trim
 * the same work.
 */

// ---------------------------------------------------------------------------
// Flag parsers (exported for tests)
// ---------------------------------------------------------------------------

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

/** "500kb" → 512000, "2mb" → 2097152, bare "1234" → 1234 bytes. */
export function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(s.trim());
  if (!m) throw new Error(`invalid size: "${s}" (expected e.g. 500kb, 2mb)`);
  const unit = (m[2] ?? "b").toLowerCase();
  return Math.round(Number(m[1]) * SIZE_UNITS[unit]!);
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** "30m" → 1_800_000 ms, "6h", "2d". Unit is required — a bare number is ambiguous. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(s.trim());
  if (!m) throw new Error(`invalid duration: "${s}" (expected e.g. 30m, 6h, 2d)`);
  return Math.round(Number(m[1]) * DURATION_UNITS[m[2]!.toLowerCase()]!);
}

// ---------------------------------------------------------------------------
// Planning (pure — no prompts, no real ~/.claude reads; history is a param)
// ---------------------------------------------------------------------------

export interface GcOptions {
  mode: TrimMode;
  keepLastN: number;
  minSizeBytes: number;
  minAgeMs: number;
  dropThinking?: boolean;
}

export interface GcCandidate {
  path: string;
  sessionId: string;
  bytes: number;
  mtimeMs: number;
  ageLabel: string;
  /** null when the token estimate failed (malformed file etc.). */
  tokens: number | null;
}

export interface GcPlan {
  candidates: GcCandidate[];
  totalBytes: number;
  totalTokens: number;
}

const TRIM_MARKER_PREFIX = "[TRIMMED by claudecompress";
// Enough head to cover the metadata records that precede the first user
// message plus the message itself. If the first user record happens to be
// larger than this, its JSON.parse fails and we conservatively DON'T skip.
const HEAD_BYTES = 256 * 1024;

/**
 * Cheap check: is this file itself a trim product? Trimmed sessions carry
 * the marker as a prefix on the first user message, so we only need the
 * file head — never the whole (potentially tens of MB) file.
 */
export function hasTrimMarker(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.type !== "user") continue;
      const c = rec?.message?.content;
      if (typeof c === "string") return c.startsWith(TRIM_MARKER_PREFIX);
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "text" && typeof b.text === "string") {
            return b.text.startsWith(TRIM_MARKER_PREFIX);
          }
        }
      }
      return false; // first user record found, no marker
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

// History paths were written by this tool on this machine, but normalize
// anyway; Windows filesystems are case-insensitive.
function samePath(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === "win32"
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

/**
 * Select gc candidates across the given project dirs. Pure: history entries
 * come in as a parameter (runGc passes the real ~/.claude history; tests
 * pass fixtures) and `now` is injectable for age math.
 */
export function planGc(
  projectDirs: string[],
  opts: GcOptions,
  history: TrimEvent[] = [],
  now: Date = new Date(),
): GcPlan {
  const candidates: GcCandidate[] = [];
  for (const dir of projectDirs) {
    for (const path of listSessions(dir)) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.size < opts.minSizeBytes) continue;
      if (now.getTime() - st.mtimeMs < opts.minAgeMs) continue;

      // Skip trim products: anything history knows as an output, or whose
      // first user message carries the trim marker (covers products whose
      // history entry was lost).
      if (history.some((e) => samePath(e.outputPath, path))) continue;
      if (hasTrimMarker(path)) continue;

      // Skip sessions that already have a trimmed sibling newer than their
      // own mtime — re-trimming would just duplicate existing work.
      const alreadyTrimmed = history.some(
        (e) => samePath(e.sourcePath, path) && Date.parse(e.timestamp) > st.mtimeMs,
      );
      if (alreadyTrimmed) continue;

      let tokens: number | null = null;
      try {
        tokens = roughContextTokens(path);
      } catch (err) {
        logError("gc.planGc.tokens", err, { path });
      }
      candidates.push({
        path,
        sessionId: basename(path, ".jsonl"),
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        ageLabel: staleness(new Date(st.mtimeMs), now).label,
        tokens,
      });
    }
  }
  candidates.sort((a, b) => b.bytes - a.bytes);
  return {
    candidates,
    totalBytes: candidates.reduce((n, c) => n + c.bytes, 0),
    totalTokens: candidates.reduce((n, c) => n + (c.tokens ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface GcExecuted {
  sourcePath: string;
  outputPath: string;
  tokensBefore: number;
  tokensAfter: number;
  costBefore: number;
  costAfter: number;
}

export interface GcResult {
  trimmed: GcExecuted[];
  failures: { path: string; error: string }[];
  tokensSaved: number;
  costSaved: number;
  bytesSaved: number;
}

export interface GcExecDeps {
  /** History sink — defaults to the real recordTrim; tests inject a collector. */
  record?: (event: TrimEvent) => void;
  /** Per-session progress callback for the presenter's spinner. */
  onProgress?: (done: number, total: number, path: string) => void;
}

/**
 * Trim every candidate in the plan. Failures are logged and skipped — one
 * corrupt session must not abort the batch. Originals are untouched.
 */
export async function executeGcPlan(
  plan: GcPlan,
  opts: GcOptions,
  deps: GcExecDeps = {},
): Promise<GcResult> {
  const record = deps.record ?? recordTrim;
  const result: GcResult = { trimmed: [], failures: [], tokensSaved: 0, costSaved: 0, bytesSaved: 0 };
  let done = 0;
  for (const cand of plan.candidates) {
    deps.onProgress?.(done, plan.candidates.length, cand.path);
    try {
      const model = findModel(detectSessionModel(cand.path) ?? "claude-opus-4-8");
      const tokensBefore = cand.tokens ?? roughContextTokens(cand.path);
      const trim = await trimSession(cand.path, {
        mode: opts.mode,
        keepLastN: opts.keepLastN,
        dropThinking: opts.dropThinking,
      });
      const tokensAfter = roughContextTokens(trim.path);
      const costBefore = estimateColdResumeCost(tokensBefore, model);
      const costAfter = estimateColdResumeCost(tokensAfter, model);
      record({
        timestamp: new Date().toISOString(),
        mode: opts.mode,
        model: model.id,
        sourcePath: cand.path,
        outputPath: trim.path,
        bytesBefore: trim.originalBytes,
        bytesAfter: trim.trimmedBytes,
        tokensBefore,
        tokensAfter,
        costBefore,
        costAfter,
      });
      result.trimmed.push({
        sourcePath: cand.path,
        outputPath: trim.path,
        tokensBefore,
        tokensAfter,
        costBefore,
        costAfter,
      });
      result.tokensSaved += Math.max(0, tokensBefore - tokensAfter);
      result.costSaved += Math.max(0, costBefore - costAfter);
      result.bytesSaved += Math.max(0, trim.originalBytes - trim.trimmedBytes);
    } catch (err) {
      logError("gc.executeGcPlan", err, { path: cand.path, mode: opts.mode });
      result.failures.push({
        path: cand.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    done += 1;
  }
  deps.onProgress?.(done, plan.candidates.length, "");
  return result;
}

// ---------------------------------------------------------------------------
// CLI presenter
// ---------------------------------------------------------------------------

const TRIM_MODES: TrimMode[] = ["lossless", "safe", "smart", "slim"];

interface GcFlags extends GcOptions {
  all: boolean;
  dryRun: boolean;
  yes: boolean;
}

function parseGcArgs(args: string[]): GcFlags {
  const flags: GcFlags = {
    mode: "safe",
    keepLastN: 5,
    minSizeBytes: parseSize("200kb"),
    minAgeMs: parseDuration("24h"),
    all: false,
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[i + 1];
      if (v === undefined) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    if (a === "--mode") {
      const m = next() as TrimMode;
      if (!TRIM_MODES.includes(m)) throw new Error(`invalid mode: ${m} (${TRIM_MODES.join("|")})`);
      flags.mode = m;
    } else if (a === "--keep-last") {
      const n = Number(next());
      if (!Number.isInteger(n) || n <= 0) throw new Error("--keep-last needs a positive integer");
      flags.keepLastN = n;
    } else if (a === "--min-size") flags.minSizeBytes = parseSize(next());
    else if (a === "--min-age") flags.minAgeMs = parseDuration(next());
    else if (a === "--all") flags.all = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--yes" || a === "-y") flags.yes = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function printPlanTable(plan: GcPlan): void {
  console.log(
    `${"session".padEnd(14)}${"size".padStart(12)}${"age".padStart(12)}${"est. tokens".padStart(14)}`,
  );
  console.log("-".repeat(52));
  for (const c of plan.candidates) {
    const id = c.sessionId.length > 12 ? c.sessionId.slice(0, 11) + "…" : c.sessionId;
    console.log(
      `${id.padEnd(14)}${humanBytes(c.bytes).padStart(12)}${c.ageLabel.padStart(12)}${(c.tokens === null ? "?" : formatTokens(c.tokens)).padStart(14)}`,
    );
  }
  console.log("-".repeat(52));
  console.log(
    `${String(plan.candidates.length + " session" + (plan.candidates.length === 1 ? "" : "s")).padEnd(14)}${humanBytes(plan.totalBytes).padStart(12)}${"".padStart(12)}${formatTokens(plan.totalTokens).padStart(14)}`,
  );
}

export async function runGc(args: string[]): Promise<void> {
  let flags: GcFlags;
  try {
    flags = parseGcArgs(args);
  } catch (err) {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    console.error(
      pc.dim(
        "usage: claudecompress gc [--mode lossless|safe|smart|slim] [--keep-last N]\n" +
          "       [--min-size 200kb] [--min-age 24h] [--all] [--dry-run] [--yes]",
      ),
    );
    process.exitCode = 1;
    return;
  }

  let dirs: string[];
  if (flags.all) {
    dirs = listProjects().map((r) => r.path);
  } else {
    const d = projectDirForCwd();
    if (!existsSync(d)) {
      console.log(pc.dim(`No Claude project for this directory (${d}). Try --all.`));
      return;
    }
    dirs = [d];
  }

  console.log(
    pc.bold("claudecompress gc") +
      pc.dim(
        `  mode=${flags.mode} keep-last=${flags.keepLastN} min-size=${humanBytes(flags.minSizeBytes)} min-age=${flags.minAgeMs / 3_600_000}h${flags.all ? " (all projects)" : ""}`,
      ),
  );
  console.log();

  const plan = planGc(dirs, flags, readHistory());
  if (plan.candidates.length === 0) {
    console.log(pc.dim("Nothing to trim — no cold sessions match the thresholds."));
    return;
  }

  printPlanTable(plan);
  console.log();

  if (flags.dryRun) {
    console.log(pc.dim("--dry-run: no files written."));
    return;
  }

  if (!flags.yes) {
    const ok = await p.confirm({
      message: `Trim ${plan.candidates.length} session${plan.candidates.length === 1 ? "" : "s"} (${flags.mode})? Originals are kept.`,
      initialValue: true,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel("Aborted.");
      return;
    }
  }

  const spin = p.spinner();
  spin.start("Trimming…");
  const result = await executeGcPlan(plan, flags, {
    onProgress: (done, total, path) => {
      if (path) spin.message(`Trimming ${done + 1}/${total}  ${basename(path)}`);
    },
  });
  spin.stop("Done.");

  console.log();
  console.log(
    `${pc.bold("trimmed")} ${result.trimmed.length}/${plan.candidates.length} sessions  ${pc.dim("·")}  ` +
      pc.green(`saved ≈ ${formatUSD(result.costSaved)} (${formatTokens(result.tokensSaved)} tokens, ${humanBytes(result.bytesSaved)})`),
  );
  if (result.failures.length > 0) {
    console.log(pc.yellow(`${result.failures.length} failed (logged); originals untouched:`));
    for (const f of result.failures) {
      console.log(pc.dim(`  ${basename(f.path)}: ${f.error}`));
    }
  }
  console.log();
  console.log(pc.dim("Resume any trimmed copy with:  claude --resume"));
}
