import * as p from "@clack/prompts";
import pc from "picocolors";
import { statSync, existsSync, copyFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  listProjects,
  listSessions,
  projectDirForCwd,
  staleness,
  humanBytes,
  type CacheState,
} from "./paths.ts";
import { analyze, detectSessionModel, summarizeSession } from "./analyzer.ts";
import { roughContextTokens } from "./tokenCounter.ts";
import { trimSession } from "./trimmer.ts";
import { findModel, estimateColdResumeCost, formatUSD } from "./pricing.ts";
import { logError } from "./errorLog.ts";
import type { TrimMode, TrimOptions } from "./types.ts";

/**
 * `claudecompress analyze` — fleet-level waste report. Read-only except for
 * the projected-savings sample, which trims a temp COPY of each sampled
 * session (never a sibling in the real project dir) and deletes it after
 * measuring.
 */

export interface SessionInfo {
  path: string;
  sessionId: string;
  bytes: number;
  mtimeISO: string;
  state: CacheState;
  ageLabel: string;
  /** null when the token estimate failed (malformed file etc.). */
  tokens: number | null;
}

export interface TopSession extends SessionInfo {
  preview: string;
  model: string;
  /** null when tokens couldn't be estimated. */
  coldResumeCost: number | null;
}

export interface ProjectReport {
  name: string;
  path: string;
  sessionCount: number;
  totalBytes: number;
  totalTokens: number;
  cacheStates: Record<CacheState, number>;
  sessions: SessionInfo[];
  topSessions: TopSession[];
  /** Aggregate content-category breakdown across all sessions (analyzer keys). */
  categories: { sizes: Record<string, number>; counts: Record<string, number> };
}

/**
 * Scan one project dir. Pure over the filesystem — takes an explicit dir
 * so tests can point it at a fixture; `now` is injectable for age math.
 */
export function analyzeProject(projectDir: string, now: Date = new Date()): ProjectReport {
  const sizes: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const sessions: SessionInfo[] = [];
  const cacheStates: Record<CacheState, number> = { warm: 0, cold: 0, "very-cold": 0 };

  for (const path of listSessions(projectDir)) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const stale = staleness(new Date(st.mtimeMs), now);
    let tokens: number | null = null;
    try {
      tokens = roughContextTokens(path);
    } catch (err) {
      logError("analyzeCmd.analyzeProject.tokens", err, { path });
    }
    try {
      const rep = analyze(path);
      for (const k of Object.keys(rep.sizes)) {
        sizes[k] = (sizes[k] ?? 0) + rep.sizes[k]!;
        counts[k] = (counts[k] ?? 0) + rep.counts[k]!;
      }
    } catch (err) {
      logError("analyzeCmd.analyzeProject.analyze", err, { path });
    }
    cacheStates[stale.state] += 1;
    sessions.push({
      path,
      sessionId: basename(path, ".jsonl"),
      bytes: st.size,
      mtimeISO: new Date(st.mtimeMs).toISOString(),
      state: stale.state,
      ageLabel: stale.label,
      tokens,
    });
  }

  const bySize = [...sessions].sort((a, b) => b.bytes - a.bytes);
  const topSessions: TopSession[] = bySize.slice(0, 5).map((s) => {
    let preview = "";
    try {
      preview = summarizeSession(s.path).firstUserMessage;
    } catch {
      preview = "(unreadable)";
    }
    const model = findModel(detectSessionModel(s.path) ?? "claude-opus-4-8");
    return {
      ...s,
      preview,
      model: model.id,
      coldResumeCost: s.tokens === null ? null : estimateColdResumeCost(s.tokens, model),
    };
  });

  return {
    name: basename(projectDir),
    path: projectDir,
    sessionCount: sessions.length,
    totalBytes: sessions.reduce((n, s) => n + s.bytes, 0),
    totalTokens: sessions.reduce((n, s) => n + (s.tokens ?? 0), 0),
    cacheStates,
    sessions,
    topSessions,
    categories: { sizes, counts },
  };
}

