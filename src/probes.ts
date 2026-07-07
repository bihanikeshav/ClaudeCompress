import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import pc from "picocolors";

import { trimSession } from "./trimmer.ts";
import type { TrimMode, TrimOptions } from "./types.ts";
import { isUserTextTurn } from "./records.ts";
import { roughContextTokens, resolveAuth } from "./tokenCounter.ts";
import { projectDirForCwd, listSessions } from "./paths.ts";
import { logError } from "./errorLog.ts";

/**
 * `claudecompress probe` — fidelity scoring for trim modes: how much of
 * the session's ground truth survives each mode, so "% saved" can be read
 * as "% saved at X% fidelity". Inspired by Factory.ai's compression evals:
 *
 *   - artifact probes: which files were created/modified (the most critical
 *     dimension — an agent that forgets what it changed re-does or undoes work)
 *   - recall probes: key facts (here: the user's recent asks and every error)
 *   - continuation probes: what should happen next (LLM-judged, --llm only)
 *
 * The deterministic probes need no network: extract ground truth from the
 * ORIGINAL jsonl, trim to a temp sibling per mode, re-extract from the
 * TRIMMED file, and score retention. `--llm` adds two Haiku questions per
 * mode against a compact rendering of the trimmed transcript.
 */

// ---------------------------------------------------------------------------
// Signal extraction (pure — operates on parsed records, testable offline)
// ---------------------------------------------------------------------------

/** Tools whose inputs identify a file the session created or modified. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface SessionSignals {
  /** Absolute-ish paths of files the session modified (order = first touch). */
  artifacts: string[];
  /** Tool names, one entry per tool_use invocation, in order. */
  toolSkeleton: string[];
  /** Last 10 genuine user text turns (full text, oldest → newest). */
  userAsks: string[];
  /** Snippet (first 120 chars) of each is_error tool_result. */
  errorSnippets: string[];
}

export interface RetentionScores {
  /** Fraction of modified file paths still discoverable in the trimmed transcript. */
  artifactRetention: number;
  /** Fraction of tool_use invocations (by name, multiset) still present. */
  toolSkeletonRetention: number;
  /** Fraction of recent user asks whose text survives at least half its length. */
  userAskRetention: number;
  /** Fraction of error snippets still present in trimmed error results. */
  errorRetention: number;
  /**
   * Char-survival of the last-5-turns' content (text, thinking, tool
   * results), matched per-record by uuid and NORMALIZED against the
   * lossless (squash-only) output — universal squash rewrites verbose
   * tool outputs in every mode by design, so raw survival would brand
   * even lossless as "lossy". 1.0 = the mode removes nothing recent
   * beyond squash; lower = it truncates recent bodies (smart's band-0
   * truncation was scoring "no measurable loss" without this dimension).
   */
  recentContentRetention: number;
}

/** Flatten a tool_result's content (string or block array) to plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Recursively collect every string leaf in a value (tool_use inputs). */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

export function extractSignals(records: any[]): SessionSignals {
  const artifacts: string[] = [];
  const artifactSeen = new Set<string>();
  const toolSkeleton: string[] = [];
  const allUserAsks: string[] = [];
  const errorSnippets: string[] = [];

  for (const rec of records) {
    if (isUserTextTurn(rec)) {
      allUserAsks.push(rec.message.content as string);
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!blk || typeof blk !== "object") continue;
      if (blk.type === "tool_use" && typeof blk.name === "string") {
        toolSkeleton.push(blk.name);
        if (WRITE_TOOLS.has(blk.name)) {
          // Edit/Write/MultiEdit carry file_path; NotebookEdit carries
          // notebook_path. MultiEdit's per-edit entries have no paths of
          // their own — the artifact is the input-level file_path.
          for (const key of ["file_path", "notebook_path"]) {
            const fp = blk.input?.[key];
            if (typeof fp === "string" && fp && !artifactSeen.has(fp)) {
              artifactSeen.add(fp);
              artifacts.push(fp);
            }
          }
        }
      } else if (blk.type === "tool_result" && blk.is_error) {
        const txt = toolResultText(blk.content).trim();
        if (txt) errorSnippets.push(txt.slice(0, 120));
      }
    }
  }

  return {
    artifacts,
    toolSkeleton,
    userAsks: allUserAsks.slice(-10),
    errorSnippets,
  };
}

