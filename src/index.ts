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
} from "./paths.ts";
import { analyze, summarizeSession } from "./analyzer.ts";
import { trimSession } from "./trimmer.ts";
import type { TrimMode, TrimOptions } from "./types.ts";

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

  const choice = await p.select({
    message: "Which session?",
    options: [
      {
        value: sessionInfos[0]!.path,
        label: `${pc.green("Latest")}  ${pc.dim(humanBytes(sessionInfos[0]!.bytes))}  ${pc.dim(preview(sessionInfos[0]!.firstUserMessage, 50))}`,
      },
      { value: "__browse__", label: "Browse all sessions" },
    ],
  });
  if (p.isCancel(choice)) return null;
  if (choice !== "__browse__") return choice as string;

  const picked = await p.select({
    message: "Pick a session",
    options: sessionInfos.map((s) => ({
      value: s.path,
      label: `${humanBytes(s.bytes).padStart(9)}  ${pc.dim(s.sessionId.slice(0, 8))}  ${preview(s.firstUserMessage, 55)}`,
    })),
  });
  if (p.isCancel(picked)) return null;
  return picked as string;
}

async function pickMode(): Promise<TrimOptions | null> {
  const mode = await p.select({
    message: "How aggressive?",
    options: [
      {
        value: "ultra",
        label: `${pc.green("Ultra")}   ${pc.dim("dialog only — smallest, breaks tool replay")}`,
      },
      {
        value: "redact",
        label: `${pc.yellow("Redact")}  ${pc.dim("drop tool_result bodies, keep structure")}`,
      },
      {
        value: "truncate",
        label: `${pc.cyan("Truncate")} ${pc.dim("keep first N chars of each tool_result")}`,
      },
    ],
  });
  if (p.isCancel(mode)) return null;

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
    return { mode: "truncate" as TrimMode, keepChars: Number(raw) };
  }
  return { mode: mode as TrimMode };
}

async function main() {
  console.clear();
  p.intro(pc.bgCyan(pc.black(" claudecompress ")));

  const project = await pickProject();
  if (!project) return p.cancel("Aborted.");

  const session = await pickSession(project);
  if (!session) return p.cancel("Aborted.");

  const before = analyze(session);
  printReport("Before", before);

  const opts = await pickMode();
  if (!opts) return p.cancel("Aborted.");

  const confirm = await p.confirm({
    message: `Write a stripped copy alongside ${basename(session)}?`,
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) return p.cancel("Aborted.");

  const spin = p.spinner();
  spin.start("Trimming…");
  const outPath = await trimSession(session, opts);
  spin.stop("Trim complete.");

  const after = analyze(outPath);
  printReport("After", after);

  const ratio = ((100 * after.bytes) / (before.bytes || 1)).toFixed(1);
  console.log();
  console.log(
    `${pc.bold("before")} ${humanBytes(before.bytes)}  →  ${pc.bold("after")} ${humanBytes(after.bytes)}  ${pc.dim(`(${ratio}% of original)`)}`,
  );
  console.log();
  console.log(pc.bold("New session hash:"));
  console.log("  " + pc.cyan(basename(outPath, ".jsonl")));
  console.log();
  console.log(pc.dim("Resume with:  ") + "claude --resume");
  console.log(pc.dim("Then send a ") + pc.bold("`hi`") + pc.dim(" to force /context to recompute."));

  p.outro(pc.green("Done."));
}

main().catch((err) => {
  p.log.error(String(err?.stack ?? err));
  process.exit(1);
});
