#!/usr/bin/env node
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

async function pickFromAllProjects(): Promise<string | null> {
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

async function pickSession(projectDir: string, allowSwitch = true): Promise<string | null> {
  const sessions = listSessions(projectDir);
  if (sessions.length === 0) {
    if (allowSwitch) {
      p.log.warn(`No sessions in ${projectDir}`);
      const other = await pickFromAllProjects();
      if (!other) return null;
      return pickSession(other, false);
    }
    p.log.error(`No .jsonl sessions in ${projectDir}`);
    return null;
  }

  const sessionInfos = sessions.slice(0, 25).map((path) => summarizeSession(path));
  const latest = sessionInfos[0]!;
  const latestStale = staleness(latest.mtime);

  const options: { value: string; label: string }[] = [
    {
      value: latest.path,
      label: `${pc.green("Latest")}  ${pc.dim(humanBytes(latest.bytes))}  ${cacheTag(latestStale.state, latestStale.label)}  ${pc.dim(preview(latest.firstUserMessage, 45))}`,
    },
  ];
  if (sessionInfos.length > 1) {
    options.push({ value: "__browse__", label: "Browse all sessions in this project" });
  }
  if (allowSwitch) {
    options.push({ value: "__other__", label: pc.dim("Other projects…") });
  }

  const choice = await p.select({ message: "Which session?", options });
  if (p.isCancel(choice)) return null;
  if (choice === "__other__") {
    const other = await pickFromAllProjects();
    if (!other) return null;
    return pickSession(other, false);
  }
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

/**
 * Run each of the common modes to a temp file and measure the resulting
 * cold-resume cost. Returns a map keyed by mode id → USD. Focus/Recency
 * use the given defaultN (displayed as "at N=15" in the picker).
 *
 * Sequential to avoid hammering the disk; 6 trims on a 35MB file runs in
 * ~5-8s. Caller should wrap in a spinner.
 */
async function estimateModeSavings(
  sessionPath: string,
  model: ModelInfo,
  defaultN = 15,
): Promise<Record<string, { after: number; saved: number }>> {
  const { unlinkSync } = await import("node:fs");
  const baseTokens = estimateSessionTokens(sessionPath, model);
  const baseCost = estimateColdResumeCost(baseTokens, model);

  const jobs: { key: string; opts: TrimOptions }[] = [
    { key: "lossless", opts: { mode: "lossless" } },
    { key: "safe", opts: { mode: "safe", keepLastN: defaultN, dropThinking: true } },
    { key: "smart", opts: { mode: "smart" } },
    { key: "slim", opts: { mode: "slim", keepLastN: defaultN, dropThinking: true } },
  ];

  const out: Record<string, { after: number; saved: number }> = {};
  for (const { key, opts } of jobs) {
    try {
      const { path: outPath } = await trimSession(sessionPath, opts);
      const afterTokens = estimateSessionTokens(outPath, model);
      const afterCost = estimateColdResumeCost(afterTokens, model);
      out[key] = { after: afterCost, saved: Math.max(0, baseCost - afterCost) };
      try { unlinkSync(outPath); } catch {}
    } catch {
      // skip mode on error
    }
  }
  return out;
}

async function pickMode(
  sessionPath?: string,
  model?: ModelInfo,
  defaultN = 15,
): Promise<TrimOptions | null> {
  // Pre-compute savings per mode so the picker shows real numbers, not
  // vague descriptors. Skipped if we weren't given the session/model
  // context (e.g. subcommand usage).
  let est: Record<string, { after: number; saved: number }> = {};
  if (sessionPath && model) {
    const spin = p.spinner();
    spin.start(`Estimating savings for each mode (N=${defaultN} where applicable)`);
    est = await estimateModeSavings(sessionPath, model, defaultN);
    spin.stop("Mode estimates ready.");
  }

  const savingsTag = (key: string): string => {
    const r = est[key];
    if (!r) return "";
    return `  ${pc.green("saves ≈ " + formatUSD(r.saved))}`;
  };

  const mode = await p.select({
    message: "How aggressive?",
    initialValue: "safe",
    options: [
      {
        value: "lossless",
        label: `${pc.green("lossless")}  ${pc.dim("only squash verbose tool outputs — preserves every turn")}${savingsTag("lossless")}`,
      },
      {
        value: "safe",
        label: `${pc.blue("safe")}  ${pc.green("★")} ${pc.dim("keep last N verbatim, observation-mask older — research-aligned")}${savingsTag("safe")}`,
      },
      {
        value: "smart",
        label: `${pc.yellow("smart")}  ${pc.dim("per-component rules by turn depth — tool skeleton survives")}${savingsTag("smart")}`,
      },
      {
        value: "slim",
        label: `${pc.cyan("slim")}  ${pc.dim("dialog trail only for older turns — loses breadcrumbs")}${savingsTag("slim")}`,
      },
    ],
  });
  if (p.isCancel(mode)) return null;

  let baseOpts: TrimOptions = { mode: mode as TrimMode };

  if (mode === "safe" || mode === "slim") {
    // fallthrough — asks for N below
    const raw = await p.text({
      message: "How many recent user turns (your messages) to keep verbatim?",
      placeholder: String(defaultN),
      initialValue: String(defaultN),
      validate: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "Enter a positive number";
      },
    });
    if (p.isCancel(raw)) return null;
    baseOpts = { mode: mode as TrimMode, keepLastN: Number(raw) };
  }

  if (mode !== "smart" && mode !== "lossless") {
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
  if (sub === "hook") {
    const { runHook } = await import("./hook.ts");
    await runHook();
    return;
  }
  if (sub === "statusline") {
    const { runStatusline } = await import("./statusline.ts");
    await runStatusline();
    return;
  }
  if (sub === "install") {
    const { install } = await import("./install.ts");
    await install();
    return;
  }
  if (sub === "install-statusline") {
    const { installStatusline } = await import("./install.ts");
    await installStatusline();
    return;
  }
  if (sub === "install-hook") {
    const { installHook } = await import("./install.ts");
    await installHook();
    return;
  }
  if (sub === "uninstall") {
    const { uninstall } = await import("./install.ts");
    await uninstall();
    return;
  }

  console.clear();
  p.intro(pc.bgCyan(pc.black(" claudecompress ")));
  printHistorySummary();

  const model = await pickModel();
  if (!model) return p.cancel("Aborted.");

  const cwdDir = projectDirForCwd();
  const cwdHasProject = existsSync(cwdDir);
  if (cwdHasProject) {
    console.log(pc.dim(`Project: current directory  (${cwdDir})`));
    console.log();
  }

  const startDir = cwdHasProject ? cwdDir : null;
  const session = startDir
    ? await pickSession(startDir, true)
    : await (async () => {
        const other = await pickFromAllProjects();
        if (!other) return null;
        return pickSession(other, false);
      })();
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

  const opts = await pickMode(session, model);
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
  const { path: outPath } = await trimSession(session, opts);
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
    pc.dim("Tip: when Claude Code suggests ") +
      pc.bold("/clear") +
      pc.dim(" (context pressure), run ") +
      pc.bold("claudecompress") +
      pc.dim(" instead — you keep the thread and pay less on cold resume."),
  );

  p.outro(pc.green("Done."));
}

main().catch((err) => {
  p.log.error(String(err?.stack ?? err));
  process.exit(1);
});
