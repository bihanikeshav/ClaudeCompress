/**
 * Per-tool trimming rules for Smart mode.
 *
 * When trimming a tool_result, we look up which assistant tool_use produced
 * it (by tool_use_id) and apply the action keyed on that tool's name. This
 * preserves more signal than blanket redaction while still cutting the bulk.
 *
 * Pattern matching:
 *   - exact name match wins
 *   - then prefix matches (e.g. "mcp__playwright__" covers a whole server)
 *   - falls back to "*" wildcard
 */

export type RuleAction =
  | { kind: "redact" }
  | { kind: "keep" }
  | { kind: "truncate"; chars: number }
  | { kind: "head-tail"; headLines: number; tailLines: number };

export interface Rule {
  match: string; // exact tool name, prefix ending in "__" or "*", or "*" for default
  action: RuleAction;
}

export const DEFAULT_RULES: Rule[] = [
  // Claude Code native file/search tools — the biggest bloat sources
  {
    match: "Read",
    action: { kind: "head-tail", headLines: 20, tailLines: 10 },
  },
  { match: "Grep", action: { kind: "truncate", chars: 800 } },
  { match: "Glob", action: { kind: "truncate", chars: 800 } },
  { match: "LS", action: { kind: "truncate", chars: 400 } },

  // Shell output — errors and final state usually at the ends
  {
    match: "Bash",
    action: { kind: "head-tail", headLines: 30, tailLines: 20 },
  },
  { match: "PowerShell", action: { kind: "head-tail", headLines: 30, tailLines: 20 } },

  // Network / page content — rarely useful to replay verbatim
  { match: "WebFetch", action: { kind: "redact" } },
  { match: "WebSearch", action: { kind: "truncate", chars: 500 } },

  // Small, stateful — keep fully
  { match: "TodoWrite", action: { kind: "keep" } },
  { match: "TodoRead", action: { kind: "keep" } },
  { match: "Edit", action: { kind: "keep" } },
  { match: "Write", action: { kind: "keep" } },
  { match: "MultiEdit", action: { kind: "keep" } },
  { match: "NotebookEdit", action: { kind: "keep" } },

  // Subagents — transcripts can be enormous; the outer turn already saw them
  { match: "Task", action: { kind: "redact" } },
  { match: "Agent", action: { kind: "redact" } },

  // MCP servers — per-server defaults; add more as the catalog grows
  { match: "mcp__playwright_playwright__", action: { kind: "redact" } },
  { match: "mcp__claude-in-chrome__", action: { kind: "redact" } },
  { match: "mcp__claude_ai_Gmail__", action: { kind: "truncate", chars: 600 } },
  { match: "mcp__claude_ai_Google_Drive__", action: { kind: "truncate", chars: 600 } },
  { match: "mcp__claude_ai_Google_Calendar__", action: { kind: "truncate", chars: 600 } },

  // Catch-all
  { match: "*", action: { kind: "redact" } },
];

export function matchRule(toolName: string, rules: Rule[] = DEFAULT_RULES): Rule {
  // 1. Exact match
  for (const r of rules) {
    if (r.match === toolName) return r;
  }
  // 2. Prefix match (match ending in "__" or "*")
  const prefixes = rules.filter(
    (r) => r.match.endsWith("__") || (r.match.endsWith("*") && r.match !== "*"),
  );
  prefixes.sort((a, b) => b.match.length - a.match.length);
  for (const r of prefixes) {
    const prefix = r.match.endsWith("*") ? r.match.slice(0, -1) : r.match;
    if (toolName.startsWith(prefix)) return r;
  }
  // 3. Wildcard
  const star = rules.find((r) => r.match === "*");
  if (star) return star;
  return { match: "*", action: { kind: "redact" } };
}

export function applyRuleToText(text: string, action: RuleAction): string {
  switch (action.kind) {
    case "keep":
      return text;
    case "redact":
      return "[tool response redacted by claudecompress]";
    case "truncate":
      if (text.length <= action.chars) return text;
      return (
        text.slice(0, action.chars) +
        `\n\n[... ${text.length - action.chars} chars trimmed]`
      );
    case "head-tail": {
      const lines = text.split("\n");
      if (lines.length <= action.headLines + action.tailLines + 1) return text;
      const head = lines.slice(0, action.headLines);
      const tail = lines.slice(-action.tailLines);
      const skipped = lines.length - action.headLines - action.tailLines;
      return [
        ...head,
        `[... ${skipped} lines trimmed by claudecompress ...]`,
        ...tail,
      ].join("\n");
    }
  }
}
