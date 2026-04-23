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
/compress               # safe (default) — observation masking + last 5 verbatim
/compress safe 15       # keep a wider recent window
/compress smart         # per-component rules — middle ground (~45% saved)
/compress slim          # aggressive — drops older tool_use breadcrumbs (~70% saved)
/compress archive       # historical only — dialog-only throughout (~84% saved)
/compress force         # override cache-warm refusal
```

Hook output:

```
┌─ claudecompress ────────────────────────────────────────┐
  mode:   safe (last 5) · drop thinking (outside last-N) · squash
  tokens: 761k → 502k      (saved ≈ 259k)
  cost:   $7.61 → $5.02    (saved ≈ $2.59)   [Opus 4.6 · 1h cache cold rebuild]
  trimmed session: 17420d99-7152-4359-bfdd-34c2cefe77e3
└─────────────────────────────────────────────────────────┘
  Exit this session (Ctrl+C), then run:
    claude --resume 17420d99-7152-4359-bfdd-34c2cefe77e3
```

Original JSONL is never touched. The trimmed sibling gets a fresh UUID and a `[TRIMMED by claudecompress]` prefix on the first user message, making it obvious in `/resume`.

The running session can't be mutated from a hook; only `/compact` can, since it's in-process. Under `ccw` the hook auto-exits claude so the respawn loop picks up the trimmed session — you don't have to press Ctrl+C. Without `ccw`, press Ctrl+C twice and run the printed `--resume` command.

**When cache is still warm, `/compress` refuses** and suggests `/compact` instead. `/compress` forces a resume and rebuilds the cache cold — that only pays off once the cache has already expired. While warm, `/compact` is the cheaper path: it shrinks context in place, no rebuild. Override with `/compress force` (or `/compress slim 5 force`) if you really want to trim a warm session.

### Taking a break: `/break`

Stepping away for a bit? `/break 15` prints the right `/loop` command to keep your prompt cache warm while you're gone.

```
/break           # 15 minutes (default)
/break 30        # 30 minutes
/break 120       # 2 hours (good for lunch on 1h cache)
```

Hook output:

```
┌─ claudecompress /break ─────────────────────────────────┐
  break:      30 min
  cache:      5m TTL
  pings:      ~7 (every 4m30s)
  cost/ping:  $2.28  (cache read · 760k tokens)
  total:      ~$15.96
└─────────────────────────────────────────────────────────┘
  To hold the cache warm during your break, run:
    /loop 4m30s .
  Ctrl+C the loop when you're back.
```

Detects cache mode automatically (1h cache outlasts most breaks; 5m needs pings). If your cache will survive the break, `/break` tells you so — no pings needed.

`/loop` is Claude Code's native scheduling primitive; `/break` just computes the right interval based on your current cache TTL and session size. Copy the printed command and run it.

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

Under `ccw`, `/compress` auto-exits the current session and `ccw` respawns `claude --resume <new-hash>` for you. No Ctrl+C needed.

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

Four modes, measured on a 761k-token Opus 4.6 session (153 user turns):

| Mode | % saved | $ saved | Quality risk | What it does |
|---|---|---|---|---|
| ⭐ **safe** (default, N=5) | 34.0% | $2.59 | Low | keep last N turns verbatim; observation-mask older (JetBrains-validated) |
| **smart** | 45.3% | $3.44 | Low-Med | per-component rules by turn depth; tool_use skeleton survives always |
| **slim** (N=5) | 72.8% | $5.54 | Med | keep last N; older turns become dialog-only trail (loses breadcrumbs) |
| **archive** | 83.5% | $6.35 | High | historical only — drops everything structural, user+assistant text only |

All modes also apply **squash** (rtk-style per-tool-call compression) to preserved tool outputs. Verbose `git push`, `npm install`, test runner, and similar commands get rewritten to their signal (pass/fail, count, error lines) instead of raw output. Adds ~1-2% savings on top with no quality cost.

**Why `safe` is the default.** JetBrains' 2025 NeurIPS study ("The Complexity Trap") tested **observation masking** — keeping tool call names and arguments but dropping old tool_result bodies — on 500 SWE-bench Verified tasks. It matched or beat LLM summarization on 4/5 model configs at 52% lower cost. `safe` implements exactly that pattern.

**`smart`** is the intelligent middle ground. It applies different rules to different content types at different turn depths — Read results drop after 15 turns, Bash truncates at 300 chars in the 6-15 band, Agent results (pre-summarized) survive longer, thinking drops beyond recent, `tool_use` metadata stays as a skeleton even at depth. Saves more than `safe` while keeping more structure than `slim`.

**`slim`** is more aggressive — it also drops `tool_use` metadata from older turns, which is **outside what any public benchmark has validated either way**. For topic-pivoting sessions, Chroma's Context Rot work suggests stale tool metadata could act as a distractor and `slim` might actually help; for continuing the same task, keeping metadata is the safer call.

See [theory →](https://bihanikeshav.github.io/ClaudeCompress/theory/) for per-component relevance decay curves and how the `smart` rule table was derived.

**N counts your user messages**, not JSONL records. Each time you send a message, everything the agent does in response (tool calls, tool results, thinking, reply) is one "user turn". `safe 5` keeps the last 5 back-and-forths fully intact and observation-masks everything older.

**Drop-thinking** (`safe`/`slim` only): scoped to turns outside the last-N window. `smart` handles thinking per-band in its own rules.

Cost reflects **cold /resume** on Claude Code, which rebuilds the full session into 1h cache. Per Anthropic's pricing: 1h cache write = 2× base input. For Opus 4.6 that's $10/Mtok (= 2 × $5/Mtok base). The full 1M context is billed at flat per-token rates — no tier pricing on Opus 4.5+. Token counts are char-based approximations within ~10% of Anthropic's tokenizer. Run `bunx claudecompress` on your own sessions to verify.

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
