import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";

export const CLAUDE_HOME = join(homedir(), ".claude");
export const PROJECTS_DIR = join(CLAUDE_HOME, "projects");

/**
 * Claude Code encodes project paths by replacing every non-alphanumeric
 * character with `-`. Underscores included.
 * Example: `Z:\CC_Resume` → `Z--CC-Resume`   (: → -, \ → -, _ → -)
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectDirForCwd(cwd: string = process.cwd()): string {
  return join(PROJECTS_DIR, encodeCwd(cwd));
}

export function listProjects(): { name: string; path: string; bytes: number; files: number }[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const rows: { name: string; path: string; bytes: number; files: number }[] = [];
  for (const name of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let bytes = 0;
    let files = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const s = statSync(join(dir, f));
        bytes += s.size;
        files += 1;
      } catch {
        // ignore
      }
    }
    if (files > 0) rows.push({ name, path: dir, bytes, files });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows;
}

export function listSessions(projectDir: string): string[] {
  if (!existsSync(projectDir)) return [];
  const files: { path: string; mtime: number }[] = [];
  for (const f of readdirSync(projectDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(projectDir, f);
    try {
      const s = statSync(p);
      if (s.isFile()) files.push({ path: p, mtime: s.mtimeMs });
    } catch {
      // skip
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.map((f) => f.path);
}

export type CacheState = "warm" | "cold" | "very-cold";

export interface Staleness {
  minutesAgo: number;
  state: CacheState;
  label: string;
}

export function staleness(mtime: Date, now: Date = new Date()): Staleness {
  const minutesAgo = Math.max(0, (now.getTime() - mtime.getTime()) / 60000);
  let state: CacheState;
  if (minutesAgo < 5) state = "warm";
  else if (minutesAgo < 60) state = "cold";
  else state = "very-cold";

  const label = formatAge(minutesAgo);
  return { minutesAgo, state, label };
}

function formatAge(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s ago`;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(2)} ${units[i]}`;
}