// Markers the trimmer injects — stripped before comparing user text so a
// "[TRIMMED by claudecompress · …] fix the bug" record still matches the
// original "fix the bug" ask.
const TRIM_MARKER_RE = /^\[TRIMMED by claudecompress(?:\s*·\s*[^\]]+)?\]\s*/;
const TRUNCATION_MARKER_RE = /…\[truncated\]$/;

function cleanTrimArtifacts(s: string): string {
  let out = s;
  while (TRIM_MARKER_RE.test(out)) out = out.replace(TRIM_MARKER_RE, "");
  return out.replace(TRUNCATION_MARKER_RE, "");
}

/** Total content chars of a record's message (text, thinking, tool_result bodies). */
function contentChars(rec: any): number {
  const c = rec?.message?.content;
  if (typeof c === "string") return c.length;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const blk of c) {
    if (!blk || typeof blk !== "object") continue;
    if (typeof blk.text === "string") n += blk.text.length;
    else if (typeof blk.thinking === "string") n += blk.thinking.length;
    else if (blk.type === "tool_result") n += toolResultText(blk.content).length;
    else if (blk.type === "tool_use") n += JSON.stringify(blk.input ?? {}).length;
  }
  return n;
}

/**
 * Char-survival of the last N user turns' content, matched per-record by
 * uuid (trims never rewrite uuids). 1.0 = every byte of recent context
 * survives verbatim-or-longer; lower = a mode truncated recent bodies.
 */
export function recentContentRetention(
  origRecords: any[],
  trimmedRecords: any[],
  lastNTurns = 5,
): number {
  const turnIdx: number[] = [];
  origRecords.forEach((rec, i) => {
    if (isUserTextTurn(rec)) turnIdx.push(i);
  });
  const cut = turnIdx.length <= lastNTurns ? 0 : turnIdx[turnIdx.length - lastNTurns]!;
  const trimByUuid = new Map<string, number>();
  for (const rec of trimmedRecords) {
    if (typeof rec?.uuid === "string") trimByUuid.set(rec.uuid, contentChars(rec));
  }
  let orig = 0;
  let kept = 0;
  for (let i = cut; i < origRecords.length; i++) {
    const rec = origRecords[i];
    if (typeof rec?.uuid !== "string") continue;
    const o = contentChars(rec);
    orig += o;
    kept += Math.min(trimByUuid.get(rec.uuid) ?? 0, o);
  }
  return orig === 0 ? 1 : kept / orig;
}

/**
 * Score how much of `ground` (extracted from the ORIGINAL session) is still
 * present in `trimmedRecords` (parsed from the TRIMMED session). Empty
 * ground-truth dimensions score 1.0 — nothing to lose means nothing lost.
 */
