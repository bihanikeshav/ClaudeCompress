#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const SIGNAL_FILE = join(
  homedir(),
  ".claude",
  "claudecompress",
  "next-resume",
);

function ensureDir(): void {
  try {
    mkdirSync(dirname(SIGNAL_FILE), { recursive: true });
  } catch {
    // ignore
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

function runClaude(args: string[]): Promise<number> {
  const cmd = resolveClaudeCmd();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        CCW_SIGNAL_FILE: SIGNAL_FILE,
        CCW_ACTIVE: "1",
      },
      shell: process.platform === "win32" || cmd !== "claude",
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
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

async function main(): Promise<void> {
  ensureDir();
  clearSignal();
  const originalArgs = process.argv.slice(2);
  let args = originalArgs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const code = await runClaude(args);
    const next = readSignal();
    if (!next) process.exit(code);
    process.stdout.write(
      `\n[ccw] resuming trimmed session ${next}\n\n`,
    );
    args = mergeResumeArgs(originalArgs, next);
  }
}

main().catch((err) => {
  process.stderr.write(
    `[ccw] ${String(err instanceof Error ? err.message : err)}\n`,
  );
  process.exit(1);
});
