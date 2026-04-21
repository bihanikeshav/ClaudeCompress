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

function runClaude(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      stdio: "inherit",
      env: {
        ...process.env,
        CCW_SIGNAL_FILE: SIGNAL_FILE,
        CCW_ACTIVE: "1",
      },
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(
        `[ccw] failed to spawn claude: ${err.message}\n` +
          "      is the Claude Code CLI on your PATH?\n",
      );
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  ensureDir();
  clearSignal();
  let args = process.argv.slice(2);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const code = await runClaude(args);
    const next = readSignal();
    if (!next) process.exit(code);
    process.stdout.write(
      `\n[ccw] resuming trimmed session ${next}\n\n`,
    );
    args = ["--resume", next];
  }
}

main().catch((err) => {
  process.stderr.write(
    `[ccw] ${String(err instanceof Error ? err.message : err)}\n`,
  );
  process.exit(1);
});
