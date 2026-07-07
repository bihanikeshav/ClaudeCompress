# claudecompress

A **cache-aware status line** for Claude Code and a **session trimmer** that keeps cold `/resume` cheap — plus the tooling to prove it's safe (`/probe`, `/diff`) and run it fleet-wide (`analyze`, `gc`).

## Quick start

```bash
bun add -g claudecompress      # or: npm i -g claudecompress  (bun is ~3× faster for the 1s statusline tick)
claudecompress install         # interactive: hook + statusline + PreCompact archive → ~/.claude/settings.json
# fully quit and relaunch Claude Code
```

## Slash commands (the everyday interface)

Everything is a slash command inside your session. All are handled by the hook — the model never sees them, so they cost zero tokens and respond instantly:

| Command | What it does |
|---|---|
| `/compress [mode] [N]` | trim this session for cheap cold `/resume` |
| `/savings` | lifetime tokens + $ saved by your trims |
| `/probe` | fidelity check: what each mode would preserve of THIS session |
| `/diff` | open an HTML report of what the last trim removed |
| `/analyze` | this project's sessions — sizes, tokens, cold-resume cost |
| `/gc` | preview a batch trim of this project's cold sessions |
| `/ttl` | cache TTL countdown (same line as the statusline) |
| `/break [min]` | prints a `/loop` command that keeps the cache warm during a break |

## The cache timer

```
◉ cache warm · 1h · 56:07 left · Opus 4.8
○ cache cold · 12m past · /compress to save tokens
◉ cache active · agent working
```

Reads only the session JSONL Claude Code already writes — no proxy, no API interception, no daemon. Detects 5m vs 1h cache mode, in-flight calls, tool dispatch, and Ctrl-C interrupts. Ticks every second; state is mtime-cached so idle ticks skip parsing.

## Trimming

```
/compress               # safe (default) — observation masking + last 5 turns verbatim
/compress lossless      # only squash tool outputs; keeps every turn
/compress safe 15       # wider recent window
/compress smart         # per-component rules — middle ground
/compress slim          # aggressive — drops older tool_use breadcrumbs
/compress force         # override the cache-warm refusal
```

Guarantees:

- **The original JSONL is never touched.** Trims write a sibling file with a fresh UUID and a `[TRIMMED by claudecompress]` marker; resume it with `claude --resume <hash>`.
- **Warm cache → `/compress` refuses** and suggests `/compact` (in-place, no cold rebuild). Trimming only pays once the cache has expired. `force` overrides.
- **Error outputs are never masked**, tool_use/tool_result pairs always stay intact, and elided bodies use Claude Code's own native marker strings.
- Under `ccw`, `/compress` auto-exits and respawns `claude --resume` for you; otherwise press Ctrl+C twice and run the printed command.

### Modes

Measured on a 760k-token Opus session (153 user turns):

| Mode | % saved | Quality risk | What it does |
|---|---|---|---|
| **lossless** | ~18% | None | squash verbose tool outputs only; every turn preserved |
| ⭐ **safe** (default, N=5) | ~56% | Low | keep last N turns verbatim; observation-mask older, compress old Edit/Write inputs |
| **smart** | ~67% | Low-Med | per-component rules by turn depth; tool_use skeleton always survives |
| **slim** (N=5) | ~73% | Med | last N verbatim; older turns become dialog-only (loses breadcrumbs) |

`safe` implements **observation masking**, which JetBrains' 2025 NeurIPS study ("The Complexity Trap") found matches or beats LLM summarization on SWE-bench at 52% lower cost, and it is the only lossy mode that keeps recent-turn content 100% intact (fleet-measured). `smart` saves more partly by truncating recent tool results — its `recent` probe score averages ~91% and can drop below 60% on tool-heavy sessions. Run `/probe` on your own session to see exactly what each mode preserves. Details and decay curves: [theory →](https://bihanikeshav.github.io/ClaudeCompress/theory/)

**N counts your messages**: `safe 5` keeps the last 5 back-and-forths (including all tool activity within them) fully intact.

Cost = cold `/resume`, which rebuilds the session into prompt cache (1h write = 2× base input; 5m = 1.25×; detected per session). Token counts use the same calibrated heuristic as `/context` plus Anthropic's free `count_tokens` API.

### When to trim

| Situation | Trim? |
|---|---|
| Back after a break, big session, about to `/resume` | ✅ yes |
| Claude Code suggests `/clear` | ✅ trim instead — keep the thread |
| Mid-session, cache warm | ❌ no — use `/compact` |
| Small session (<100k tokens) | ⚪ not worth it |

## PreCompact auto-archive

`/compact` (manual or auto) irreversibly replaces history with a summary. The PreCompact hook snapshots the full transcript to `~/.claude/claudecompress/archives/` first (capped at 40 files / 500 MB, oldest pruned; never blocks compaction). Restore with `claude --resume <archive-path>`.

## CLI reference

Every slash command has a scriptable CLI twin with extra flags:

```bash
claudecompress                 # interactive trimmer for any saved session (also: bunx claudecompress)
claudecompress history         # lifetime savings (same data as /savings)
claudecompress diff [hash|paths]                     # HTML what-was-removed report
claudecompress analyze [--all] [--sample N] [--json] # fleet waste report + measured per-mode savings
claudecompress gc [--mode safe] [--min-size 200kb] [--min-age 24h] [--all] [--dry-run] [--yes]
claudecompress probe [session] [--modes safe,slim] [--json] [--llm]
```

- `analyze` is read-only (savings are measured on temp copies). `gc` batch-trims cold sessions — plan first, confirm, originals untouched, already-trimmed sessions skipped.
- `probe` scores what survives each mode: files modified, tool skeleton, your last 10 asks, every error, and verbatim survival of recent-turn content (normalized against squash). Sessions that were `/compact`'ed are scored on the post-compact window — what `/resume` actually replays. `--llm` adds Haiku-graded recovery questions (needs API creds).
- Every trim (slash, CLI, or `ccw`) is logged to `~/.claude/claudecompress/history.jsonl`.

## `ccw`, the auto-resume wrapper

```bash
ccw                                  # same args as `claude`; flags survive auto-resume
CLAUDE_CONFIG_DIR=~/.claude_x ccw    # env prefixes pass through
CCW_CLAUDE_CMD=claude-me ccw         # custom launcher binary
```

On a successful `/compress`, the hook signals `ccw` (per-terminal signal file — parallel sessions are unaffected), which respawns `claude --resume <new-hash>` automatically. Cross-platform; requires `claude` on PATH.

## Install / uninstall

```bash
claudecompress install              # asks about each piece separately
claudecompress install-hook         # slash commands only
claudecompress install-statusline   # cache timer only
claudecompress uninstall            # removes everything we added; backup kept
```

Settings are backed up to `settings.json.claudecompress.bak` before any write; existing custom statusLines are never overwritten without confirmation. Global install matters for the statusline (npx cold-start is ~500ms per tick; global is 10–50ms, bun ~10–15ms).

## Stack fit

| Tool | Layer |
|---|---|
| [rtk](https://github.com/rtk-ai/rtk) | compresses Bash output at ingress, during the session |
| [context-mode](https://github.com/mksglu/context-mode) | MCP sandbox for tool output, during the session |
| **claudecompress** | cache visibility + cleaning bloat already in the session, anytime |

## License

MIT
