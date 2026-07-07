/**
 * `claudecompress diff` — render original vs trimmed session as a
 * self-contained HTML report showing exactly what a trim removed.
 *
 * Trust-builder for lossy modes: users can audit every byte the trimmer
 * touched before pointing /resume at the trimmed file. Records align by
 * uuid (the trimmer never rewrites uuids, only sessionId/parentUuid), so
 * original-vs-trimmed pairing is exact even when slim mode reparents.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, basename } from "node:path";
import pc from "picocolors";
import { readHistory, HISTORY_DIR } from "./history.ts";
import { humanBytes } from "./paths.ts";

// Cap each rendered snippet. A 2MB Read output rendered in full would make
// the report itself the context bloat we're diagnosing.
const SNIPPET_CAP = 4096;

export interface PerToolSaving {
  tool: string;
  /** Content blocks (tool_use inputs + tool_result outputs) that shrank or vanished. */
  blocks: number;
  bytesSaved: number;
}

export interface DiffStats {
  bytesBefore: number;
  bytesAfter: number;
  unchanged: number;
  modified: number;
  dropped: number;
  /** JSON bytes of records absent from the trimmed file. */
  droppedBytes: number;
  /** Sum of positive per-record JSON byte deltas across modified records. */
  modifiedBytesSaved: number;
  perTool: PerToolSaving[];
}

// ---------------------------------------------------------------------------
// Parsing and alignment
// ---------------------------------------------------------------------------

function parseJsonl(path: string): any[] {
  const out: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* malformed — invisible to the diff */ }
  }
  return out;
}

/**
 * sessionId is rewritten on every trim and slim mode reparents via
 * parentUuid — both are bookkeeping, not content. Strip them before
 * comparing or every record would read as "modified".
 */
function normalized(rec: any): string {
  const copy = { ...rec };
  delete copy.sessionId;
  delete copy.parentUuid;
  return JSON.stringify(copy);
}

function jsonBytes(v: any): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

/**
 * Normalize message content to a block list so string-content and
 * array-content records diff through the same path. String content becomes
 * a single pseudo text block, which also lets the [TRIMMED …] marker
 * injection align against the original first text block.
 */
function contentBlocks(rec: any): any[] {
  const c = rec?.message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (Array.isArray(c)) return c.filter((b) => b && typeof b === "object");
  return [];
}

/**
 * Alignment key for a content block. tool_use / tool_result carry stable
 * ids; everything else aligns by type + occurrence order.
 */
function blockKey(blk: any, occurrence: Map<string, number>): string {
  if (blk.type === "tool_use" && blk.id) return `tool_use:${blk.id}`;
  if (blk.type === "tool_result" && blk.tool_use_id) return `tool_result:${blk.tool_use_id}`;
  const n = occurrence.get(blk.type) ?? 0;
  occurrence.set(blk.type, n + 1);
  return `${blk.type}#${n}`;
}

function keyedBlocks(rec: any): Map<string, any> {
  const occ = new Map<string, number>();
  const out = new Map<string, any>();
  for (const blk of contentBlocks(rec)) out.set(blockKey(blk, occ), blk);
  return out;
}

