# ClaudeCompress

**Shrink Claude Code sessions so cold `/resume` costs less.**

```bash
bunx claudecompress
```

Interactive CLI: picks a project, shows each session's size + cache staleness + estimated cold-resume cost in USD, lets you trim it. Your source `.jsonl` is never modified — a new session file is written alongside it with a fresh UUID.

## When to run it

| Situation | Use it? |
|---|---|
| Back after a break (5+ min), big session, about to `/resume` | ✅ yes |
| Right after you type `/clear` | ✅ yes — cache is about to go cold anyway |
| Actively mid-session, cache warm | ❌ no — you'd invalidate the live cache |
| Small session (< 100k tokens) | ⚪ skip — not worth it |

The CLI flags cache state per-session (`warm`, `cold`, `very-cold`) from JSONL mtime and warns before trimming a warm one.

## What it does

Four modes, pick at runtime:

| Mode | Weight | Behavior |
|---|---|---|
| **Redact** (default) | medium | drop all tool_result bodies, keep full structure |
| **Smart** | light | per-tool rules — head/tail for `Read`/`Bash`, keep `Edit`/`TodoWrite`, redact `WebFetch` / MCP Playwright |
| **Ultra** | heavy | user + assistant text turns only; tool calls, results, thinking all dropped |
| **Truncate N** | manual | keep first N chars of every tool_result |

Real example on a 35 MB / 777k-token Opus session →
- **Redact**: 23 MB / 504k tokens (~$4 saved)
- **Smart**: 23 MB / 628k tokens (~$2 saved, tool-trail context preserved)
- **Ultra**: 1.2 MB / 115k tokens (~$9.93 saved, dialog only)

## Stack fit

| Tool | Layer | When |
|---|---|---|
| [rtk](https://github.com/rtk-ai/rtk) | Bash output compression at ingress | During session |
| [context-mode](https://github.com/mksglu/context-mode) | MCP sandbox + SQLite-backed tool output | During session |
| **ClaudeCompress** | Retrospective surgery on JSONL | Before cold `/resume` |

Complementary, not competing. rtk/context-mode prevent new bloat; ClaudeCompress fixes what's already there — including the thinking blocks, Claude's native `Read`/`Grep` output, non-ctx MCP responses, and all your pre-existing long sessions.

## Install

```bash
bunx claudecompress
```

Or from source:

```bash
git clone https://github.com/bihanikeshav/ClaudeCompress
cd ClaudeCompress && bun install && bun run src/index.ts
```

After trimming, `/resume` in Claude Code and pick the `[TRIMMED by claudecompress] …` entry. Send any message (e.g. `hi`) — `/context` recomputes and you'll see the drop (typically 50–80%).

## History

Every trim is logged to `~/.claude/claudecompress/history.jsonl`. See cumulative savings:

```bash
bunx claudecompress history
```

Shows recent trims, per-trim savings, and a lifetime total. The intro of the interactive flow also surfaces a one-liner like `Lifetime: 7 trims · saved ≈ $42.18`.

## Pricing per model

Cost estimate at runtime for Opus 4.7 / Opus 4.6 / Sonnet 4.6 / Haiku 4.5 using each model's actual input rate. Token count is a character-based approximation — Claude's tokenizer isn't public, so estimates are within ~10% of real.

## License

MIT
