import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Real token counting via Anthropic's `/v1/messages/count_tokens` endpoint.
 * The char-based estimator in analyzer.ts is off by 2-3x for workloads heavy
 * in structured tool_use JSON, because BPE collapses repeated keys/braces
 * much more than the prose-tuned 3.6 chars/token ratio assumes. For anything
 * user-facing (banner, rehydrate message, pricing) we want real counts.
 */

interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

interface ApiMessage {
  role: "user" | "assistant";
  content: ContentBlock[] | string;
}

/**
 * Rebuild the API-shaped messages array from a claude-code JSONL transcript.
 *
 * claude-code stores one record per logical event — a user text message, a
 * tool_result, an assistant text turn, an assistant tool_use, etc. — and each
 * one is tagged `type: "user"` or `type: "assistant"`. The Anthropic Messages
 * API requires strictly alternating roles with the content array merged. So
 * we coalesce consecutive same-role records into a single message.
 *
 * Sidechain records (subagent turns) are skipped — they aren't replayed on
 * the main conversation's /resume.
 */
export function buildMessagesFromJsonl(path: string): { messages: ApiMessage[]; model: string | null } {
  const data = readFileSync(path, "utf8");
  const rawLines = data.split("\n");

  // Claude-code's /compact produces an `isCompactSummary` record that stands
  // in for everything before it. On /resume, replay begins from the *last*
  // such summary — earlier turns are superseded and never sent to the API.
  // Seek to that boundary before reconstructing messages; without this,
  // a session that has been compacted once will overcount its cold-resume
  // cost by whatever preceded the summary.
  let startIdx = 0;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (!rawLines[i]) continue;
    let r: any;
    try {
      r = JSON.parse(rawLines[i]);
    } catch {
      continue;
    }
    if (r?.isCompactSummary === true) {
      startIdx = i;
      break;
    }
  }

  const messages: ApiMessage[] = [];
  let lastAssistantModel: string | null = null;

  for (let i = startIdx; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // Skip records that claude-code itself excludes from API replay:
    //   - isSidechain: subagent (Task/Agent) turns belong to a separate thread
    //   - isMeta: ambient context injected by the CLI (local-command output
    //     captures, image attachment markers, skill base-dir hints). These
    //     appear in the transcript UI but are not sent to the model.
    //   - isVisibleInTranscriptOnly: display-only records.
    // The compact summary itself is kept even if it carries isMeta.
    if (rec?.isSidechain === true) continue;
    if (rec?.isMeta === true && rec?.isCompactSummary !== true) continue;
    if (rec?.isVisibleInTranscriptOnly === true) continue;
    if (rec?.isApiErrorMessage === true) continue;
    const t = rec?.type;
    if (t !== "user" && t !== "assistant") continue;
    const msg = rec?.message;
    if (!msg || typeof msg !== "object") continue;
    if (t === "assistant" && typeof msg.model === "string") {
      lastAssistantModel = msg.model;
    }

    const blocks = normalizeContent(msg.content);
    if (blocks.length === 0) continue;

    const prev = messages[messages.length - 1];
    if (prev && prev.role === t) {
      // Merge into previous same-role message.
      if (typeof prev.content === "string") prev.content = [{ type: "text", text: prev.content }];
      (prev.content as ContentBlock[]).push(...blocks);
    } else {
      messages.push({ role: t, content: blocks });
    }
  }

  sanitizeToolPairs(messages);
  return { messages, model: lastAssistantModel };
}

/**
 * Context-window rough estimate matching what claude-code's /context slash
 * command reports. Empirically derived: the per-category line items in
 * /context are computed by a local heuristic (`roughTokenCountEstimation`
 * per the leaked 2.1.x source), not the real tokenizer. Across dormant
 * sessions with wildly different content mixes (prose, Edit-heavy, image-
 * heavy via Read) we fit `stringify(message).length / 6` to the
 * "Messages: X tokens" line within ~1%.
 *
 * This is a disk-side approximation. On an actively running session,
 * claude-code's /context reflects its in-memory message tree (which may
 * hold unflushed content or have had autocompact applied in RAM); this
 * function only sees the JSONL. The `count_tokens` API path is the true
 * cost for cold /resume; this heuristic is the convenience match for
 * "what does /context show me."
 */
