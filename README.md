# ClaudeCompress

Shrink Claude Code session transcripts so `/resume` on long conversations doesn't cost you a full cache-miss rebuild.

```
bunx cccompress
```

Interactive CLI — picks your project, lists sessions, shows a size breakdown, asks how aggressively to trim, and writes a stripped copy alongside the original. Your source JSONL is never modified.

## Why

Claude Code stores every session as a `.jsonl` in `~/.claude/projects/<encoded-cwd>/`. When you `/resume` a long session after the prompt cache expires (5-minute TTL), every token gets billed as a fresh input. A 600k-token conversation can cost several dollars just to warm back up.

Most of that weight is tool output — `Read` dumps, `Bash` command results, web fetches — which the model already acted on and rarely needs verbatim again. ClaudeCompress redacts that payload while keeping the conversation structure intact, so `/resume` still works but the replay is dramatically smaller.

## Modes

| Mode | What it keeps | What it drops | Typical ratio |
|------|---------------|---------------|---------------|
| **Ultra** | user + assistant text turns only | tool calls, tool results, thinking, attachments, snapshots | ~3–5% of original |
| **Redact** | structure + tool names + inputs | tool result bodies (replaced with a short marker) | ~60–70% of original |
| **Truncate** | structure + first N chars of each tool result | the rest | tunable |

Ultra gives the biggest win but loses the ability to reference past file reads / command outputs. Redact keeps enough structure that the model on resume sees *what* it did, just not the raw output.

## Usage

```bash
bunx cccompress
```

Or from a clone:

```bash
git clone https://github.com/bihanikeshav/ClaudeCompress
cd ClaudeCompress
bun install
bun run src/index.ts
```

Output is a new `.jsonl` in the same project dir with a fresh session UUID. In `/resume` it shows up prefixed with `[TRIMMED by cccompress]` so you can tell it apart from the original.

**One gotcha:** `/context` may display a cached value from the source session for the first render. Send any message (e.g. `hi`) and it recomputes against the actual trimmed content.

## What's in the JSONL

Run without `--trim` equivalent (just navigate the interactive prompts and back out) to see the size breakdown by block type:

```
user/tool_result                1614      10.64 MB    30.0%
user/image                        18       2.24 MB     6.3%
assistant/tool_use              1614       1.41 MB     4.0%
file-history-snapshot            417       1.24 MB     3.5%
assistant/thinking               424     992.11 KB     2.7%
attachment                       236     880.16 KB     2.4%
assistant/text                   639     188.94 KB     0.5%
```

Tool results dominate almost every real session. That's the fat you're paying to reload.

## How it works

- Parses the session `.jsonl` line-by-line (no full load into memory).
- For each block type, applies the chosen transform.
- Generates a fresh `sessionId` UUID so the new file lives alongside the original — nothing is overwritten.
- In Ultra mode, rewires `parentUuid` chains across dropped records so the thread stays internally consistent.
- Prepends `[TRIMMED by cccompress]` to the first user message so it's visually distinct in `/resume`.

## License

MIT