export function scoreRetention(
  ground: SessionSignals,
  trimmedRecords: any[],
  origRecords?: any[],
): RetentionScores {
  const trimmed = extractSignals(trimmedRecords);

  // --- artifact retention: path discoverable ANYWHERE in the trimmed
  // transcript — still a tool_use input, or mentioned in any text.
  const corpus: string[] = [];
  const trimmedUserTexts: string[] = [];
  const trimmedErrorTexts: string[] = [];
  for (const rec of trimmedRecords) {
    const content = rec?.message?.content;
    if (typeof content === "string") {
      corpus.push(content);
      if (rec?.type === "user") trimmedUserTexts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!blk || typeof blk !== "object") continue;
      if (blk.type === "text" && typeof blk.text === "string") {
        corpus.push(blk.text);
        if (rec?.type === "user") trimmedUserTexts.push(blk.text);
      } else if (blk.type === "thinking" && typeof blk.thinking === "string") {
        corpus.push(blk.thinking);
      } else if (blk.type === "tool_use") {
        collectStrings(blk.input, corpus);
      } else if (blk.type === "tool_result") {
        const txt = toolResultText(blk.content);
        if (txt) {
          corpus.push(txt);
          if (blk.is_error) trimmedErrorTexts.push(txt);
        }
      }
    }
  }
  const haystack = corpus.join("\n");
  const trimmedArtifacts = new Set(trimmed.artifacts);
  const artifactHits = ground.artifacts.filter(
    (p) => trimmedArtifacts.has(p) || haystack.includes(p),
  ).length;

  // --- tool skeleton retention: multiset overlap of tool names. Order is
  // ignored (trims never reorder) — what matters is invocation counts.
  const countByName = (names: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
    return m;
  };
  const origCounts = countByName(ground.toolSkeleton);
  const trimCounts = countByName(trimmed.toolSkeleton);
  let skeletonHits = 0;
  for (const [name, c] of origCounts) {
    skeletonHits += Math.min(c, trimCounts.get(name) ?? 0);
  }

  // --- user ask retention: an ask survives when some trimmed user text,
  // after stripping trim/truncation markers, contains the original OR is a
  // prefix of it covering at least half its length.
  const cleanedUserTexts = trimmedUserTexts.map(cleanTrimArtifacts);
  const askSurvives = (ask: string): boolean =>
    cleanedUserTexts.some(
      (t) =>
        t.includes(ask) || (ask.startsWith(t) && t.length * 2 >= ask.length),
    );
  const askHits = ground.userAsks.filter(askSurvives).length;

  // --- error retention: the snippet's head (squash preserves heads) still
  // appears in some trimmed is_error result.
  const errorHits = ground.errorSnippets.filter((snip) => {
    const key = snip.slice(0, 60);
    return trimmedErrorTexts.some((t) => t.includes(key));
  }).length;

  const frac = (hits: number, total: number): number => (total === 0 ? 1 : hits / total);
  return {
    artifactRetention: frac(artifactHits, ground.artifacts.length),
    toolSkeletonRetention: frac(skeletonHits, ground.toolSkeleton.length),
    userAskRetention: frac(askHits, ground.userAsks.length),
    errorRetention: frac(errorHits, ground.errorSnippets.length),
    recentContentRetention: origRecords
      ? recentContentRetention(origRecords, trimmedRecords)
      : 1,
  };
}

/** Parse a JSONL session file into records, skipping malformed lines. */
export function readJsonlRecords(path: string): any[] {
  const out: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // malformed line — carries no probe signal
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM probes (--llm): can a cheap model recover ground truth from the trim?
// ---------------------------------------------------------------------------

const LLM_MODEL = "claude-haiku-4-5";
const TRANSCRIPT_CAP = 150_000;

/**
 * Compact plain-text rendering of a session for the LLM probes — dialog plus
 * tool_use names/inputs. Never raw JSONL: the probe measures whether the
 * *content* survives, not whether Haiku can parse transcript plumbing.
 */
export function renderTranscript(records: any[], cap = TRANSCRIPT_CAP): string {
  const lines: string[] = [];
  const push = (role: string, text: string) => {
    const t = text.trim();
    if (t) lines.push(`${role}: ${t}`);
  };
  for (const rec of records) {
    const t = rec?.type;
    if (t !== "user" && t !== "assistant") continue;
    const role = t === "user" ? "USER" : "ASSISTANT";
    const content = rec?.message?.content;
    if (typeof content === "string") {
      push(role, content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!blk || typeof blk !== "object") continue;
      if (blk.type === "text" && typeof blk.text === "string") {
        push(role, blk.text);
      } else if (blk.type === "tool_use") {
        let input = "";
        try {
          input = JSON.stringify(blk.input ?? {});
        } catch {
          input = "{}";
        }
        if (input.length > 600) input = input.slice(0, 600) + "…";
        lines.push(`TOOL_USE ${blk.name ?? "?"} ${input}`);
      } else if (blk.type === "tool_result") {
        let txt = toolResultText(blk.content);
        if (txt.length > 600) txt = txt.slice(0, 600) + "…";
        if (txt.trim()) lines.push(`TOOL_RESULT${blk.is_error ? " (error)" : ""}: ${txt.trim()}`);
      }
    }
  }
  const full = lines.join("\n");
  if (full.length <= cap) return full;
  // Keep both ends — artifacts cluster early/mid, continuation signal is at
  // the tail. Elide the middle explicitly so the model knows content is gone.
  const head = Math.floor(cap * 0.45);
  const tail = cap - head;
  return full.slice(0, head) + "\n[... transcript middle elided for length ...]\n" + full.slice(-tail);
}

const FILES_QUESTION =
  "List every file that was created or modified in this session. " +
  "Answer with one file path per line and nothing else.";
const CONTINUATION_QUESTION =
  "What was the user's most recent request, and what should happen next? Answer in 2-3 sentences.";

async function askHaiku(
  auth: Record<string, string>,
  transcript: string,
  question: string,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...auth,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content:
            "Below is a (possibly compressed) transcript of a coding session between a user and an AI agent.\n\n" +
            "<transcript>\n" + transcript + "\n</transcript>\n\n" + question,
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`messages ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n")
    .trim();
}

const normPath = (s: string): string => s.replace(/\\+/g, "/").toLowerCase();

/** Pull file-path-looking tokens out of a free-text LLM answer. */
export function extractPathCandidates(answer: string): string[] {
  const out = new Set<string>();
  for (const raw of answer.split(/\s+/)) {
    const tok = raw.replace(/^[`"'(\[\-*]+|[`"')\],:;.]+$/g, "");
    if (!tok || tok.length < 3) continue;
    const looksPathy =
      /[\\/]/.test(tok) || /^[\w.-]+\.[A-Za-z]\w{0,7}$/.test(tok);
    if (looksPathy && /\w/.test(tok)) out.add(tok);
  }
  return [...out];
}

