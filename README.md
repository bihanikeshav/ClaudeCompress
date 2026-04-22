# claudecompress

Three things, one install:

1. **Cache-TTL status line.** Countdown until your prompt cache expires. Detects 5m vs 1h ephemeral mode.
2. **`/compress` slash command.** Trim the active session on-demand, inside Claude Code.
3. **Interactive trimmer** (`bunx claudecompress`). Trim any saved JSONL for cheaper cold `/resume`.

## Quick start

```bash
bun add -g claudecompress     # preferred — see "Runtime preferences" below
# or
npm i -g claudecompress

claudecompress install        # interactive: adds hook + statusLine to ~/.claude/settings.json
# fully quit and relaunch Claude Code
```

Verify the statusLine appears at the bottom of any Claude Code session. Type `/compress` in a long session to trim it.

## The cache timer

States:

```
◉ cache warm · 5m · 4:32 left · Opus 4.7
◉ cache warm · 5m · 0:58 left · Opus 4.7
○ cache cold · 12m past · use /compress
◉ cache active · agent working · Opus 4.7
◉ new session · cache not yet seeded
```

Everything reads from the session JSONL Claude Code already writes. No proxy, no API interception.

- **Cache mode.** `cache_creation.ephemeral_1h_input_tokens > 0` → 1h, else 5m.
- **Agent working.** Latest assistant record with `stop_reason` in `{tool_use, pause_turn}` → mid-turn. Unknown reasons default to terminal.
- **Idle countdown.** Terminal `stop_reason` (`end_turn`, `max_tokens`, `stop_sequence`, `refusal`) → counts down from that timestamp. Zero → cold.
- **Client-side commands filtered.** `/context`, `/clear`, `/compact` write user records that never get a reply. Skipped so they don't lock the display into "working".
- **Polling.** Claude Code ticks the statusLine every second (`refreshInterval: 1`). Parsed state cached at `~/.claude/claudecompress/statusline-cache-<sid>.json`, keyed on JSONL mtime+size. Idle ticks skip the parse.

## `/compress` slash command

Type it in any Claude Code session. The hook trims the current session's JSONL and prints resume commands.

```
/compress               # Redact (default) + drop thinking
/compress ultra         # dialog-only
/compress focus 20      # dialog trail + last 20 turns verbatim
/compress recency 10    # last 10 turns verbatim, redact older
/compress smart         # per-tool rules
/compress truncate 500  # keep first 500 chars per tool_result
```

Hook output:

```
┌─ claudecompress ────────────────────────────────────────┐
  mode:   focus (last 20) · dropped thinking
  tokens: 628.8k → 126.0k   (saved ≈ 502.8k)
  cold $ $9.43 → $1.89      (saved ≈ $7.54)  [Opus 4.7]
  trimmed session: 17420d99-7152-4359-bfdd-34c2cefe77e3
└─────────────────────────────────────────────────────────┘
  Exit this session (Ctrl+C), then run:
    claude --resume 17420d99-7152-4359-bfdd-34c2cefe77e3
```

Original JSONL is never touched. The trimmed sibling gets a fresh UUID and a `[TRIMMED by claudecompress]` prefix on the first user message — obvious in `/resume`.

The running session can't be mutated from a hook — only `/compact` can, since it's in-process. So you Ctrl+C and `--resume` the new UUID, or use `ccw` to skip that.

## `ccw` — auto-resume wrapper

After `/compress`, Ctrl+C — `ccw` respawns `claude --resume <new-hash>` for you.

```bash
ccw                                    # same args as `claude`
ccw --dangerously-skip-permissions     # all flags pass through and survive auto-resume
```

Internals:
- `ccw` exports `CCW_SIGNAL_FILE` into the child's env.
- Hook writes the new session hash to that file on a successful trim.
- On `claude` exit, `ccw` reads the signal file; if present, respawns with `--resume <hash>`, otherwise exits normally.
- Flag preservation: strips prior `--resume`/`-r` and bare positional args on auto-resume, keeps the rest. Your `--dangerously-skip-permissions`, `--model`, etc. survive.

Cross-platform (Windows, macOS, Linux). Requires the `claude` CLI on your PATH.

## Interactive trimmer

Trim any saved session, no install:

```bash
bunx claudecompress
# or
npx claudecompress
```

Lists the current project's sessions with size, cache staleness (warm/cold/very-cold by mtime), and estimated cold-resume cost. Pick a mode; new JSONL lands next to the original.

Also:

```bash
claudecompress history         # lifetime trim savings
```

Every trim is logged to `~/.claude/claudecompress/history.jsonl`. The interactive flow shows a one-liner like `Lifetime: 7 trims · saved ≈ $42.18` on launch.

