#!/usr/bin/env bun
import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import {
  listProjects,
  listSessions,
  projectDirForCwd,
  humanBytes,
  staleness,
  type CacheState,
} from "./paths.ts";
import { analyze, estimateSessionTokens, summarizeSession } from "./analyzer.ts";
import { trimSession } from "./trimmer.ts";
import type { TrimMode, TrimOptions } from "./types.ts";
import {
  MODELS,
  estimateColdResumeCost,
  findModel,
  formatUSD,
  type ModelInfo,
} from "./pricing.ts";
import { recordTrim, summarizeHistory, readHistory } from "./history.ts";

function cacheTag(state: CacheState, label: string): string {
  if (state === "warm") return pc.red(`warm · ${label}`);
  if (state === "cold") return pc.yellow(`cold · ${label}`);
  return pc.green(`cold · ${label}`);
}

async function pickModel(): Promise<ModelInfo | null> {
  const choice = await p.select({
    message: "Which Claude model are you using?",
    initialValue: "claude-opus-4-7",
    options: MODELS.map((m) => ({
      value: m.id,
      label: `${m.label}  ${pc.dim(`$${m.inputPerMillion}/M input`)}`,
    })),
  });
  if (p.isCancel(choice)) return null;
  return findModel(choice as string);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function preview(s: string, max = 70): string {
  const oneline = s.replace(/\s+/g, " ").trim();
  return oneline.length > max ? oneline.slice(0, max) + "…" : oneline;
}

function printReport(label: string, report: ReturnType<typeof analyze>) {
  const total = report.bytes || 1;
  const sorted = Object.keys(report.sizes).sort(
    (a, b) => report.sizes[b]! - report.sizes[a]!,
  );
  console.log();
  console.log(pc.bold(label));
  console.log(
    `  ${pc.dim("size:")} ${humanBytes(report.bytes)}  ${pc.dim("records:")} ${report.lines}`,
  );
  console.log();
  console.log(
    `  ${"category".padEnd(30)}${"count".padStart(8)}${"bytes".padStart(14)}${"share".padStart(9)}`,
  );
  console.log("  " + "-".repeat(61));
  for (const k of sorted) {
    const b = report.sizes[k]!;
    const c = report.counts[k]!;
    const share = ((100 * b) / total).toFixed(1) + "%";
    console.log(
      `  ${k.padEnd(30)}${String(c).padStart(8)}${humanBytes(b).padStart(14)}${share.padStart(9)}`,
    );
  }
}

async function pickProject(): Promise<string | null> {
  const cwdDir = projectDirForCwd();
  const useCwd = existsSync(cwdDir);

  const choice = await p.select({
    message: "Which Claude Code project?",
    options: [
      ...(useCwd
        ? [{ value: "cwd", label: `Current directory  ${pc.dim(`(${cwdDir})`)}` }]
        : []),
      { value: "list", label: "Pick from all projects" },
    ],
  });
  if (p.isCancel(choice)) return null;
  if (choice === "cwd") return cwdDir;

  const rows = listProjects();
  if (rows.length === 0) {
    p.log.error("No projects found in ~/.claude/projects");
    return null;
  }
  const picked = await p.select({
    message: "Pick a project",
    options: rows.map((r) => ({
      value: r.path,
      label: `${r.name}  ${pc.dim(`${r.files} sessions · ${humanBytes(r.bytes)}`)}`,
    })),
  });
  if (p.isCancel(picked)) return null;
  return picked as string;
}

async function pickSession(projectDir: string): Promise<string | null> {
  const sessions = listSessions(projectDir);
  if (sessions.length === 0) {
    p.log.error(`No .jsonl sessions in ${projectDir}`);
    return null;
  }

  const sessionInfos = sessions.slice(0, 25).map((path) => summarizeSession(path));
  const latest = sessionInfos[0]!;
  const latestStale = staleness(latest.mtime);

  const choice = await p.select({
    message: "Which session?",
    options: [
      {
        value: latest.path,
        label: `${pc.green("Latest")}  ${pc.dim(humanBytes(latest.bytes))}  ${cacheTag(latestStale.state, latestStale.label)}  ${pc.dim(preview(latest.firstUserMessage, 45))}`,
      },
      { value: "__browse__", label: "Browse all sessions" },
    ],
  });
  if (p.isCancel(choice)) return null;
  if (choice !== "__browse__") return choice as string;

  const picked = await p.select({
    message: "Pick a session",
    options: sessionInfos.map((s) => {
      const st = staleness(s.mtime);
      return {
        value: s.path,
        label: `${humanBytes(s.bytes).padStart(9)}  ${cacheTag(st.state, st.label).padEnd(22)}  ${pc.dim(preview(s.firstUserMessage, 50))}`,
      };
    }),
  });
  if (p.isCancel(picked)) return null;
  return picked as string;
}

async function pickMode(): Promise<TrimOptions | null> {
  const mode = await p.select({
    message: "How aggressive?",
    initialValue: "redact",
    options: [
      {
        value: "redact",
        label: `${pc.yellow("Redact")}   ${pc.dim("medium — drop all tool_result bodies, keep structure  [default]")}`,
      },
      {
        value: "recency",
        label: `${pc.blue("Recency")}  ${pc.dim("keep last N turns verbatim, redact older")}`,
      },
      {
        value: "smart",
        label: `${pc.magenta("Smart")}    ${pc.dim("light — per-tool rules, preserves Read heads, Bash errors, TodoWrite")}`,
      },
      {
        value: "ultra",
        label: `${pc.green("Ultra")}    ${pc.dim("heavy — dialog only; tool calls, results, thinking all dropped")}`,
      },
      {
        value: "truncate",
        label: `${pc.cyan("Truncate")} ${pc.dim("manual — keep first N chars of every tool_result")}`,
      },
    ],
  });
  if (p.isCancel(mode)) return null;

  let baseOpts: TrimOptions = { mode: mode as TrimMode };

  if (mode === "truncate") {
    const raw = await p.text({
      message: "Chars to keep per tool_result",
      placeholder: "400",
      initialValue: "400",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "Enter a positive number";
      },
    });
    if (p.isCancel(raw)) return null;
    baseOpts = { mode: "truncate", keepChars: Number(raw) };
  } else if (mode === "recency") {
    const raw = await p.text({
      message: "How many recent turns to keep verbatim?",
      placeholder: "15",
      initialValue: "15",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "Enter a positive number";
      },
    });
    if (p.isCancel(raw)) return null;
    baseOpts = { mode: "recency", keepLastN: Number(raw) };
  }

  if (mode !== "ultra") {
    const drop = await p.confirm({
      message: "Also drop thinking blocks? (extra savings, safe on resume)",
      initialValue: true,
    });
    if (p.isCancel(drop)) return null;
    baseOpts.dropThinking = drop;
  }

  return baseOpts;
}

