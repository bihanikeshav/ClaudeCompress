/**
 * Per-tool-result output compression.
 *
 * Inspired by rtk (github.com/rtk-ai/rtk): tool outputs often contain a lot
 * of boilerplate that the model doesn't need to keep in context. A Bash
 * `git push` result, for example, is ~200 tokens of progress output around
 * a 20-token truth. We identify the command pattern and extract just the
 * signal.
 *
 * Runs AFTER the mode-based trimming (safe/smart/slim) as a universal
 * post-process. Archive mode drops tool_results entirely so this is a no-op
 * there.
 *
 * Rules are deliberately conservative:
 *   1. If output is short (< MIN_SQUASH_CHARS), leave alone
 *   2. If a command-specific rule matches, apply it
 *   3. Otherwise fall back to head/tail retention with error-line preservation
 */

const MIN_SQUASH_CHARS = 1200;
const HEAD_LINES = 12;
const TAIL_LINES = 8;
const MAX_ERROR_LINES = 15;

// Lines containing these tokens are preserved even in the middle of a long
// output — they usually carry the load-bearing signal.
const ERROR_RE = /\b(error|warning|failed|fatal|exception|panic|traceback|abort|denied|invalid|missing|cannot|unable)\b/i;

function headTail(content: string, command?: string): string {
  if (content.length <= MIN_SQUASH_CHARS) return content;
  const lines = content.split("\n");
  if (lines.length <= HEAD_LINES + TAIL_LINES + 4) return content;

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES);
  const errorLines = middle.filter((l) => ERROR_RE.test(l)).slice(0, MAX_ERROR_LINES);

  const skipped = middle.length - errorLines.length;
  const parts = [...head];
  if (errorLines.length > 0) {
    parts.push(`... (${skipped} lines hidden)`);
    parts.push(...errorLines);
    parts.push("...");
  } else {
    parts.push(`... (${skipped} lines hidden)`);
  }
  parts.push(...tail);
  return parts.join("\n");
}

/**
 * Bash commands that produce chatty output around a tiny signal. We pattern-
 * match on the invoked command (the `command` argument from the Bash tool_use
 * input) and extract just the relevant lines.
 */
function squashBashResult(content: string, command: string | undefined): string {
  if (!command) return headTail(content);
  const cmd = command.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  const first = command.trim().split(/\s+/)[0]!.toLowerCase();

  // --- git ---------------------------------------------------------------
  if (first === "git") {
    const sub = command.trim().split(/\s+/)[1]?.toLowerCase() ?? "";
    if (sub === "push") {
      // Keep only the "To ..." line and the "<old>..<new>  branch -> branch"
      const lines = content.split("\n");
      const kept = lines.filter(
        (l) => /^\s*(To |[a-f0-9]+\.\.[a-f0-9]+|\*|!|error:|fatal:|warning:)/i.test(l),
      );
      if (kept.length === 0) return headTail(content, command);
      return kept.slice(0, 10).join("\n");
    }
    if (sub === "status") {
      const lines = content.split("\n");
      // Keep header + first 30 file lines
      return lines.slice(0, 40).join("\n") + (lines.length > 40 ? `\n... (${lines.length - 40} lines hidden)` : "");
    }
    if (sub === "log") {
      // Keep first 5 commits (commits separated by "commit <hash>")
      const lines = content.split("\n");
      let commits = 0;
      const out: string[] = [];
      for (const l of lines) {
        if (/^commit [a-f0-9]+/.test(l)) {
          commits += 1;
          if (commits > 5) break;
        }
        out.push(l);
      }
      if (out.length < lines.length) out.push(`... (${lines.length - out.length} more lines)`);
      return out.join("\n");
    }
    if (sub === "diff" || sub === "show") {
      return headTail(content, command);
    }
    // generic git command
    return headTail(content, command);
  }

  // --- package managers --------------------------------------------------
  if (first === "npm" || first === "pnpm" || first === "yarn" || first === "bun") {
    const lines = content.split("\n");
    // Keep error lines + summary lines
    const signal = lines.filter((l) =>
      ERROR_RE.test(l) ||
      /\b(added|removed|changed|installed|updated|saved)\s+\d+\s+package/i.test(l) ||
      /^\s*npm warn/i.test(l) ||
      /\b\d+\s+packages?\b/i.test(l.slice(0, 120)),
    );
    if (signal.length > 0 && signal.length < lines.length) {
      return signal.slice(0, 30).join("\n");
    }
    return headTail(content, command);
  }

  // --- cargo / rust ------------------------------------------------------
  if (first === "cargo") {
    const sub = command.trim().split(/\s+/)[1]?.toLowerCase() ?? "";
    if (sub === "test" || sub === "build" || sub === "check" || sub === "clippy") {
      const lines = content.split("\n");
      const errorLines = lines.filter(
        (l) => /^\s*(error|warning|test result:|running|failures:|test .* \.\.\. (FAILED|ok))/i.test(l),
      );
      if (errorLines.length > 0) return errorLines.slice(0, 30).join("\n");
    }
    return headTail(content, command);
  }

  // --- TypeScript / tsc --------------------------------------------------
  if (cmd.startsWith("tsc") || cmd.includes("npx tsc") || cmd.includes("bun tsc")) {
    const lines = content.split("\n");
    const errors = lines.filter((l) => /error TS\d+/.test(l) || /^Found \d+ errors?/.test(l));
    if (errors.length > 0) return errors.slice(0, 40).join("\n");
    return content.length > MIN_SQUASH_CHARS ? "no errors" : content;
  }

  // --- linters -----------------------------------------------------------
  if (first === "eslint" || first === "biome" || cmd.includes("eslint")) {
    const lines = content.split("\n");
    const problems = lines.filter((l) => /\berror\b|\bwarning\b|✖|✗/i.test(l));
    if (problems.length > 0) return problems.slice(0, 40).join("\n");
    return headTail(content, command);
  }

  // --- python test runners -----------------------------------------------
  if (cmd.startsWith("pytest") || cmd.includes("python -m pytest") || cmd.includes("python -m unittest")) {
    const lines = content.split("\n");
    const signal = lines.filter(
      (l) => /FAILED|PASSED|ERROR|=====|short test summary|\d+ (failed|passed|error)/i.test(l),
    );
    if (signal.length > 0) return signal.slice(0, 50).join("\n");
    return headTail(content, command);
  }

  // --- file listing ------------------------------------------------------
  if (first === "ls" || first === "dir") {
    const lines = content.split("\n");
    if (lines.length > 40) {
      return lines.slice(0, 30).join("\n") + `\n... (${lines.length - 30} more entries)`;
    }
    return content;
  }

  // --- container / cloud tools ------------------------------------------
  if (first === "docker" || first === "kubectl" || first === "k9s" || first === "helm") {
    return headTail(content, command);
  }

  // --- curl / http -------------------------------------------------------
  if (first === "curl" || first === "wget" || first === "http" || first === "httpie") {
    // Keep headers + first chunk of body
    const idx = content.indexOf("\n\n");
    if (idx > -1 && idx < 2000) {
      const headers = content.slice(0, idx);
      const body = content.slice(idx + 2);
      if (body.length > 800) return headers + "\n\n" + body.slice(0, 800) + `\n... (${body.length - 800} body bytes hidden)`;
    }
    return headTail(content, command);
  }

  // --- find / search tools -----------------------------------------------
  if (first === "find" || first === "rg" || first === "ag" || first === "ack") {
    const lines = content.split("\n");
    if (lines.length > 40) {
      return lines.slice(0, 30).join("\n") + `\n... (${lines.length - 30} more matches)`;
    }
    return content;
  }

  // --- generic fallback --------------------------------------------------
  return headTail(content, command);
}

