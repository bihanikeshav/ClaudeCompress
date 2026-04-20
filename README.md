# ClaudeCompress

**A cold-resume cost tool for Claude Code.**
When you come back to a long session after a break and the prompt cache has expired, every token of that transcript gets billed as a fresh input. ClaudeCompress shrinks the on-disk session `.jsonl` so the cold rebuild is cheap.

```bash
bunx claudecompress
```

Interactive CLI — picks your project, lists sessions with their last-activity age, shows a size breakdown, asks how aggressively to trim, writes a stripped copy alongside the original. Your source file is never modified.

## When to use it (and when not to)

**Use it when:**
- You're coming back to a session after ≥ 5 minutes away → prompt cache has expired.
- The session is large (200k+ tokens) → a cold rebuild is genuinely expensive.
- You're about to `/resume` and want to pay less for that first turn.

**Don't use it when:**
- You're actively mid-session with a warm cache. Compressing now invalidates the cached prefix — your next turn will pay *more*, not less.
- The session is small. Overhead of the tool > savings.

ClaudeCompress detects staleness from the session's file mtime and warns you before trimming a session whose cache is probably still warm.

## Where it fits in the stack

Three Claude Code cost-reduction tools, three different problems:

| Tool | What it does | When |
|------|--------------|------|
| [rtk](https://github.com/rtk-ai/rtk) | PreToolUse Bash hook — compresses command output at ingress (`git push` → `ok main`) | During every session |
| [context-mode](https://github.com/mksglu/context-mode) | MCP server — sandboxes tool output in SQLite, returns summaries + handles | During every session |
| **ClaudeCompress** | Retrospective surgery on session `.jsonl` for cheaper cold `/resume` | After a break, before resuming |

rtk and context-mode are **forward-looking** (stop bloat entering context). ClaudeCompress is **backward-looking** (fix what's already there). They're complementary — you can run all three.

**What rtk and context-mode don't cover** (and why ClaudeCompress stays relevant even if you run them):
- rtk only hooks `Bash`. Claude's native `Read`, `Grep`, `Glob` bypass it — a single `Read` on a 2000-line file dumps 2000 lines into the transcript.
- context-mode only intercepts when the model chooses `ctx_execute` over Bash. Small commands and default behavior frequently skip it.
- Assistant thinking blocks, assistant text, and non-ctx MCP servers (Playwright, Gmail, etc.) are untouched by both.
- Pre-existing sessions from before you installed them stay fat forever.

## Modes

| Mode | What it keeps | What it drops | Typical ratio |
|------|---------------|---------------|---------------|
| **Ultra** | user + assistant text turns only | tool calls, tool results, thinking, attachments, snapshots | ~3–10% of original |
| **Redact** | full structure + tool names + inputs | tool result bodies (replaced with a short marker) | ~60–70% of original |
| **Truncate** | structure + first N chars of each tool result | the rest | tunable |

**Ultra** gives the biggest win but loses the ability to reference past file reads / command outputs. Best for pure-dialog continuation.
**Redact** keeps enough structure that on resume the model sees *what* it did in each turn, just not the raw output — usually the right default for resuming mid-project.
**Truncate** is the middle ground — useful if you want the *start* of each tool result (e.g., error headers, grep match counts) but not the full body.

## Usage

```bash
bunx claudecompress
```

Or from a clone:

```bash
git clone https://github.com/bihanikeshav/ClaudeCompress
cd ClaudeCompress
bun install
bun run src/index.ts
```

Output is a new `.jsonl` in the same project dir with a fresh session UUID. In `/resume` it shows up prefixed with `[TRIMMED by claudecompress]` so you can tell it apart from the original.

**Post-resume gotcha:** `/context` may display a cached value from the source session on first render. Send any message (e.g. `hi`) and it recomputes against the actual trimmed content — you'll typically see a 50–80% drop.

## What's in the JSONL

The analyze view shows where your tokens actually live. From a real 35 MB session:

```
user/tool_result                1614      10.64 MB    30.0%   ← largest single bucket
user/image                        18       2.24 MB     6.3%
assistant/tool_use              1614       1.41 MB     4.0%
file-history-snapshot            417       1.24 MB     3.5%
assistant/thinking               424     992.11 KB     2.7%   ← dense, ~250k tokens
attachment                       236     880.16 KB     2.4%
assistant/text                   639     188.94 KB     0.5%
```

Tool results dominate almost every real session. That's the fat you pay to reload on cold resume.

## How it works

- Parses the session `.jsonl` line-by-line (no full load into memory).
- For each block type, applies the chosen transform.
- Generates a fresh `sessionId` UUID so the new file lives alongside the original — nothing is overwritten.
- In Ultra mode, rewires `parentUuid` chains across dropped records so the thread stays internally consistent.
- Prepends `[TRIMMED by claudecompress]` to the first user message so it's visually distinct in `/resume`.
- Checks session file mtime to warn if the cache is likely still warm.

## Cache staleness detection

Anthropic's prompt cache has a 5-minute TTL. ClaudeCompress uses the session `.jsonl` mtime as a proxy for "time of last message" and classifies:

- `< 5 min ago`  → cache likely **warm**, trimming now is counterproductive
- `5–60 min ago` → cache **cold**, trimming is worthwhile
- `> 1 hour ago` → very cold, trimming is strongly recommended on large sessions

This is a heuristic, not an API call — but mtime tracks message writes accurately, so it's reliable for this purpose.

## License

MIT