export function roughContextTokens(path: string): number {
  const { messages } = buildMessagesFromJsonl(path);
  let t = 0;
  for (const m of messages) {
    try {
      t += Math.ceil(JSON.stringify(m).length / 6);
    } catch {
      // unserializable — fall back to content length only
      const c = m.content;
      if (typeof c === "string") t += Math.ceil(c.length / 6);
      else if (Array.isArray(c)) {
        for (const b of c) {
          try { t += Math.ceil(JSON.stringify(b).length / 6); } catch {}
        }
      }
    }
  }
  return t;
}

/**
 * Tool names whose results claude-code clears from older turns before
 * sending to the API ("microcompact"). Inputs to these tools are usually
 * cheap (a path, a query, a command) but their *outputs* are enormous and
 * fully redundant after the model has used them — the assistant's reasoning
 * that follows already encodes whatever was learned.
 *
 * Kept in sync with claude-code's behavior as of ~2.1.x. If they add or
 * remove tools from this list in a later release we'll drift from their
 * /context number but the banner's claim ("cost on /resume") still holds.
 */
const MICROCOMPACT_TOOLS = new Set([
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
]);

/**
 * Number of most-recent tool_result occurrences to preserve verbatim per
 * tool name. Older ones get their content replaced with an elision marker.
 * claude-code's leaked microcompact uses a floor of 1; we mirror that.
 */
const MICROCOMPACT_KEEP_LAST = 1;

/**
 * Simulate claude-code's in-flight microcompact pass. Per the leaked 2.1.x
 * source, this clears `tool_result.content` on all but the most recent N
 * occurrences per tool name. Tool_use inputs are left intact — claude-code
 * relies on prompt caching to amortize their cost, not on eliding them.
 */
export function microcompactMessages(messages: ApiMessage[]): ApiMessage[] {
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && typeof (b as any).id === "string" && typeof (b as any).name === "string") {
        toolNameById.set((b as any).id as string, (b as any).name as string);
      }
    }
  }

  const seenResults = new Map<string, number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result") continue;
      const id = (b as any).tool_use_id as string | undefined;
      const name = id ? toolNameById.get(id) : undefined;
      if (!name || !MICROCOMPACT_TOOLS.has(name)) continue;
      const seen = seenResults.get(name) ?? 0;
      if (seen < MICROCOMPACT_KEEP_LAST) {
        seenResults.set(name, seen + 1);
        continue;
      }
      (b as any).content = `[${name} output elided]`;
    }
  }
  return messages;
}

/**
 * The Messages API requires tool_use/tool_result pairs to be *positional* —
 * every tool_use in an assistant message must have a matching tool_result in
 * the immediately following user message, and vice versa. claude-code's
 * JSONL often violates this: interrupted calls leave orphan tool_use blocks,
 * hook failures produce stray tool_results, and our own trimming can leave
 * cross-message mismatches. We repair by iterating assistant→nextUser pairs
 * and dropping any tool_use or tool_result without a positional partner.
 *
 * Messages whose content becomes empty are removed, then consecutive
 * same-role messages are re-coalesced.
 */
