import {
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";

interface StatuslineInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface LatestInfo {
  timestamp: Date | null;
  usage: Usage | null;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    // Claude Code always pipes stdin, but be defensive.
    setTimeout(finish, 250).unref?.();
  });
}

/**
 * Read the tail of a potentially large JSONL file to find the latest record
 * carrying a `message.usage` block. Avoids O(file size) work on every
 * statusline tick.
 */
function readTail(path: string, maxBytes = 500_000): string {
  const st = statSync(path);
  if (st.size <= maxBytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const offset = st.size - maxBytes;
    readSync(fd, buf, 0, maxBytes, offset);
    let s = buf.toString("utf8");
    const nl = s.indexOf("\n");
    if (nl >= 0) s = s.slice(nl + 1); // drop partial first line
    return s;
  } finally {
    closeSync(fd);
  }
}

function findLatestUsage(path: string): LatestInfo {
  let data: string;
  try {
    data = readTail(path);
  } catch {
    return { timestamp: null, usage: null };
  }
  const lines = data.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const usage: Usage | undefined = rec?.message?.usage;
    if (!usage) continue;
    const hasCache =
      (usage.cache_creation_input_tokens ?? 0) > 0 ||
      (usage.cache_read_input_tokens ?? 0) > 0 ||
      (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0 ||
      (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0;
    if (!hasCache) continue;
    const ts = rec?.timestamp ? new Date(rec.timestamp) : null;
    return { timestamp: ts, usage };
  }
  return { timestamp: null, usage: null };
}

function fmtRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export async function runStatusline(): Promise<void> {
  const raw = await readStdin();
  let input: StatuslineInput = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // still render *something* so a parse error doesn't blank the statusline
  }
  const path = input.transcript_path;
  if (!path) {
    process.stdout.write("");
    return;
  }
  const { timestamp, usage } = findLatestUsage(path);
  if (!timestamp || !usage) {
    process.stdout.write("◉ new session · cache not yet seeded");
    return;
  }
  const is1h =
    (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0;
  const ttlSec = is1h ? 3600 : 300;
  const ageSec = (Date.now() - timestamp.getTime()) / 1000;
  const remainingSec = ttlSec - ageSec;
  const mode = is1h ? "1h" : "5m";
  const modelLabel = input.model?.display_name ?? input.model?.id ?? "";
  const modelTag = modelLabel ? ` · ${modelLabel}` : "";

  if (remainingSec > 0) {
    process.stdout.write(
      `◉ cache warm · ${mode} · ${fmtRemaining(remainingSec)} left${modelTag}`,
    );
  } else {
    const cold = fmtElapsed(-remainingSec);
    process.stdout.write(
      `○ cache cold · ${cold} past${modelTag} · /compress recommended`,
    );
  }
}
