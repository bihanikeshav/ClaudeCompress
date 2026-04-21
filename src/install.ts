import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

const CLAUDE_HOME = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_HOME, "settings.json");
const COMMAND_PATH = join(CLAUDE_HOME, "commands", "compress.md");

const HOOK_MATCHER = "^/compress";
const HOOK_TAG = "claudecompress hook";
const STATUSLINE_TAG = "claudecompress statusline";

function commandExists(cmd: string): boolean {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execSync(`${which} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasGlobalBinary(): boolean {
  return commandExists("claudecompress");
}

/**
 * Find the installed JS entrypoint so we can invoke it via `bun <path>`.
 * Falls back to null if we can't resolve — caller should use the plain
 * `claudecompress` PATH binary in that case.
 */
function findSelfEntry(): string | null {
  // argv[1] points at the script we were started with. When the user runs
  // `claudecompress install` through a global npm/bun bin, node resolves the
  // .cmd/symlink and argv[1] is the real dist/index.js path. That's exactly
  // what we want to hand to `bun`.
  const self = process.argv[1];
  if (self && /\.(js|mjs|cjs|ts)$/.test(self)) return self;
  return null;
}

function quoteArg(s: string): string {
  // Windows paths commonly have spaces (Program Files…). Quote everywhere
  // for safety — settings.json hook/command strings are parsed by a shell.
  if (!/[\s"]/.test(s)) return s;
  if (process.platform === "win32") return `"${s.replace(/"/g, '\\"')}"`;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function detectHookCommand(): string {
  // Hook fires once per /compress invocation — startup cost is irrelevant.
  // Prefer the plain CLI when on PATH, else npx as a fallback.
  return hasGlobalBinary()
    ? "claudecompress hook"
    : "npx -y claudecompress hook";
}

/**
 * StatusLine runs every refreshInterval seconds, so startup cost matters.
 * Preference order (fastest → slowest):
 *   1. `bun <self>.js statusline`           — ~10-15ms startup, preferred
 *   2. `claudecompress statusline`          — ~30-50ms (node shebang), fine
 *   null → not on PATH at all, skip install with guidance.
 */
function detectStatuslineCommand(): { cmd: string; viaBun: boolean } | null {
  if (!hasGlobalBinary()) return null;
  const self = findSelfEntry();
  if (self && commandExists("bun")) {
    return { cmd: `bun ${quoteArg(self)} statusline`, viaBun: true };
  }
  return { cmd: "claudecompress statusline", viaBun: false };
}

function readSettings(): any {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) ?? {};
  } catch {
    throw new Error(
      `Could not parse ${SETTINGS_PATH}. Fix or move the file, then retry.`,
    );
  }
}

function backup(path: string): string | null {
  if (!existsSync(path)) return null;
  const backupPath = `${path}.claudecompress.bak`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function writeSettings(settings: any): string | null {
  const b = backup(SETTINGS_PATH);
  mkdirSync(CLAUDE_HOME, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return b;
}

function hasExistingHook(settings: any): boolean {
  const list = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(list)) return false;
  return list.some(
    (h: any) =>
      Array.isArray(h?.hooks) &&
      h.hooks.some((x: any) => x?.command?.includes(HOOK_TAG)),
  );
}

function addHook(settings: any, command: string): void {
  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit ??= [];
  settings.hooks.UserPromptSubmit.push({
    matcher: HOOK_MATCHER,
    hooks: [{ type: "command", command }],
  });
}

function removeHook(settings: any): number {
  const list = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(list)) return 0;
  const before = list.length;
  settings.hooks.UserPromptSubmit = list.filter(
    (h: any) =>
      !(
        Array.isArray(h?.hooks) &&
        h.hooks.some((x: any) => x?.command?.includes(HOOK_TAG))
      ),
  );
  return before - settings.hooks.UserPromptSubmit.length;
}

function writeSlashCommandFile(): void {
  mkdirSync(dirname(COMMAND_PATH), { recursive: true });
  const body = `---
description: Compress the active Claude Code session for cheaper cold /resume (handled by claudecompress hook).
argument-hint: "[ultra|smart|focus|recency|truncate] [N]"
---

Handled by the claudecompress UserPromptSubmit hook. If you are reading this
message it means the hook did not run — see https://github.com/bihanikeshav/ClaudeCompress
`;
  writeFileSync(COMMAND_PATH, body);
}

// Plan step-by-step: decide what the hook change would be without writing yet,
// so the outer flow can show a clear confirm and skip-both cleanly.
type HookDecision =
  | { kind: "install"; command: string; viaNpx: boolean }
  | { kind: "reinstall"; command: string; viaNpx: boolean }
  | { kind: "skip"; reason: string };

