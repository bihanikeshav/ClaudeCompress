# claudecompress

A **cache-aware status line** for Claude Code, and a **trimmer** that keeps cold `/resume` cheap.

Two things, one install:

1. **Cache-aware workflow signal.** Know when your next message is expensive before you send it. Countdown until your prompt cache expires; bundle follow-up now or pay cold tax. Detects 5m vs 1h ephemeral mode.
2. **Trim any session.** Same engine, two entry points: `/compress` inside a Claude Code session trims it on demand, or `bunx claudecompress` trims any saved session retrospectively.

## Quick start

```bash
bun add -g claudecompress     # preferred (see "Why global install" below)
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
○ cache cold · 12m past · /compress to trim before rebuild
◉ cache active · agent working · Opus 4.7
◉ new session · cache not yet seeded
```

*(The `use /compress` is the command to run; "/compress" is a clickable code-style chip in Claude Code's rendering.)*

Everything reads from the session JSONL Claude Code already writes. No proxy, no API interception.

- **Cache mode.** 1h if `ephemeral_1h_input_tokens > 0`, else 5m.
- **Active vs idle.** Working when an API call is in-flight or a tool was dispatched in the last 30 s. Idle (countdown) otherwise — including when blocked on a permission prompt, a TTY subprocess, or after a Ctrl-C interrupt.
- **Interrupt detection.** Ctrl-C / ESC leaves a `[Request interrupted by user]` marker; the countdown starts from there.
- **Polling.** Ticks every second via `refreshInterval: 1`. State cached at `~/.claude/claudecompress/statusline-cache-<sid>.json`, keyed on JSONL mtime+size.

## Trimming

Two entry points into the same trim engine.

### Inside a session: `/compress`

Type `/compress` in any session. The hook trims the active session's JSONL and prints a resume command.

```
/compress               # Focus 5 (default) + drop thinking
/compress focus 15      # keep more recent context
/compress recency 10    # last 10 user turns verbatim, redact older
/compress smart         # per-tool rules
/compress ultra         # nuke it; dialog-only
/compress truncate 500  # keep first 500 chars per tool_result
```

Hook output:

```
┌─ claudecompress ────────────────────────────────────────┐
  mode:   focus (last 5) · dropped thinking
  tokens: 761k → 217k       (saved ≈ 544k)
  cost:   $22.83 → $6.51    (saved ≈ $16.32)  [Opus 4.6 · 200k+ tier]
  trimmed session: 17420d99-7152-4359-bfdd-34c2cefe77e3
└─────────────────────────────────────────────────────────┘
  Exit this session (Ctrl+C), then run:
    claude --resume 17420d99-7152-4359-bfdd-34c2cefe77e3
```

Original JSONL is never touched. The trimmed sibling gets a fresh UUID and a `[TRIMMED by claudecompress]` prefix on the first user message, making it obvious in `/resume`.

The running session can't be mutated from a hook; only `/compact` can, since it's in-process. So you Ctrl+C and `--resume` the new UUID, or use `ccw` (below) to skip that step.

### Any saved session: `bunx claudecompress`

For sessions you didn't trim live, no install needed:

```bash
bunx claudecompress
# or: npx claudecompress
```

Lists the current project's sessions with size, cache staleness (warm/cold/very-cold by mtime), and estimated cold-resume cost. Pick a mode; new JSONL lands next to the original.

```bash
claudecompress history         # lifetime trim savings
```

Every trim is logged to `~/.claude/claudecompress/history.jsonl`. The interactive flow shows a one-liner like `Lifetime: 7 trims · saved ≈ $42.18` on launch.

### `ccw`, the auto-resume wrapper

After `/compress`, Ctrl+C, and `ccw` respawns `claude --resume <new-hash>` for you.

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

**Using a wrapper or alias?** Shell aliases (`alias claude-me='CLAUDE_CONFIG_DIR=~/.claude_personal claude'`) don't survive into child processes, so `ccw` can't pick them up automatically. Two ways to compose:

```bash
# Env-var prefix works as-is — ccw inherits env and passes it through.
CLAUDE_CONFIG_DIR=~/.claude_personal ccw

# Or point ccw at a different launcher binary / script.
CCW_CLAUDE_CMD=claude-me ccw
```

`CCW_CLAUDE_CMD` accepts any executable on your PATH (or an absolute path). Use it when your launcher isn't just `claude`.

## Modes

| Mode | Weight | Behavior |
|---|---|---|
| **Redact** | medium | drop all tool_result bodies, keep full structure |
| **Recency N** | medium | keep last N user turns verbatim (with their tool chains), redact older |
| **Focus N** (default, N=5) | medium to heavy | dialog-only trail for older turns + last N user turns verbatim |
| **Smart** | light | per-tool rules: Read heads/tails, Bash errors, full Edit/TodoWrite, redact WebFetch and heavy MCP responses |
| **Ultra** | heavy | user + assistant text only; tools/thinking all dropped |
| **Truncate N** | manual | keep first N chars of every tool_result |

**N counts your user messages**, not JSONL records. Each time you send a message, everything the agent does in response (tool calls, tool results, thinking, reply) is one "user turn". `Focus 5` keeps the last 5 back-and-forths verbatim; anything before is compressed to a dialog-only trail.

**Drop-thinking toggle** (any non-Ultra mode): cuts 200k+ tokens. Claude doesn't re-read prior thinking on resume; it's free savings.

Real savings on a 761k-token Opus 4.6 session (153 user turns, 200k+ context tier). **Focus 5 is the default**: keeps your last 5 exchanges verbatim (tool outputs, thinking, everything), dialog-only trail for everything older. Claude can re-read any file it needs from disk; the conversation flow stays intact. Cuts cost by ~70%.

| Mode | Tokens | Cost | Saved |
|---|---|---|---|
| Baseline | 761k | $22.83 | — |
| Recency 15 | 574k | $17.22 | $5.61 |
| Redact | 503k | $15.09 | $7.74 |
| Focus 15 | 327k | $9.81 | $13.02 |
| **Focus 5** (recommended) | **217k** | **$6.51** | **$16.32** |
| Ultra | 125k | $1.88 | $20.95 |

Cost uses Opus 4.6's 200k+ input rate ($30/Mtok for the full context once it crosses the threshold, $15/Mtok otherwise — Ultra's 125k drops below the tier). Token counts are char-based approximations, within ~10% of Anthropic's tokenizer. Same table for Opus 4.7/Sonnet/Haiku uses each model's own rates.

