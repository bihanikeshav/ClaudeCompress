import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";

export const CLAUDE_HOME = join(homedir(), ".claude");
export const PROJECTS_DIR = join(CLAUDE_HOME, "projects");

/**
 * Claude Code encodes project paths by replacing `:`, `/`, and `\` with `-`.
 * Example: `Z:\CC_Resume` → `Z--CC-Resume`
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
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