/**
 * Score an LLM "list the modified files" answer against the ground-truth
 * artifact set. Matching is fuzzy on purpose: the model may answer with
 * relative paths or different slashes, so a candidate matches a ground path
 * when either (normalized) is a suffix of the other.
 */
export function scoreFileAnswer(
  answer: string,
  groundArtifacts: string[],
): { precision: number; recall: number } {
  const candidates = extractPathCandidates(answer).map(normPath);
  const ground = groundArtifacts.map(normPath);
  const matches = (a: string, b: string): boolean => a.endsWith(b) || b.endsWith(a);
  const recallHits = ground.filter((g) => candidates.some((c) => matches(g, c))).length;
  const precisionHits = candidates.filter((c) => ground.some((g) => matches(g, c))).length;
  return {
    precision: candidates.length === 0 ? (ground.length === 0 ? 1 : 0) : precisionHits / candidates.length,
    recall: ground.length === 0 ? 1 : recallHits / ground.length,
  };
}

interface LlmProbeResult {
  filePrecision: number;
  fileRecall: number;
  filesAnswer: string;
  continuation: string;
}

async function runLlmProbes(
  auth: Record<string, string>,
  trimmedRecords: any[],
  groundArtifacts: string[],
  mode: string,
): Promise<LlmProbeResult | null> {
  try {
    const transcript = renderTranscript(trimmedRecords);
    const filesAnswer = await askHaiku(auth, transcript, FILES_QUESTION);
    const continuation = await askHaiku(auth, transcript, CONTINUATION_QUESTION);
    const { precision, recall } = scoreFileAnswer(filesAnswer, groundArtifacts);
    return { filePrecision: precision, fileRecall: recall, filesAnswer, continuation };
  } catch (err) {
    logError("probes.runLlmProbes", err, { mode });
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ALL_MODES: TrimMode[] = ["lossless", "safe", "smart", "slim"];

function optsForMode(mode: TrimMode): TrimOptions {
  if (mode === "safe" || mode === "slim") {
    return { mode, keepLastN: 5, dropThinking: true };
  }
  return { mode };
}

function largestSessionInCwd(): string | null {
  const sessions = listSessions(projectDirForCwd());
  let best: string | null = null;
  let bestBytes = -1;
  for (const path of sessions) {
    try {
      const bytes = statSync(path).size;
      if (bytes > bestBytes) {
        bestBytes = bytes;
        best = path;
      }
    } catch {
      // race with deletion — skip
    }
  }
  return best;
}

const pct = (f: number): string => `${Math.round(f * 1000) / 10}%`;

function verdictFor(scores: RetentionScores): string {
  const dims: [string, number][] = [
    ["artifacts", scores.artifactRetention],
    ["tool skeleton", scores.toolSkeletonRetention],
    ["user asks", scores.userAskRetention],
    ["errors", scores.errorRetention],
    ["recent content", scores.recentContentRetention],
  ];
  dims.sort((a, b) => a[1] - b[1]);
  const [worstName, worst] = dims[0]!;
  if (worst >= 0.995) return "no measurable loss on deterministic probes";
  if (worst >= 0.9) return `high fidelity — weakest: ${worstName} (${pct(worst)})`;
  if (worst >= 0.7) return `moderate — ${worstName} drops to ${pct(worst)}`;
  return `lossy — ${worstName} down to ${pct(worst)}; use for savings, not continuity`;
}

export interface ProbeRow {
  mode: TrimMode;
  tokensAfter: number;
  savedPct: number;
  scores: RetentionScores;
  verdict: string;
}

/**
 * claude-code's /resume replays from the LAST compact summary record —
 * everything before it is dead weight the API never sees again. Ground
 * truth and retention must be scoped to this window, or a recently
 * /compact'ed session reports phantom losses (tool calls that were
 * already summarized away) and inflated totals.
 */
export function sliceFromLastCompact(records: any[]): { records: any[]; compacted: boolean } {
  let last = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.isCompactSummary === true) {
      last = i;
      break;
    }
  }
  return last >= 0
    ? { records: records.slice(last), compacted: true }
    : { records, compacted: false };
}