/** Human-readable body of a content block, for display only. */
function blockText(blk: any): string {
  if (blk.type === "text" && typeof blk.text === "string") return blk.text;
  if (blk.type === "thinking" && typeof blk.thinking === "string") return blk.thinking;
  if (blk.type === "tool_use") return JSON.stringify(blk.input ?? {}, null, 1);
  if (blk.type === "tool_result") {
    const c = blk.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((b: any) => (b?.type === "text" ? b.text : `[${b?.type ?? "?"}]`))
        .join("\n");
    }
    return JSON.stringify(c);
  }
  if (blk.type === "image") return "[image]";
  return JSON.stringify(blk);
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function snippet(s: string): string {
  if (s.length <= SNIPPET_CAP) return esc(s);
  return (
    esc(s.slice(0, SNIPPET_CAP)) +
    `\n<span class="cap-note">… showing first ${SNIPPET_CAP} of ${s.length} chars</span>`
  );
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.5rem; max-width: 72rem; margin-inline: auto;
  font: 14px/1.5 system-ui, -apple-system, sans-serif;
  background: #fafafa; color: #1a1a1a;
}
h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
.sub { color: #666; font-size: .85rem; margin-bottom: 1.25rem; word-break: break-all; }
.cards { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.25rem; }
.card {
  background: #fff; border: 1px solid #ddd; border-radius: 8px;
  padding: .6rem .9rem; min-width: 8rem;
}
.card .k { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: #777; }
.card .v { font-size: 1.15rem; font-weight: 600; }
table { border-collapse: collapse; margin-bottom: 1.5rem; font-size: .85rem; }
th, td { text-align: left; padding: .3rem .8rem; border-bottom: 1px solid #ddd; }
th { color: #666; font-weight: 600; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
details {
  background: #fff; border: 1px solid #ddd; border-radius: 8px;
  margin-bottom: .5rem; overflow: hidden;
}
summary { padding: .55rem .8rem; cursor: pointer; user-select: none; }
summary:hover { background: rgba(0,0,0,.03); }
.badge {
  display: inline-block; font-size: .7rem; font-weight: 600; border-radius: 4px;
  padding: .1rem .4rem; margin-right: .5rem; vertical-align: 1px;
}
.badge.dropped  { background: #fde8e8; color: #b42318; }
.badge.modified { background: #fef0c7; color: #93600a; }
.role { color: #666; font-size: .8rem; }
.delta { float: right; color: #067647; font-size: .8rem; font-variant-numeric: tabular-nums; }
.body { padding: .4rem .8rem .8rem; border-top: 1px solid #eee; }
.blk { margin-bottom: .7rem; }
.blk-h { font-size: .75rem; color: #777; margin-bottom: .2rem; }
pre {
  margin: 0; padding: .5rem .6rem; border-radius: 6px; overflow-x: auto;
  font: 12px/1.45 ui-monospace, Consolas, monospace;
  white-space: pre-wrap; word-break: break-word;
}
pre.before { background: #fff5f5; border: 1px solid #f2caca; }
pre.after  { background: #f2fbf5; border: 1px solid #c5e8d0; }
.arrow { text-align: center; color: #999; font-size: .75rem; margin: .15rem 0; }
.cap-note { color: #999; font-style: italic; }
@media (prefers-color-scheme: dark) {
  body { background: #131316; color: #e4e4e7; }
  .sub, .card .k, .role, th, .blk-h { color: #9d9da6; }
  .card, details { background: #1c1c21; border-color: #33333b; }
  th, td { border-color: #33333b; }
  summary:hover { background: rgba(255,255,255,.04); }
  .badge.dropped  { background: #3a1d1d; color: #f4a9a0; }
  .badge.modified { background: #3a301a; color: #eec96a; }
  .delta { color: #6fce91; }
  .body { border-color: #2a2a30; }
  pre.before { background: #2a1c1c; border-color: #4b2b2b; }
  pre.after  { background: #1a2a20; border-color: #2b4b35; }
}
`;

// ---------------------------------------------------------------------------
// Core diff
// ---------------------------------------------------------------------------

export function buildDiffHtml(
  originalPath: string,
  trimmedPath: string,
): { html: string; stats: DiffStats } {
  const original = parseJsonl(originalPath);
  const trimmed = parseJsonl(trimmedPath);

  const byUuid = new Map<string, any>();
  const trimmedNormalized = new Set<string>();
  for (const rec of trimmed) {
    if (typeof rec?.uuid === "string") byUuid.set(rec.uuid, rec);
    trimmedNormalized.add(normalized(rec));
  }

  // tool_use id → tool name, from the ORIGINAL file (trimmed inputs may be
  // squashed but ids are stable). Same derivation as src/trimmer.ts.
  const toolNames = new Map<string, string>();
  for (const rec of original) {
    for (const blk of contentBlocks(rec)) {
      if (blk.type === "tool_use" && blk.id && blk.name) toolNames.set(blk.id, blk.name);
    }
  }
  const toolForBlock = (blk: any): string | undefined => {
    if (blk.type === "tool_use") return blk.name ?? toolNames.get(blk.id);
    if (blk.type === "tool_result") return toolNames.get(blk.tool_use_id) ?? "(unknown tool)";
    return undefined;
  };

  const stats: DiffStats = {
    bytesBefore: statSync(originalPath).size,
    bytesAfter: statSync(trimmedPath).size,
    unchanged: 0,
    modified: 0,
    dropped: 0,
    droppedBytes: 0,
    modifiedBytesSaved: 0,
    perTool: [],
  };
  const perTool = new Map<string, PerToolSaving>();
  const addToolSaving = (tool: string | undefined, bytes: number) => {
    if (!tool || bytes <= 0) return;
    const row = perTool.get(tool) ?? { tool, blocks: 0, bytesSaved: 0 };
    row.blocks += 1;
    row.bytesSaved += bytes;
    perTool.set(tool, row);
  };

  const entries: string[] = [];

  const recordSummary = (
    idx: number,
    rec: any,
    kind: "dropped" | "modified",
    tools: string[],
    saved: number,
  ): string => {
    const role = rec?.type ?? rec?.message?.role ?? "record";
    const toolLabel = tools.length ? ` · ${esc([...new Set(tools)].join(", "))}` : "";
    return (
      `<span class="badge ${kind}">${kind}</span>` +
      `<span class="role">#${idx} ${esc(String(role))}${toolLabel}</span>` +
      (saved > 0 ? `<span class="delta">−${esc(humanBytes(saved))}</span>` : "")
    );
  };

  original.forEach((rec, idx) => {
    const uuid = typeof rec?.uuid === "string" ? rec.uuid : undefined;
    const counterpart = uuid ? byUuid.get(uuid) : undefined;

    // uuid-less records (harness metadata) can only match by content.
    if (!uuid && trimmedNormalized.has(normalized(rec))) {
      stats.unchanged += 1;
      return;
    }

    if (!counterpart) {
      stats.dropped += 1;
      const bytes = jsonBytes(rec);
      stats.droppedBytes += bytes;
      const tools: string[] = [];
      const parts: string[] = [];
      for (const blk of contentBlocks(rec)) {
        const tool = toolForBlock(blk);
        if (tool) { tools.push(tool); addToolSaving(tool, jsonBytes(blk)); }
        parts.push(
          `<div class="blk"><div class="blk-h">${esc(blk.type)}${tool ? ` · ${esc(tool)}` : ""} (removed)</div>` +
          `<pre class="before">${snippet(blockText(blk))}</pre></div>`,
        );
      }
      if (parts.length === 0) {
        parts.push(`<div class="blk"><pre class="before">${snippet(JSON.stringify(rec, null, 1))}</pre></div>`);
      }
      entries.push(
        `<details><summary>${recordSummary(idx, rec, "dropped", tools, bytes)}</summary>` +
        `<div class="body">${parts.join("")}</div></details>`,
      );
      return;
    }

    if (normalized(rec) === normalized(counterpart)) {
      stats.unchanged += 1;
      return;
    }

    stats.modified += 1;
    const saved = Math.max(0, jsonBytes(rec) - jsonBytes(counterpart));
    stats.modifiedBytesSaved += saved;

    const after = keyedBlocks(counterpart);
    const occ = new Map<string, number>();
    const seen = new Set<string>();
    const tools: string[] = [];
    const parts: string[] = [];
    for (const blk of contentBlocks(rec)) {
      const key = blockKey(blk, occ);
      seen.add(key);
      const other = after.get(key);
      const tool = toolForBlock(blk);
      if (other !== undefined && JSON.stringify(blk) === JSON.stringify(other)) continue;
      if (tool) tools.push(tool);
      const head = `<div class="blk-h">${esc(blk.type)}${tool ? ` · ${esc(tool)}` : ""}${other === undefined ? " (removed)" : ""}</div>`;
      if (other === undefined) {
        addToolSaving(tool, jsonBytes(blk));
        parts.push(`<div class="blk">${head}<pre class="before">${snippet(blockText(blk))}</pre></div>`);
      } else {
        addToolSaving(tool, jsonBytes(blk) - jsonBytes(other));
        parts.push(
          `<div class="blk">${head}` +
          `<pre class="before">${snippet(blockText(blk))}</pre>` +
          `<div class="arrow">↓ after trim</div>` +
          `<pre class="after">${snippet(blockText(other))}</pre></div>`,
        );
      }
    }
    // Blocks present only in the trimmed record (e.g. an injected marker
    // text block when the original first text block was elsewhere).
    for (const [key, blk] of after) {
      if (seen.has(key)) continue;
      parts.push(
        `<div class="blk"><div class="blk-h">${esc(blk.type)} (added)</div>` +
        `<pre class="after">${snippet(blockText(blk))}</pre></div>`,
      );
    }
    entries.push(
      `<details><summary>${recordSummary(idx, rec, "modified", tools, saved)}</summary>` +
      `<div class="body">${parts.join("")}</div></details>`,
    );
  });

  stats.perTool = [...perTool.values()].sort((a, b) => b.bytesSaved - a.bytesSaved);

  const savedTotal = Math.max(0, stats.bytesBefore - stats.bytesAfter);
  const pct = stats.bytesBefore > 0 ? ((savedTotal / stats.bytesBefore) * 100).toFixed(1) : "0";
  const card = (k: string, v: string) =>
    `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;

  const toolRows = stats.perTool
    .map(
      (t) =>
        `<tr><td>${esc(t.tool)}</td><td class="num">${t.blocks}</td>` +
        `<td class="num">${esc(humanBytes(t.bytesSaved))}</td></tr>`,
    )
    .join("");
  const toolTable = toolRows
    ? `<table><thead><tr><th>Tool</th><th>Blocks touched</th><th>Bytes saved</th></tr></thead>` +
      `<tbody>${toolRows}</tbody></table>`
    : `<p class="sub">No tool inputs/outputs were elided or truncated.</p>`;

  const html =
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>claudecompress diff — ${esc(basename(trimmedPath))}</title>` +
    `<style>${CSS}</style>` +
    `<h1>What the trim removed</h1>` +
    `<div class="sub">${esc(originalPath)} → ${esc(trimmedPath)}</div>` +
    `<div class="cards">` +
    card("Before", humanBytes(stats.bytesBefore)) +
    card("After", humanBytes(stats.bytesAfter)) +
    card("Saved", `${humanBytes(savedTotal)} (${pct}%)`) +
    card("Unchanged", String(stats.unchanged)) +
    card("Modified", `${stats.modified} (−${humanBytes(stats.modifiedBytesSaved)})`) +
    card("Dropped", `${stats.dropped} (−${humanBytes(stats.droppedBytes)})`) +
    `</div>` +
    `<h1>Savings by tool</h1>` +
    toolTable +
    `<h1>Changed records</h1>` +
    (entries.length ? entries.join("\n") : `<p class="sub">Nothing changed — the trim was a pure passthrough.</p>`);

  return { html, stats };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function samePath(a: string, b: string): boolean {
  const ra = resolve(a);
  const rb = resolve(b);
  // Windows paths are case-insensitive; history entries may differ in casing.
  return process.platform === "win32"
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

export type Resolved = { originalPath: string; trimmedPath: string } | { error: string };

function resolveDiffPair(args: string[]): Resolved {
  if (args.length >= 2) {
    return { originalPath: resolve(args[0]!), trimmedPath: resolve(args[1]!) };
  }
  const history = readHistory();
  if (args.length === 1) {
    const arg = args[0]!;
    if (existsSync(arg)) {
      const entry = [...history].reverse().find((e) => samePath(e.outputPath, arg));
      if (!entry) {
        return {
          error:
            `No trim history entry found for ${resolve(arg)}.\n` +
            `Pass both paths: claudecompress diff <original.jsonl> <trimmed.jsonl>`,
        };
      }
      return { originalPath: entry.sourcePath, trimmedPath: entry.outputPath };
    }
    // Session hash (full or prefix) of a trimmed file.
    const needle = arg.toLowerCase();
    const entry = [...history]
      .reverse()
      .find((e) => basename(e.outputPath, ".jsonl").toLowerCase().startsWith(needle));
    if (!entry) {
      return {
        error:
          `"${arg}" is neither an existing file nor a session hash from trim history.\n` +
          `Run "claudecompress diff <original.jsonl> <trimmed.jsonl>" with explicit paths.`,
      };
    }
    return { originalPath: entry.sourcePath, trimmedPath: entry.outputPath };
  }
  const last = history[history.length - 1];
  if (!last) {
    return {
      error:
        "No trim history yet — nothing to diff.\n" +
        "Run a trim first, or pass paths: claudecompress diff <original.jsonl> <trimmed.jsonl>",
    };
  }
  return { originalPath: last.sourcePath, trimmedPath: last.outputPath };
}

/**
 * Best-effort browser launch. Skipped in CI and non-interactive contexts
 * (pipes) unless forced — the /diff slash command runs inside a hook
 * (never a TTY) but the user explicitly asked to SEE the report, so the
 * hook passes force=true. Printing the path is the contract either way.
 */
export function openInBrowser(path: string, force = false): void {
  if (!force && (process.env.CI || !process.stdout.isTTY)) return;
  try {
    const [cmd, cmdArgs]: [string, string[]] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", path]] // empty "" = window title slot
        : process.platform === "darwin"
          ? ["open", [path]]
          : ["xdg-open", [path]];
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // launch is best-effort; the printed path is enough
  }
}

/** Render + persist the HTML report; shared by the CLI and the /diff hook. */
export function writeDiffReport(
  originalPath: string,
  trimmedPath: string,
): { outPath: string; stats: DiffStats } {
  const { html, stats } = buildDiffHtml(originalPath, trimmedPath);
  const diffsDir = join(HISTORY_DIR, "diffs");
  mkdirSync(diffsDir, { recursive: true });
  const outPath = join(diffsDir, `${basename(trimmedPath, ".jsonl")}.html`);
  writeFileSync(outPath, html, "utf8");
  return { outPath, stats };
}

/** Resolve which original/trimmed pair to diff; shared with the /diff hook. */
export function resolveDiffTarget(args: string[]): Resolved {
  return resolveDiffPair(args);
}

export async function runDiff(args: string[]): Promise<void> {
  const resolved = resolveDiffPair(args);
  if ("error" in resolved) {
    console.error(pc.red(resolved.error));
    process.exitCode = 1;
    return;
  }
  const { originalPath, trimmedPath } = resolved;
  for (const [label, p] of [["Original", originalPath], ["Trimmed", trimmedPath]] as const) {
    if (!existsSync(p)) {
      console.error(pc.red(`${label} file not found: ${p}`));
      process.exitCode = 1;
      return;
    }
  }

  const { outPath, stats } = writeDiffReport(originalPath, trimmedPath);

  console.log(
    `${pc.bold("diff report:")} ${stats.unchanged} unchanged · ` +
      `${stats.modified} modified · ${stats.dropped} dropped · ` +
      `${humanBytes(Math.max(0, stats.bytesBefore - stats.bytesAfter))} saved`,
  );
  console.log(pc.cyan(outPath));
  openInBrowser(outPath);
}