## When to trim

| Situation | Trim? |
|---|---|
| Back after a break (5+ min), big session, about to `/resume` | ✅ yes |
| Claude Code suggests `/clear` (context pressure) | ✅ yes, trim instead so you keep the thread |
| Actively mid-session, cache warm | ❌ no, you'd invalidate the live cache |
| Small session (<100k tokens) | ⚪ skip, not worth it |

The interactive trimmer flags session cache state per-row (`warm` / `cold` / `very-cold`) from JSONL mtime and defaults "no" on warm ones.

## Install options

Per-component, all go to `~/.claude/settings.json` (backed up to `settings.json.claudecompress.bak` first):

```bash
claudecompress install              # interactive: asks about each piece separately
claudecompress install-hook         # just the /compress slash command
claudecompress install-statusline   # just the cache timer
claudecompress uninstall            # remove everything we added, keep backup
```

Existing custom `statusLine` entries are never overwritten without explicit confirmation. The installer asks before touching anything.

### Why global install (and bun)

The statusLine ticks every second. Under `npx`, each tick eats ~500ms of npm cold-start: half a CPU for nothing. Global install runs in 10–50ms. Installer skips the statusLine if `claudecompress` isn't on PATH.

**Bun is preferred over node.** ~3× faster startup (~10–15 ms vs ~30–50 ms). Installer detects `bun` on PATH and writes `bun <dist>/index.js statusline` automatically.

The `/compress` hook is fine under `npx`; it fires once per user-typed `/compress`, not continuously.

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
| **claudecompress** | Cache visibility + session trimming | Anytime |

rtk and context-mode stop new bloat at ingress. claudecompress shows cache state and cleans bloat that's already in the session: thinking blocks, native `Read`/`Grep`, non-sandboxed MCP, long existing sessions.

## Uninstall

```bash
claudecompress uninstall
```

Removes everything the installer added from `~/.claude/settings.json` (the `/compress` hook and our `statusLine`) and preserves the backup at `settings.json.claudecompress.bak`. Never touches anything else in your settings.

## License

MIT