/**
 * Raw recent-content survival of the lossless (squash-only) output. This
 * is the normalization baseline: squash applies in every mode, so a mode's
 * recent score = its raw survival relative to this.
 */
async function losslessRecentBaseline(sessionPath: string, origRecords: any[]): Promise<number> {
  let outPath: string | null = null;
  try {
    const result = await trimSession(sessionPath, { mode: "lossless" });
    outPath = result.path;
    const records = sliceFromLastCompact(readJsonlRecords(outPath)).records;
    return recentContentRetention(origRecords, records);
  } catch (err) {
    logError("probes.losslessRecentBaseline", err, { sessionPath });
    return 1; // fall back to raw scoring
  } finally {
    if (outPath) {
      try {
        unlinkSync(outPath);
      } catch {}
    }
  }
}

function normalizedRecent(origRecords: any[], trimmedRecords: any[], baseline: number): number {
  const raw = recentContentRetention(origRecords, trimmedRecords);
  return baseline > 0 ? Math.min(1, raw / baseline) : 1;
}

/**
 * Deterministic probe pass over one session — the shared core behind
 * `claudecompress probe` and the /probe slash command (which runs inside
 * a hook and needs results without console output or process.exit).
 * Trims to sibling temp files and always deletes them.
 */
export async function probeSession(
  sessionPath: string,
  modes: TrimMode[] = [...ALL_MODES],
): Promise<{ origTokens: number; ground: SessionSignals; rows: ProbeRow[]; compacted: boolean }> {
  const { records: origRecords, compacted } = sliceFromLastCompact(readJsonlRecords(sessionPath));
  const ground = extractSignals(origRecords);
  const origTokens = roughContextTokens(sessionPath);
  const baselineRecent = await losslessRecentBaseline(sessionPath, origRecords);
  const rows: ProbeRow[] = [];
  for (const mode of modes) {
    let outPath: string | null = null;
    try {
      const result = await trimSession(sessionPath, optsForMode(mode));
      outPath = result.path;
      const trimmedRecords = sliceFromLastCompact(readJsonlRecords(outPath)).records;
      const scores = scoreRetention(ground, trimmedRecords);
      scores.recentContentRetention = normalizedRecent(origRecords, trimmedRecords, baselineRecent);
      const tokensAfter = roughContextTokens(outPath);
      const savedPct = origTokens === 0 ? 0 : Math.max(0, (1 - tokensAfter / origTokens) * 100);
      rows.push({ mode, tokensAfter, savedPct, scores, verdict: verdictFor(scores) });
    } finally {
      if (outPath) {
        try {
          unlinkSync(outPath);
        } catch (err) {
          logError("probes.probeSession.unlink", err, { outPath });
        }
      }
    }
  }
  return { origTokens, ground, rows, compacted };
}