function printHistorySummary(): void {
  const summary = summarizeHistory();
  if (summary.count === 0) return;
  console.log(
    pc.dim(
      `Lifetime: ${summary.count} trim${summary.count === 1 ? "" : "s"} · saved ≈ ${formatUSD(summary.costSaved)} (${formatTokens(summary.tokensSaved)} tokens)`,
    ),
  );
  console.log();
}

async function runHistory(): Promise<void> {
  const events = readHistory();
  if (events.length === 0) {
    console.log(pc.dim("No trim history yet. Run claudecompress first."));
    return;
  }
  console.log(pc.bold(`claudecompress history · ${events.length} event${events.length === 1 ? "" : "s"}`));
  console.log();
  console.log(
    `${"when".padEnd(20)}${"mode".padEnd(10)}${"model".padEnd(12)}${"saved".padStart(9)}${"tokens".padStart(12)}`,
  );
  console.log("-".repeat(63));
  const recent = events.slice(-20).reverse();
  for (const e of recent) {
    const when = new Date(e.timestamp).toISOString().slice(0, 16).replace("T", " ");
    const saved = formatUSD(Math.max(0, e.costBefore - e.costAfter));
    const tks = formatTokens(Math.max(0, e.tokensBefore - e.tokensAfter));
    console.log(
      `${when.padEnd(20)}${e.mode.padEnd(10)}${(e.model.replace("claude-", "")).padEnd(12)}${saved.padStart(9)}${tks.padStart(12)}`,
    );
  }
  const summary = summarizeHistory(events);
  console.log();
  console.log(
    pc.bold("total saved ≈ ") +
      pc.green(formatUSD(summary.costSaved)) +
      pc.dim(`  (${formatTokens(summary.tokensSaved)} tokens across ${summary.count} trims)`),
  );
}