function sanitizeToolPairs(messages: ApiMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;

    const nextUser = messages[i + 1];
    const resultIds = new Set<string>();
    if (nextUser && nextUser.role === "user" && Array.isArray(nextUser.content)) {
      for (const b of nextUser.content) {
        if (b.type === "tool_result" && typeof (b as any).tool_use_id === "string") {
          resultIds.add((b as any).tool_use_id as string);
        }
      }
    }
    // Drop tool_use blocks without a positional tool_result.
    m.content = m.content.filter((b) => {
      if (b.type !== "tool_use") return true;
      return typeof (b as any).id === "string" && resultIds.has((b as any).id);
    });

    // Drop tool_result blocks in nextUser whose tool_use_id isn't in this assistant.
    if (nextUser && nextUser.role === "user" && Array.isArray(nextUser.content)) {
      const useIds = new Set<string>();
      for (const b of m.content) {
        if (b.type === "tool_use" && typeof (b as any).id === "string") useIds.add((b as any).id as string);
      }
      nextUser.content = nextUser.content.filter((b) => {
        if (b.type !== "tool_result") return true;
        return typeof (b as any).tool_use_id === "string" && useIds.has((b as any).tool_use_id);
      });
    }
  }

  // Drop empty messages and re-coalesce consecutive same-role messages.
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    const empty = Array.isArray(c) ? c.length === 0 : typeof c === "string" && c.length === 0;
    if (empty) messages.splice(i, 1);
  }
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === messages[i - 1].role) {
      const prev = messages[i - 1];
      const cur = messages[i];
      const a = typeof prev.content === "string" ? [{ type: "text", text: prev.content } as ContentBlock] : prev.content;
      const b = typeof cur.content === "string" ? [{ type: "text", text: cur.content } as ContentBlock] : cur.content;
      prev.content = [...a, ...b];
      messages.splice(i, 1);
    }
  }

  // Final defensive pass: after coalesce, the message indices have shifted;
  // re-verify positional tool_use/tool_result pairing and nuke any surviving
  // orphans. Without this, sessions with interleaved drops + coalesces can
  // still produce pairings the API rejects (422 / 400).
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    if (m.role === "assistant") {
      const next = messages[i + 1];
      const resIds = new Set<string>();
      if (next && next.role === "user" && Array.isArray(next.content)) {
        for (const b of next.content) {
          if (b.type === "tool_result" && typeof (b as any).tool_use_id === "string") {
            resIds.add((b as any).tool_use_id as string);
          }
        }
      }
      m.content = m.content.filter(
        (b) => b.type !== "tool_use" || resIds.has((b as any).id as string),
      );
    } else if (m.role === "user") {
      const prev = messages[i - 1];
      const useIds = new Set<string>();
      if (prev && prev.role === "assistant" && Array.isArray(prev.content)) {
        for (const b of prev.content) {
          if (b.type === "tool_use" && typeof (b as any).id === "string") {
            useIds.add((b as any).id as string);
          }
        }
      }
      m.content = m.content.filter(
        (b) => b.type !== "tool_result" || useIds.has((b as any).tool_use_id as string),
      );
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (Array.isArray(c) && c.length === 0) messages.splice(i, 1);
  }
}

function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    if (content.length === 0) return [];
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const kind = (b as any).type;
    // `thinking` blocks are replay-only and not accepted by count_tokens
    // unless extended thinking is enabled — drop them.
    if (kind === "thinking") continue;
    if (kind === "tool_result") {
      // The API rejects tool_result blocks with empty content. claude-code
      // occasionally produces these (e.g. a tool that errored before
      // producing output). Substitute a placeholder so the request validates.
      const c = (b as any).content;
      const empty =
        c == null ||
        (typeof c === "string" && c.length === 0) ||
        (Array.isArray(c) && c.length === 0);
      if (empty) {
        out.push({ ...(b as any), content: "(empty)" });
        continue;
      }
    }
    if (kind === "text") {
      const txt = (b as any).text;
      if (typeof txt !== "string" || txt.length === 0) continue;
    }
    out.push(b as ContentBlock);
  }
  return out;
}

export interface CountTokensResult {
  inputTokens: number;
  model: string;
}

interface AuthHeaders {
  [k: string]: string;
}

/**
 * Resolve auth headers for api.anthropic.com in order of preference:
 *   1. ANTHROPIC_API_KEY env — standard API key (x-api-key).
 *   2. Claude Code's OAuth token at ~/.claude/.credentials.json — Bearer token
 *      with user:inference scope that claude-code itself uses.
 *
 * Returns null if neither is available.
 */
function resolveAuth(): AuthHeaders | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return { "x-api-key": apiKey };

  try {
    const credsPath = join(homedir(), ".claude", ".credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf8"));
    const token = creds?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 0) {
      return {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Calls Anthropic's count_tokens endpoint for the given JSONL. The endpoint
 * is free (no inference). Uses ANTHROPIC_API_KEY if set, otherwise falls back
 * to the claude-code OAuth token. Throws if neither is available or the API
 * returns an error so callers can fall back to char-based estimation.
 */
export async function countTokensForSession(
  path: string,
  modelOverride?: string,
): Promise<CountTokensResult> {
  const auth = resolveAuth();
  if (!auth) throw new Error("no anthropic credentials (ANTHROPIC_API_KEY or ~/.claude/.credentials.json)");

  const { messages: raw, model: detected } = buildMessagesFromJsonl(path);
  if (raw.length === 0) return { inputTokens: 0, model: modelOverride ?? detected ?? "claude-opus-4-5" };

  // Apply the same microcompact pass claude-code runs before every API call,
  // so our count matches what Anthropic is actually billed on /resume (and
  // what the /context slash command displays).
  const messages = microcompactMessages(raw);

  // count_tokens requires the first message to be role: user.
  if (messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(resume)" }] });
  }

  const model = modelOverride ?? detected ?? "claude-opus-4-5";
  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...auth,
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`count_tokens ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { input_tokens: number };
  return { inputTokens: data.input_tokens, model };
}