interface ProbeArgs {
  sessionPath?: string;
  json: boolean;
  llm: boolean;
  modes: TrimMode[];
}

function parseArgs(args: string[]): ProbeArgs | null {
  const out: ProbeArgs = { json: false, llm: false, modes: [...ALL_MODES] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--llm") out.llm = true;
    else if (a === "--modes" || a.startsWith("--modes=")) {
      const raw = a.includes("=") ? a.slice("--modes=".length) : args[++i];
      if (!raw) {
        console.error("--modes requires a comma-separated list (e.g. --modes safe,slim)");
        return null;
      }
      const modes: TrimMode[] = [];
      for (const m of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!ALL_MODES.includes(m as TrimMode)) {
          console.error(`unknown mode "${m}" — valid: ${ALL_MODES.join(", ")}`);
          return null;
        }
        modes.push(m as TrimMode);
      }
      if (modes.length === 0) {
        console.error("--modes requires at least one mode");
        return null;
      }
      out.modes = modes;
    } else if (a.startsWith("--")) {
      console.error(`unknown flag ${a}`);
      console.error("usage: claudecompress probe [session.jsonl] [--modes safe,slim] [--json] [--llm]");
      return null;
    } else if (!out.sessionPath) {
      out.sessionPath = a;
    } else {
      console.error(`unexpected extra argument ${a}`);
      return null;
    }
  }
  return out;
}