export interface ModeSavings {
  mode: TrimMode;
  sessionsSampled: number;
  tokensBefore: number;
  tokensAfter: number;
  costBefore: number;
  costAfter: number;
  costSaved: number;
}

/**
 * Projected savings per trim mode for the given sample of sessions.
 * Each session is copied into its own temp dir before trimming — the trim
 * product must never appear as a phantom session in the real project dir,
 * even transiently — and everything is deleted after measurement.
 */
export async function projectSavingsSample(
  sessionPaths: string[],
  opts: { keepLastN?: number } = {},
): Promise<ModeSavings[]> {
  const keepLastN = opts.keepLastN ?? 5;
  const jobs: { mode: TrimMode; opts: TrimOptions }[] = [
    { mode: "lossless", opts: { mode: "lossless" } },
    { mode: "safe", opts: { mode: "safe", keepLastN, dropThinking: true } },
    { mode: "smart", opts: { mode: "smart" } },
    { mode: "slim", opts: { mode: "slim", keepLastN, dropThinking: true } },
  ];
  const agg = new Map<TrimMode, ModeSavings>();
  for (const j of jobs) {
    agg.set(j.mode, {
      mode: j.mode,
      sessionsSampled: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      costBefore: 0,
      costAfter: 0,
      costSaved: 0,
    });
  }

  for (const src of sessionPaths) {
    let tokensBefore: number;
    try {
      tokensBefore = roughContextTokens(src);
    } catch (err) {
      logError("analyzeCmd.projectSavingsSample.before", err, { src });
      continue;
    }
    const model = findModel(detectSessionModel(src) ?? "claude-opus-4-8");
    const costBefore = estimateColdResumeCost(tokensBefore, model);
    const tmp = mkdtempSync(join(tmpdir(), "ccw-analyze-"));
    try {
      const copy = join(tmp, basename(src));
      copyFileSync(src, copy);
      for (const j of jobs) {
        try {
          const trim = await trimSession(copy, j.opts);
          const tokensAfter = roughContextTokens(trim.path);
          try { unlinkSync(trim.path); } catch {}
          const row = agg.get(j.mode)!;
          const costAfter = estimateColdResumeCost(tokensAfter, model);
          row.sessionsSampled += 1;
          row.tokensBefore += tokensBefore;
          row.tokensAfter += tokensAfter;
          row.costBefore += costBefore;
          row.costAfter += costAfter;
          row.costSaved += Math.max(0, costBefore - costAfter);
        } catch (err) {
          logError("analyzeCmd.projectSavingsSample.trim", err, { src, mode: j.mode });
        }
      }
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
  return jobs.map((j) => agg.get(j.mode)!);
}

// ---------------------------------------------------------------------------
// CLI presenter
// ---------------------------------------------------------------------------

interface AnalyzeFlags {
  all: boolean;
  json: boolean;
  sample: number;
}

function parseAnalyzeArgs(args: string[]): AnalyzeFlags {
  const flags: AnalyzeFlags = { all: false, json: false, sample: 3 };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--all") flags.all = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--sample") {
      const n = Number(args[i + 1]);
      if (!Number.isInteger(n) || n < 0) throw new Error("--sample needs a non-negative integer");
      flags.sample = n;
      i += 1;
    } else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function preview(s: string, max = 46): string {
  const oneline = s.replace(/\s+/g, " ").trim();
  return oneline.length > max ? oneline.slice(0, max) + "…" : oneline;
}

function printProjectReport(r: ProjectReport): void {
  console.log();
  console.log(pc.bold(r.name));
  console.log(
    `  ${pc.dim("sessions:")} ${r.sessionCount}  ${pc.dim("size:")} ${humanBytes(r.totalBytes)}  ${pc.dim("est. tokens:")} ${formatTokens(r.totalTokens)}`,
  );
  console.log(
    `  ${pc.dim("cache:")} ${pc.red(`${r.cacheStates.warm} warm`)} ${pc.dim("·")} ${pc.yellow(`${r.cacheStates.cold} cold`)} ${pc.dim("·")} ${pc.green(`${r.cacheStates["very-cold"]} very-cold`)}`,
  );

  if (r.topSessions.length > 0) {
    console.log();
    console.log(
      `  ${"size".padStart(10)}${"age".padStart(12)}${"cold resume".padStart(13)}  first message`,
    );
    console.log("  " + "-".repeat(78));
    for (const s of r.topSessions) {
      const cost = s.coldResumeCost === null ? "?" : formatUSD(s.coldResumeCost);
      console.log(
        `  ${humanBytes(s.bytes).padStart(10)}${s.ageLabel.padStart(12)}${cost.padStart(13)}  ${pc.dim(preview(s.preview))}`,
      );
    }
  }

  const total = r.totalBytes || 1;
  const cats = Object.keys(r.categories.sizes).sort(
    (a, b) => r.categories.sizes[b]! - r.categories.sizes[a]!,
  );
  if (cats.length > 0) {
    console.log();
    console.log(pc.dim("  where the bytes go:"));
    console.log(
      `  ${"category".padEnd(30)}${"count".padStart(8)}${"bytes".padStart(14)}${"share".padStart(9)}`,
    );
    console.log("  " + "-".repeat(61));
    for (const k of cats.slice(0, 12)) {
      const b = r.categories.sizes[k]!;
      const c = r.categories.counts[k]!;
      const share = ((100 * b) / total).toFixed(1) + "%";
      console.log(
        `  ${k.padEnd(30)}${String(c).padStart(8)}${humanBytes(b).padStart(14)}${share.padStart(9)}`,
      );
    }
  }
}

function printSavingsTable(savings: ModeSavings[], sampled: number): void {
  console.log();
  console.log(
    pc.bold("projected savings") +
      pc.dim(`  (measured on the ${sampled} largest cold session${sampled === 1 ? "" : "s"})`),
  );
  console.log(
    `  ${"mode".padEnd(10)}${"tokens".padStart(12)}${"→ after".padStart(12)}${"saved".padStart(10)}`,
  );
  console.log("  " + "-".repeat(44));
  for (const s of savings) {
    if (s.sessionsSampled === 0) continue;
    console.log(
      `  ${s.mode.padEnd(10)}${formatTokens(s.tokensBefore).padStart(12)}${formatTokens(s.tokensAfter).padStart(12)}${pc.green(formatUSD(s.costSaved).padStart(10))}`,
    );
  }
}

export async function runAnalyze(args: string[]): Promise<void> {
  let flags: AnalyzeFlags;
  try {
    flags = parseAnalyzeArgs(args);
  } catch (err) {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    console.error(pc.dim("usage: claudecompress analyze [--all] [--sample N] [--json]"));
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

  const reports: ProjectReport[] = [];
  for (const dir of dirs) {
    try {
      reports.push(analyzeProject(dir));
    } catch (err) {
      logError("analyzeCmd.runAnalyze.project", err, { dir });
    }
  }

  // Projected savings: sample the N largest sessions whose cache is already
  // gone — trimming a warm session costs more than it saves, so warm ones
  // never enter the sample.
  const coldSessions = reports
    .flatMap((r) => r.sessions)
    .filter((s) => s.state !== "warm")
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, flags.sample);

  let savings: ModeSavings[] = [];
  if (coldSessions.length > 0) {
    if (flags.json) {
      savings = await projectSavingsSample(coldSessions.map((s) => s.path));
    } else {
      const spin = p.spinner();
      spin.start(`Measuring projected savings (${coldSessions.length} session${coldSessions.length === 1 ? "" : "s"} × 4 modes)…`);
      savings = await projectSavingsSample(coldSessions.map((s) => s.path));
      spin.stop("Savings measured.");
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({ projects: reports, savings }, null, 2));
    return;
  }

  console.log(pc.bold("claudecompress analyze") + pc.dim(flags.all ? "  (all projects)" : ""));
  if (reports.length === 0) {
    console.log(pc.dim("No projects with sessions found."));
    return;
  }
  for (const r of reports) printProjectReport(r);
  if (savings.length > 0) printSavingsTable(savings, coldSessions.length);
  console.log();
  console.log(pc.dim("Reclaim it:  claudecompress gc --dry-run"));
}
