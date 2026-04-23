import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";

import { encodeCwd } from "./paths.ts";
import { trimSession } from "./trimmer.ts";
import { estimateSessionTokens } from "./analyzer.ts";
import { estimateColdResumeCost, findModel, formatUSD } from "./pricing.ts";
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
    // Defensive: if no stdin arrives at all, don't hang the user's prompt.
    setTimeout(done, 750).unref?.();
  });
}

const VALID_MODES: TrimMode[] = [
  "redact",
  "recency",
  "focus",
  "smart",
  "ultra",
  "truncate",
];

function parseCompressArgs(prompt: string): TrimOptions | null {
  const m = prompt.trim().match(/^\/compress\b\s*(.*)$/);
  if (!m) return null;
  const tokens = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const modeTok = (tokens[0] ?? "focus") as TrimMode;
  const mode: TrimMode = VALID_MODES.includes(modeTok) ? modeTok : "focus";
  const opts: TrimOptions = { mode };
  if (mode === "truncate") opts.keepChars = Number(tokens[1]) || 400;
  if (mode === "recency" || mode === "focus")
    opts.keepLastN = Number(tokens[1]) || 5;
  if (mode !== "ultra") opts.dropThinking = true;
  return opts;
}

function resolveSessionFile(input: HookInput): string | null {
  if (input.transcript_path && existsSync(input.transcript_path))
    return input.transcript_path;
  if (input.session_id && input.cwd) {
    const path = join(
      homedir(),
      ".claude",
      "projects",
      encodeCwd(input.cwd),
      `${input.session_id}.jsonl`,
    );
    if (existsSync(path)) return path;
  }
  return null;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function modeLabel(opts: TrimOptions): string {
  if (opts.mode === "truncate") return `truncate (${opts.keepChars} chars)`;
  if (opts.mode === "recency" || opts.mode === "focus")
    return `${opts.mode} (last ${opts.keepLastN})`;
  return opts.mode;
}

export async function runHook(): Promise<void> {
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // malformed input — let Claude Code handle normally
  }

  const opts = parseCompressArgs(input.prompt ?? "");
  if (!opts) process.exit(0); // not a /compress prompt — allow through

  const sessionFile = resolveSessionFile(input);
  if (!sessionFile) {
    process.stderr.write(
      "[claudecompress] could not locate active session JSONL\n",
    );
    process.exit(2);
  }

  try {
    const model = findModel("claude-opus-4-7")!;
    const beforeTokens = estimateSessionTokens(sessionFile, model);
    const beforeCost = estimateColdResumeCost(beforeTokens, model);

    const outPath = await trimSession(sessionFile, opts);
    const afterTokens = estimateSessionTokens(outPath, model);
    const afterCost = estimateColdResumeCost(afterTokens, model);
    const newHash = basename(outPath, ".jsonl");

    const savedTokens = Math.max(0, beforeTokens - afterTokens);
    const savedCost = Math.max(0, beforeCost - afterCost);

    const lines: string[] = [
      "",
      "┌─ claudecompress ────────────────────────────────────────┐",
      `  mode:   ${modeLabel(opts)}${opts.dropThinking ? " · dropped thinking" : ""}`,
      `  tokens: ${fmtTokens(beforeTokens)} → ${fmtTokens(afterTokens)}   (saved ≈ ${fmtTokens(savedTokens)})`,
      `  cold $ ${formatUSD(beforeCost)} → ${formatUSD(afterCost)}   (saved ≈ ${formatUSD(savedCost)})  [Opus 4.7]`,
      `  trimmed session: ${newHash}`,
      "└─────────────────────────────────────────────────────────┘",
      "",
    ];

    const signalFile = process.env.CCW_SIGNAL_FILE;
    let wroteSignal = false;
    if (signalFile) {
      try {
        mkdirSync(dirname(signalFile), { recursive: true });
        writeFileSync(signalFile, newHash);
        wroteSignal = true;
      } catch {
        // fall through to manual instructions
      }
    }

    if (wroteSignal) {
      lines.push(
        "  Running under ccw — press Ctrl+C to exit; ccw will auto-resume the trimmed session.",
      );
    } else {
      lines.push("  Exit this session (Ctrl+C), then run one of:");
      lines.push(`    claude --resume ${newHash}`);
      lines.push(
        `    claude --resume ${newHash} --dangerously-skip-permissions`,
      );
    }
    lines.push("");

    process.stderr.write(lines.join("\n"));
    process.exit(2); // block the /compress prompt itself from going to the model
  } catch (err) {
    process.stderr.write(
      `[claudecompress] error: ${String(err instanceof Error ? err.message : err)}\n`,
    );
    process.exit(2);
  }
}