async function planHook(settings: any): Promise<HookDecision | null> {
  const command = detectHookCommand();
  const viaNpx = command.startsWith("npx");
  if (hasExistingHook(settings)) {
    const reinstall = await p.confirm({
      message:
        "A /compress hook is already installed. Reinstall with updated command?",
      initialValue: false,
    });
    if (p.isCancel(reinstall)) return null;
    return reinstall
      ? { kind: "reinstall", command, viaNpx }
      : { kind: "skip", reason: "kept existing /compress hook" };
  }
  const go = await p.confirm({
    message: `Install the /compress slash command hook?  ${pc.dim(`(${command})`)}`,
    initialValue: true,
  });
  if (p.isCancel(go)) return null;
  return go
    ? { kind: "install", command, viaNpx }
    : { kind: "skip", reason: "skipped /compress hook (run `claudecompress install-hook` to add later)" };
}

// Claude Code statusLine supports `refreshInterval` in seconds (min 1) for
// time-based polling on top of its event-driven refreshes. We always use 1s
// since we require a global install — cold-start is ~30-50ms, trivial at 1Hz.
const REFRESH_INTERVAL = 1;

type StatusDecision =
  | {
      kind: "install";
      command: string;
      refreshInterval: number;
      viaBun: boolean;
    }
  | { kind: "skip"; reason: string };

