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

function hasGlobalBinary(): boolean {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execSync(`${which} claudecompress`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectHookCommand(): string {
  // Hook fires only on /compress prompts — npx cold-start is tolerable,
  // but we still prefer a global binary for speed.
  return hasGlobalBinary()
    ? "claudecompress hook"
    : "npx -y claudecompress hook";
}

function detectStatuslineCommand(): { cmd: string; viaNpx: boolean } {
  // Claude Code invokes the statusline on its own cadence (event-driven after
  // turns/refreshes, not sub-second polling), and the output is computed from
  // a timestamp in the JSONL — so we don't poll internally either. That means
  // npx cold-start only costs one delay per Claude Code refresh, which is
  // tolerable. Still prefer a global binary when available.
  if (hasGlobalBinary()) return { cmd: "claudecompress statusline", viaNpx: false };
  return { cmd: "npx -y claudecompress statusline", viaNpx: true };
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

  if (hasExistingHook(settings)) {
    p.log.info("A /compress hook is already installed.");
    const reinstall = await p.confirm({
      message: "Reinstall with updated command?",
      initialValue: false,
    });
    if (p.isCancel(reinstall) || !reinstall) return p.cancel("Aborted.");
    removeHook(settings);
  }

  const hookCommand = detectHookCommand();
  const usingNpx = hookCommand.startsWith("npx");
  p.log.info(
    `Hook command: ${pc.cyan(hookCommand)}${usingNpx ? pc.yellow("  (slow cold-start — consider: bun add -g claudecompress)") : ""}`,
  );

  const confirm = await p.confirm({
    message: `Install /compress hook into ${SETTINGS_PATH}?`,
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) return p.cancel("Aborted.");

  const b = backup(SETTINGS_PATH);
  addHook(settings, hookCommand);

  // Statusline (cache timer) — default on
  const { cmd: statuslineCmd, viaNpx: statuslineViaNpx } =
    detectStatuslineCommand();
  let statuslineInstalled = false;
  let statuslineSkippedReason: string | null = null;

  const existing = settings.statusLine;
  const existingIsOurs =
    existing?.command?.includes(STATUSLINE_TAG) ?? false;

  if (!existing) {
    settings.statusLine = { type: "command", command: statuslineCmd };
    statuslineInstalled = true;
  } else if (existingIsOurs) {
    settings.statusLine.command = statuslineCmd; // refresh to latest form
    statuslineInstalled = true;
  } else {
    const overwrite = await p.confirm({
      message: `A custom statusLine is already set (${pc.dim(existing.command ?? JSON.stringify(existing))}). Replace with claudecompress cache timer?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite)) return p.cancel("Aborted.");
    if (overwrite) {
      settings.statusLine = { type: "command", command: statuslineCmd };
      statuslineInstalled = true;
    } else {
      statuslineSkippedReason = "kept your existing statusLine";
    }
  }

  mkdirSync(CLAUDE_HOME, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  writeSlashCommandFile();

  if (b) p.log.info(`Backed up previous settings to ${b}`);
  p.log.success(`Installed /compress hook and ${COMMAND_PATH}.`);
  if (statuslineInstalled) {
    p.log.success(
      "Installed cache timer statusLine (shows ttl remaining inside claude's UI).",
    );
    if (statuslineViaNpx) {
      p.log.info(
        pc.dim(
          "statusLine uses npx — works fine, but `bun add -g claudecompress` makes it snappier.",
        ),
      );
    }
  } else if (statuslineSkippedReason) {
    p.log.warn(`Skipped cache timer statusLine — ${statuslineSkippedReason}`);
  }
  p.log.info(
    "Restart Claude Code, then type /compress inside any session to trim it.",
  );
  p.log.info(
    `Usage: /compress  ·  /compress ultra  ·  /compress focus 20  ·  /compress recency 10  ·  /compress smart  ·  /compress truncate 500`,
  );
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
  const b = backup(SETTINGS_PATH);
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  if (b) p.log.info(`Backed up previous settings to ${b}`);
  if (removed > 0)
    p.log.success(`Removed ${removed} claudecompress hook entr${removed === 1 ? "y" : "ies"}.`);
  if (removedStatusline) p.log.success("Removed claudecompress statusLine.");
  p.outro(pc.green("Done."));
}
