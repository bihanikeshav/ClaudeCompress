# ClaudeCompress

**Shrink Claude Code sessions so cold `/resume` costs less.**

```bash
bunx claudecompress           # bun
npx claudecompress            # npm
```

No install required — `bunx`/`npx` fetches the latest release from npm on demand. To keep it around:

```bash
bun add -g claudecompress     # or: npm i -g claudecompress
claudecompress
```

Interactive CLI: picks a project, shows each session's size + cache staleness + estimated cold-resume cost in USD, lets you trim it. Your source `.jsonl` is never modified — a new session file is written alongside it with a fresh UUID.

## When to run it

| Situation | Use it? |
|---|---|
| Back after a break (5+ min), big session, about to `/resume` | ✅ yes |
| Claude Code suggests `/clear` (context pressure) | ✅ yes — trim instead so you keep the thread |
| Actively mid-session, cache warm | ❌ no — you'd invalidate the live cache |
| Small session (< 100k tokens) | ⚪ skip — not worth it |

The CLI flags cache state per-session (`warm`, `cold`, `very-cold`) from JSONL mtime and warns before trimming a warm one.

## What it does

Six modes, pick at runtime:

| Mode | Weight | Behavior |
|---|---|---|
| **Redact** (default) | medium | drop all tool_result bodies, keep full structure |
| **Recency N** | medium | keep last N turns verbatim (tool_results and all), redact older |
| **Focus N** | medium–heavy | keep last N turns verbatim + dialog-only trail for everything before |
| **Smart** | light | per-tool rules — head/tail for `Read`/`Bash`, keep `Edit`/`TodoWrite`, redact `WebFetch` / MCP Playwright |
| **Ultra** | heavy | user + assistant text turns only; tool calls, results, thinking all dropped |
| **Truncate N** | manual | keep first N chars of every tool_result |

**Redact** is the safe default — keeps structure and tool names intact, only drops bulky result bodies.
**Recency** is best for "I want to continue working" — full continuation state for the last N turns.
**Focus** is the sweet spot between Ultra and Recency — you keep a dialog-only trail of the whole conversation *plus* the last N turns fully intact. Great when Recency is still too heavy and Ultra loses too much.

**Drop-thinking toggle:** any non-Ultra mode can additionally drop `thinking` blocks. Often 200k+ tokens saved on a long session and thinking is never replayed meaningfully on resume.

Real example on a 760k-token Opus session:

| Mode | Tokens | Cold cost | Saved |
|---|---|---|---|
| None (baseline) | 760k | $11.41 | — |
| Redact | 504k | $7.56 | $3.85 |
| Recency 15 | 501k | $7.52 | $3.89 |
| Focus 500 | 217k | $3.25 | $8.16 |
| Focus 100 | 136k | $2.04 | $9.37 |
| Ultra | 125k | $1.88 | $9.53 |

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

## `/compress` slash command (v0.3+)

Install a Claude Code hook so you can run `/compress` from inside any session — no leaving the CLI to trim:

```bash
bun add -g claudecompress   # recommended, fast hook startup
claudecompress install
```

This edits `~/.claude/settings.json` to add a `UserPromptSubmit` hook matched on `^/compress`, and writes `~/.claude/commands/compress.md`. Restart Claude Code once.

Then inside any session:

```
/compress                    # Redact (default) + drop thinking
/compress ultra              # dialog-only
/compress smart              # per-tool rules
/compress focus 20           # dialog trail + last 20 turns verbatim
/compress recency 10         # last 10 turns verbatim, redact older
/compress truncate 500       # keep first 500 chars per tool_result
```

The hook reports bytes/tokens/USD saved and prints resume commands:

```
claude --resume <new-hash>
claude --resume <new-hash> --dangerously-skip-permissions
```

**Limitation:** `/compress` cannot rewrite the live session in place — that's architecturally locked to `/compact` (only Claude Code itself can mutate its in-memory message buffer). You still Ctrl+C and `--resume` the trimmed copy. See `ccw` below for auto-resume.

Uninstall anytime:

```bash
claudecompress uninstall
```

## `ccw` — auto-resume wrapper

`ccw` is a tiny wrapper around the `claude` CLI that makes `/compress` feel seamless: you Ctrl+C once after trim and `ccw` re-invokes `claude --resume <new-hash>` automatically.

```bash
bun add -g claudecompress
ccw                          # same args as `claude`, e.g. `ccw --dangerously-skip-permissions`
```

Under the hood: `ccw` sets a `CCW_SIGNAL_FILE` env var; the hook writes the new session hash to that file on successful trim; `ccw` reads it after claude exits and re-spawns with `--resume <hash>`. When no signal file exists, `ccw` exits normally.

Works cross-platform (Windows, macOS, Linux). Requires the Claude Code CLI (`claude`) on your PATH.

## Pricing per model

Cost estimate at runtime for Opus 4.7 / Opus 4.6 / Sonnet 4.6 / Haiku 4.5 using each model's actual input rate. Token count is a character-based approximation — Claude's tokenizer isn't public, so estimates are within ~10% of real.

## License

MIT