async function planStatusline(settings: any): Promise<StatusDecision | null> {
  const detected = detectStatuslineCommand();
  if (!detected) {
    return {
      kind: "skip",
      reason:
        "cache timer needs a global install — run `bun add -g claudecompress` (or `npm i -g claudecompress`), then `claudecompress install-statusline`",
    };
  }
  const { cmd: command, viaBun } = detected;
  const hint = viaBun
    ? pc.dim(`(bun, refresh every ${REFRESH_INTERVAL}s)`)
    : pc.dim(`(refresh every ${REFRESH_INTERVAL}s — install bun for faster ticks)`);

  const existing = settings.statusLine;
  const existingIsOurs =
    typeof existing?.command === "string" &&
    existing.command.includes(STATUSLINE_TAG);

  if (existingIsOurs) {
    const refresh = await p.confirm({
      message: "claudecompress statusLine is already installed. Refresh command?",
      initialValue: false,
    });
    if (p.isCancel(refresh)) return null;
    return refresh
      ? { kind: "install", command, viaBun, refreshInterval: REFRESH_INTERVAL }
      : { kind: "skip", reason: "kept existing claudecompress statusLine" };
  }

  if (existing) {
    const overwrite = await p.confirm({
      message: `A custom statusLine is set (${pc.dim(existing.command ?? JSON.stringify(existing))}). Replace with claudecompress cache timer?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite)) return null;
    return overwrite
      ? { kind: "install", command, viaBun, refreshInterval: REFRESH_INTERVAL }
      : { kind: "skip", reason: "kept your existing statusLine" };
  }

  const go = await p.confirm({
    message: `Install the cache-timer statusLine?  ${hint}`,
    initialValue: true,
  });
  if (p.isCancel(go)) return null;
  return go
    ? { kind: "install", command, viaBun, refreshInterval: REFRESH_INTERVAL }
    : { kind: "skip", reason: "skipped cache timer (run `claudecompress install-statusline` to add later)" };
}

export async function install(): Promise<void> {
  console.clear();
  p.intro(pc.bgCyan(pc.black(" claudecompress install ")));

  let settings: any;
  try {
    settings = readSettings();
  } catch (err) {
    p.log.error(String(err instanceof Error ? err.message : err));
    return;
  }

  const hookDecision = await planHook(settings);
  if (!hookDecision) return p.cancel("Aborted.");

  const statusDecision = await planStatusline(settings);
  if (!statusDecision) return p.cancel("Aborted.");

  if (
    hookDecision.kind === "skip" &&
    statusDecision.kind === "skip"
  ) {
    p.log.info("Nothing to do.");
    p.outro("Done.");
    return;
  }

  // Apply changes
  if (hookDecision.kind === "reinstall") removeHook(settings);
  if (
    hookDecision.kind === "install" ||
    hookDecision.kind === "reinstall"
  ) {
    addHook(settings, hookDecision.command);
    writeSlashCommandFile();
  }
  if (statusDecision.kind === "install") {
    settings.statusLine = {
      type: "command",
      command: statusDecision.command,
      refreshInterval: statusDecision.refreshInterval,
    };
  }

  const b = writeSettings(settings);
  if (b) p.log.info(`Backed up previous settings to ${b}`);

  if (
    hookDecision.kind === "install" ||
    hookDecision.kind === "reinstall"
  ) {
    p.log.success(
      `Installed /compress hook${hookDecision.viaNpx ? pc.dim(" (via npx)") : ""}`,
    );
  } else {
    p.log.warn(hookDecision.reason);
  }
  if (statusDecision.kind === "install") {
    p.log.success(
      `Installed cache-timer statusLine · ${statusDecision.viaBun ? "bun" : "node"} · refresh every ${statusDecision.refreshInterval}s`,
    );
    if (!statusDecision.viaBun) {
      p.log.info(
        pc.dim(
          "Tip: install bun (https://bun.sh) — faster startup makes the countdown feel smoother.",
        ),
      );
    }
  } else {
    p.log.warn(statusDecision.reason);
  }

  p.log.info("Restart Claude Code to pick up the new settings.");
  p.outro(pc.green("Done."));
}

/**
 * Standalone installer for the statusLine only. Useful when the user skipped
 * it during the main install and wants to add it later.
 */
export async function installStatusline(): Promise<void> {
  console.clear();
  p.intro(pc.bgCyan(pc.black(" claudecompress install-statusline ")));

  let settings: any;
  try {
    settings = readSettings();
  } catch (err) {
    p.log.error(String(err instanceof Error ? err.message : err));
    return;
  }

  const decision = await planStatusline(settings);
  if (!decision) return p.cancel("Aborted.");
  if (decision.kind === "skip") {
    p.log.warn(decision.reason);
    p.outro("Done.");
    return;
  }

  settings.statusLine = {
    type: "command",
    command: decision.command,
    refreshInterval: decision.refreshInterval,
  };
  const b = writeSettings(settings);
  if (b) p.log.info(`Backed up previous settings to ${b}`);
  p.log.success(
    `Installed cache-timer statusLine · ${decision.viaBun ? "bun" : "node"} · refresh every ${decision.refreshInterval}s`,
  );
  if (!decision.viaBun) {
    p.log.info(
      pc.dim(
        "Tip: install bun (https://bun.sh) — faster startup makes the countdown feel smoother.",
      ),
    );
  }
  p.log.info("Restart Claude Code to see it.");
  p.outro(pc.green("Done."));
}

/**
 * Standalone installer for the /compress hook only.
 */
export async function installHook(): Promise<void> {
  console.clear();
  p.intro(pc.bgCyan(pc.black(" claudecompress install-hook ")));

  let settings: any;
  try {
    settings = readSettings();
  } catch (err) {
    p.log.error(String(err instanceof Error ? err.message : err));
    return;
  }

  const decision = await planHook(settings);
  if (!decision) return p.cancel("Aborted.");
  if (decision.kind === "skip") {
    p.log.warn(decision.reason);
    p.outro("Done.");
    return;
  }

  if (decision.kind === "reinstall") removeHook(settings);
  addHook(settings, decision.command);
  writeSlashCommandFile();
  const b = writeSettings(settings);
  if (b) p.log.info(`Backed up previous settings to ${b}`);
  p.log.success(
    `Installed /compress hook${decision.viaNpx ? pc.dim(" (via npx)") : ""}`,
  );
  p.log.info("Restart Claude Code to pick it up.");
  p.outro(pc.green("Done."));
}

export async function uninstall(): Promise<void> {
  console.clear();
  p.intro(pc.bgCyan(pc.black(" claudecompress uninstall ")));

  if (!existsSync(SETTINGS_PATH)) {
    p.log.info("No settings.json; nothing to uninstall.");
    return;
  }
  let settings: any;
  try {
    settings = readSettings();
  } catch (err) {
    p.log.error(String(err instanceof Error ? err.message : err));
    return;
  }
  const removed = removeHook(settings);
  let removedStatusline = false;
  if (settings.statusLine?.command?.includes(STATUSLINE_TAG)) {
    delete settings.statusLine;
    removedStatusline = true;
  }
  if (removed === 0 && !removedStatusline) {
    p.log.info("No claudecompress hook or statusLine found.");
    return;
  }
  const b = writeSettings(settings);
  if (b) p.log.info(`Backed up previous settings to ${b}`);
  if (removed > 0)
    p.log.success(
      `Removed ${removed} claudecompress hook entr${removed === 1 ? "y" : "ies"}.`,
    );
  if (removedStatusline) p.log.success("Removed claudecompress statusLine.");
  p.outro(pc.green("Done."));
}