## Modes

| Mode | Weight | Behavior |
|---|---|---|
| **Redact** (default) | medium | drop all tool_result bodies, keep full structure |
| **Recency N** | medium | keep last N turns verbatim, redact older |
| **Focus N** | medium–heavy | dialog-only trail + last N turns verbatim |
| **Smart** | light | per-tool rules: Read heads/tails, Bash errors, full Edit/TodoWrite, redact WebFetch and heavy MCP responses |
| **Ultra** | heavy | user + assistant text only; tools/thinking all dropped |
| **Truncate N** | manual | keep first N chars of every tool_result |

**Drop-thinking toggle** (any non-Ultra mode): cuts 200k+ tokens. Claude doesn't re-read prior thinking on resume — free.

Real savings on a 760k-token Opus session:

| Mode | Tokens | Cold cost | Saved |
|---|---|---|---|
| None (baseline) | 760k | $11.41 | — |
| Redact | 504k | $7.56 | $3.85 |
| Recency 15 | 501k | $7.52 | $3.89 |
| Focus 500 | 217k | $3.25 | $8.16 |
| Focus 100 | 136k | $2.04 | $9.37 |
| Ultra | 125k | $1.88 | $9.53 |

Cost estimates use each model's actual input rate (Opus 4.7/4.6, Sonnet 4.6, Haiku 4.5). Token count is a char-based approximation — within ~10% of Anthropic's tokenizer.

## When to trim

| Situation | Trim? |
|---|---|
| Back after a break (5+ min), big session, about to `/resume` | ✅ yes |
| Claude Code suggests `/clear` (context pressure) | ✅ yes — trim instead so you keep the thread |
| Actively mid-session, cache warm | ❌ no — you'd invalidate the live cache |
| Small session (<100k tokens) | ⚪ skip — not worth it |

The interactive trimmer flags session cache state per-row (`warm` / `cold` / `very-cold`) from JSONL mtime and defaults "no" on warm ones.

## Install options

Per-component, all go to `~/.claude/settings.json` (backed up to `settings.json.claudecompress.bak` first):

```bash
claudecompress install              # interactive — asks about each piece separately
claudecompress install-hook         # just the /compress slash command
claudecompress install-statusline   # just the cache timer
claudecompress uninstall            # remove everything we added, keep backup
```

Existing custom `statusLine` entries are never overwritten without explicit confirmation. The installer asks before touching anything.

### Why global install (and bun)

The statusLine ticks every second. Under `npx`, each tick eats ~500ms of npm cold-start — half a CPU for nothing. Global install runs in 10–50ms. Installer skips the statusLine if `claudecompress` isn't on PATH.

**Bun is preferred over node.** ~3× faster startup (~10–15 ms vs ~30–50 ms). Installer detects `bun` on PATH and writes `bun <dist>/index.js statusline` automatically.

The `/compress` hook is fine under `npx` — it fires once per user-typed `/compress`, not continuously.

## Architecture notes

- **No daemon, no background process.** Claude Code drives the polling loop (`refreshInterval`); we're a stateless script that renders whatever the JSONL currently says.
- **Cross-OS by construction.** Claude Code renders the statusLine natively. No terminal injection, no PTY wrapping, no ANSI cursor hacks. Works identically on Windows (Git Bash), macOS, and Linux.
- **No API interception.** Cache state reads from fields Claude Code already writes to the session JSONL (`message.usage.cache_creation.ephemeral_1h_input_tokens`, `stop_reason`, etc.). No proxying, no wire-level MITM.
- **mtime-based cache invalidation.** Per-session cache keyed on JSONL mtime + size; idle ticks skip the parse entirely. Size is redundant insurance against filesystems with coarse mtime (FAT32, older NFS).

## Stack fit

| Tool | Layer | When |
|---|---|---|
| [rtk](https://github.com/rtk-ai/rtk) | Bash output compression at ingress | During session |
| [context-mode](https://github.com/mksglu/context-mode) | MCP sandbox + SQLite-backed tool output | During session |
| **claudecompress** | Cache visibility + `/compress` + retrospective trimming | Anytime |

rtk and context-mode stop new bloat at ingress. claudecompress shows cache state and cleans bloat that's already in the session: thinking blocks, native `Read`/`Grep`, non-sandboxed MCP, long existing sessions.

## Uninstall

```bash
claudecompress uninstall
```

Removes everything the installer added from `~/.claude/settings.json` (the `/compress` hook and our `statusLine`) and preserves the backup at `settings.json.claudecompress.bak`. Never touches anything else in your settings.

## License

MIT
