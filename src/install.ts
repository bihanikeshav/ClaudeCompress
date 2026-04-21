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

function detectHookCommand(): string {
  // Prefer an on-PATH binary (global install) for fast startup.
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execSync(`${which} claudecompress`, { stdio: "ignore" });
    return "claudecompress hook";
  } catch {
    // Fall back to npx, slower cold-start but works without global install.
    return "npx -y claudecompress hook";
  }
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
  mkdirSync(CLAUDE_HOME, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  writeSlashCommandFile();

  if (b) p.log.info(`Backed up previous settings to ${b}`);
  p.log.success(`Installed /compress hook and ${COMMAND_PATH}.`);
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
  if (removed === 0) {
    p.log.info("No claudecompress hook found.");
    return;
  }
  const b = backup(SETTINGS_PATH);
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  if (b) p.log.info(`Backed up previous settings to ${b}`);
  p.log.success(`Removed ${removed} claudecompress hook entr${removed === 1 ? "y" : "ies"}.`);
  p.outro(pc.green("Done."));
}