async function main() {
  const [, , sub] = process.argv;
  if (sub === "history") {
    await runHistory();
    return;
  }

  console.clear();
  p.intro(pc.bgCyan(pc.black(" claudecompress ")));
  printHistorySummary();

  const model = await pickModel();
  if (!model) return p.cancel("Aborted.");

  const project = await pickProject();
  if (!project) return p.cancel("Aborted.");

  const session = await pickSession(project);
  if (!session) return p.cancel("Aborted.");

  const sessionInfo = summarizeSession(session);
  const stale = staleness(sessionInfo.mtime);
  const beforeTokens = estimateSessionTokens(session, model);
  const beforeCost = estimateColdResumeCost(beforeTokens, model);

  console.log();
  console.log(
    `${pc.dim("Last activity:")} ${stale.label}  ${pc.dim("·")}  ${cacheTag(stale.state, stale.state === "warm" ? "cache likely warm" : "cache expired")}`,
  );
  console.log(
    `${pc.dim("Replay cost estimate")} ${pc.dim("(" + model.label + ", cold /resume):")} ${pc.bold(formatTokens(beforeTokens) + " tokens")}  ${pc.dim("≈")}  ${pc.bold(formatUSD(beforeCost))}`,
  );
  if (stale.state === "warm") {
    console.log(
      pc.yellow(
        "  ⚠  Prompt cache is probably still live. Compressing now would invalidate it\n" +
          "     and cost more than you save. Only proceed if you know you're done with this\n" +
          "     session and want to resume cold later.",
      ),
    );
  }

  const before = analyze(session);
  printReport("Before", before);

  const opts = await pickMode();
  if (!opts) return p.cancel("Aborted.");

  const confirm = await p.confirm({
    message:
      stale.state === "warm"
        ? `Cache is warm. Trim anyway?`
        : `Write a stripped copy alongside ${basename(session)}?`,
    initialValue: stale.state !== "warm",
  });
  if (p.isCancel(confirm) || !confirm) return p.cancel("Aborted.");

  const spin = p.spinner();
  spin.start("Trimming…");
  const outPath = await trimSession(session, opts);
  spin.stop("Trim complete.");

  const after = analyze(outPath);
  printReport("After", after);

  const afterTokens = estimateSessionTokens(outPath, model);
  const afterCost = estimateColdResumeCost(afterTokens, model);
  const savedTokens = Math.max(0, beforeTokens - afterTokens);
  const savedCost = Math.max(0, beforeCost - afterCost);

  recordTrim({
    timestamp: new Date().toISOString(),
    mode: opts.mode,
    model: model.id,
    sourcePath: session,
    outputPath: outPath,
    bytesBefore: before.bytes,
    bytesAfter: after.bytes,
    tokensBefore: beforeTokens,
    tokensAfter: afterTokens,
    costBefore: beforeCost,
    costAfter: afterCost,
  });

  const ratio = ((100 * after.bytes) / (before.bytes || 1)).toFixed(1);
  console.log();
  console.log(
    `${pc.bold("before")} ${humanBytes(before.bytes)}  →  ${pc.bold("after")} ${humanBytes(after.bytes)}  ${pc.dim(`(${ratio}% of original)`)}`,
  );
  console.log(
    `${pc.bold("tokens")} ${formatTokens(beforeTokens)}  →  ${formatTokens(afterTokens)}  ${pc.dim("·")}  ${pc.bold("cold /resume")} ${formatUSD(beforeCost)}  →  ${formatUSD(afterCost)}  ${pc.green(`(saved ≈ ${formatUSD(savedCost)} / ${formatTokens(savedTokens)} tokens)`)}`,
  );
  console.log();
  console.log(pc.bold("New session hash:"));
  console.log("  " + pc.cyan(basename(outPath, ".jsonl")));
  console.log();
  console.log(pc.dim("Resume with:  ") + "claude --resume");
  console.log(pc.dim("Then send a ") + pc.bold("`hi`") + pc.dim(" to force /context to recompute."));
  console.log();
  console.log(
    pc.dim("Tip: a good moment to run ") +
      pc.bold("claudecompress") +
      pc.dim(" is right after you type ") +
      pc.bold("/clear") +
      pc.dim(" in an active session — the cache is about to go cold anyway."),
  );

  p.outro(pc.green("Done."));
}

main().catch((err) => {
  p.log.error(String(err?.stack ?? err));
  process.exit(1);
});