/**
 * Squash the tool_result content for a given tool + optional command.
 * Returns the possibly-shortened content (or original if nothing to do).
 */
export function squashToolResultContent(
  content: string,
  toolName: string | undefined,
  toolInput?: any,
): string {
  if (typeof content !== "string") return content;
  if (content.length < MIN_SQUASH_CHARS) return content;

  switch (toolName) {
    case "Bash":
      return squashBashResult(content, typeof toolInput?.command === "string" ? toolInput.command : undefined);
    case "Read":
      // Read output is structured (line-numbered content). Head/tail works.
      return headTail(content);
    case "Grep":
    case "Glob": {
      const lines = content.split("\n");
      if (lines.length > 50) {
        return lines.slice(0, 40).join("\n") + `\n... (${lines.length - 40} more matches)`;
      }
      return content;
    }
    case "WebFetch":
    case "WebSearch":
      // Web content is chatty; aggressive trim
      return content.length > 2500 ? content.slice(0, 2500) + `\n... (${content.length - 2500} chars hidden)` : content;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      // Already terse confirmations — only squash if somehow huge
      return headTail(content);
    case "TodoWrite":
    case "TodoRead":
      // Structured task state, keep as-is
      return content;
    case "Task":
    case "Agent":
      // Pre-summarized by the subagent — light touch only
      return content.length > 4000 ? headTail(content) : content;
    default:
      // MCP tools and unknown: generic head/tail
      return headTail(content);
  }
}

/**
 * Apply squashing to a tool_result block. Handles both string content
 * and array-of-blocks content (mostly for image-laden results).
 */
export function squashToolResult(
  blk: any,
  toolName: string | undefined,
  toolInput?: any,
): any {
  if (!blk || typeof blk !== "object" || blk.type !== "tool_result") return blk;
  const c = blk.content;
  if (typeof c === "string") {
    const squashed = squashToolResultContent(c, toolName, toolInput);
    return squashed === c ? blk : { ...blk, content: squashed };
  }
  if (Array.isArray(c)) {
    let changed = false;
    const newContent = c.map((b: any) => {
      if (b?.type === "text" && typeof b.text === "string") {
        const s = squashToolResultContent(b.text, toolName, toolInput);
        if (s !== b.text) { changed = true; return { ...b, text: s }; }
        return b;
      }
      return b;
    });
    return changed ? { ...blk, content: newContent } : blk;
  }
  return blk;
}
