/**
 * Read all of stdin into a single UTF-8 string, with a timeout guard so
 * we can't hang if Claude Code (or a test harness) attaches stdin but
 * never writes to it. Used by hook.ts and statusline.ts, both of which
 * get invoked with a JSON payload on stdin.
 *
 * The timeout exists because in some Claude Code configurations the
 * hook is spawned but never receives a JSON payload — the "end" event
 * arrives normally in the good path, but without the timer we'd block
 * forever when the payload is missing.
 */
export function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    // Unref the timer so it doesn't keep the event loop alive when the
    // stream has already closed normally.
    setTimeout(finish, timeoutMs).unref?.();
  });
}