export async function runProbe(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed) {
    process.exitCode = 1;
    return;
  }

  let sessionPath = parsed.sessionPath;
  if (sessionPath && !existsSync(sessionPath)) {
    console.error(`session not found: ${sessionPath}`);
    process.exitCode = 1;
    return;
  }
  if (!sessionPath) {
    sessionPath = largestSessionInCwd() ?? undefined;
    if (!sessionPath) {
      console.error(`no sessions found for this project (${projectDirForCwd()})`);
      console.error("pass a session path: claudecompress probe path/to/session.jsonl");
      process.exitCode = 1;
      return;
    }
  }

  let auth: Record<string, string> | null = null;
  if (parsed.llm) {
    auth = resolveAuth();
    if (!auth && !parsed.json) {
      console.log(pc.dim("note: no Anthropic credentials found — skipping LLM probes"));
    }
  }

  const { records: origRecords, compacted } = sliceFromLastCompact(readJsonlRecords(sessionPath));
  const ground = extractSignals(origRecords);
  const origTokens = roughContextTokens(sessionPath);
  const baselineRecent = await losslessRecentBaseline(sessionPath, origRecords);
  if (compacted && !parsed.json) {
    console.log(
      pc.dim(
        "note: session was /compact'ed — scoring only the post-compact window (what /resume replays)",
      ),
    );
  }

  interface ModeRow {
    mode: TrimMode;
    tokensAfter: number;
    savedPct: number;
    scores: RetentionScores;
    verdict: string;
    llm: LlmProbeResult | null;
  }
  const rows: ModeRow[] = [];

  for (const mode of parsed.modes) {
    let outPath: string | null = null;
    try {
      const result = await trimSession(sessionPath, optsForMode(mode));
      outPath = result.path;
      const trimmedRecords = sliceFromLastCompact(readJsonlRecords(outPath)).records;
      const scores = scoreRetention(ground, trimmedRecords);
      scores.recentContentRetention = normalizedRecent(origRecords, trimmedRecords, baselineRecent);
      const tokensAfter = roughContextTokens(outPath);
      const savedPct = origTokens === 0 ? 0 : Math.max(0, (1 - tokensAfter / origTokens) * 100);
      const llm = auth ? await runLlmProbes(auth, trimmedRecords, ground.artifacts, mode) : null;
      rows.push({ mode, tokensAfter, savedPct, scores, verdict: verdictFor(scores), llm });
    } catch (err) {
      logError("probes.runProbe.mode", err, { mode, sessionPath });
      if (!parsed.json) console.error(pc.red(`  ${mode}: probe failed (${String(err)})`));
    } finally {
      if (outPath) {
        try {
          unlinkSync(outPath);
        } catch (err) {
          logError("probes.runProbe.unlink", err, { outPath });
        }
      }
    }
  }

  if (parsed.json) {
    console.log(
      JSON.stringify(
        {
          session: sessionPath,
          originalTokens: origTokens,
          groundTruth: {
            artifacts: ground.artifacts,
            toolInvocations: ground.toolSkeleton.length,
            userAsks: ground.userAsks.length,
            errors: ground.errorSnippets.length,
          },
          modes: rows.map((r) => ({
            mode: r.mode,
            tokensAfter: r.tokensAfter,
            savedPct: Math.round(r.savedPct * 10) / 10,
            artifactRetention: r.scores.artifactRetention,
            toolSkeletonRetention: r.scores.toolSkeletonRetention,
            userAskRetention: r.scores.userAskRetention,
            errorRetention: r.scores.errorRetention,
            recentContentRetention: r.scores.recentContentRetention,
            verdict: r.verdict,
            llm: r.llm
              ? {
                  filePrecision: r.llm.filePrecision,
                  fileRecall: r.llm.fileRecall,
                  filesAnswer: r.llm.filesAnswer,
                  continuation: r.llm.continuation,
                }
              : null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const fmtTokens = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

  console.log();
  console.log(pc.bold(`probe · ${basename(sessionPath)}`));
  console.log(
    pc.dim(
      `  original: ${fmtTokens(origTokens)} tokens · ground truth: ` +
        `${ground.artifacts.length} artifact${ground.artifacts.length === 1 ? "" : "s"}, ` +
        `${ground.toolSkeleton.length} tool calls, ${ground.userAsks.length} user asks, ` +
        `${ground.errorSnippets.length} errors`,
    ),
  );
  console.log();
  console.log(
    `  ${"mode".padEnd(10)}${"saved".padStart(8)}${"artifact".padStart(10)}${"skeleton".padStart(10)}${"user-asks".padStart(11)}${"errors".padStart(9)}${"recent".padStart(9)}`,
  );
  console.log("  " + "-".repeat(67));
  for (const r of rows) {
    console.log(
      `  ${r.mode.padEnd(10)}` +
        `${(r.savedPct.toFixed(1) + "%").padStart(8)}` +
        `${pct(r.scores.artifactRetention).padStart(10)}` +
        `${pct(r.scores.toolSkeletonRetention).padStart(10)}` +
        `${pct(r.scores.userAskRetention).padStart(11)}` +
        `${pct(r.scores.errorRetention).padStart(9)}` +
        `${pct(r.scores.recentContentRetention).padStart(9)}`,
    );
  }
  console.log();
  for (const r of rows) {
    console.log(`  ${pc.bold(r.mode.padEnd(10))}${pc.dim(r.verdict)}`);
  }
  if (parsed.llm && auth) {
    console.log();
    console.log(pc.bold("  LLM probes") + pc.dim(` (${LLM_MODEL}, trimmed transcript only)`));
    for (const r of rows) {
      if (!r.llm) {
        console.log(`  ${r.mode.padEnd(10)}${pc.dim("n/a (request failed — see events.log)")}`);
        continue;
      }
      console.log(
        `  ${r.mode.padEnd(10)}files recall ${pct(r.llm.fileRecall)} · precision ${pct(r.llm.filePrecision)}`,
      );
      const cont = r.llm.continuation.replace(/\s+/g, " ").trim();
      console.log(pc.dim(`            next: ${cont.length > 220 ? cont.slice(0, 220) + "…" : cont}`));
    }
  }
  console.log();
}
