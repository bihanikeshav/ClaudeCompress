import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  appendFileSync,
  mkdirSync,
  statSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { VERSION } from "./version.ts";

/**
 * Lightweight always-on logger for claudecompress. Writes structured
 * JSON-lines entries to ~/.claude/claudecompress/events.log so that
 * when a user reports a bug in a later session, the tail of this file
 * has everything we need to reconstruct what happened: timestamps,
 * version, source file, error message + stack, and any context the
 * caller passed in.
 *
 * Shipping this in the released version is deliberate. Errors happen
 * on user machines we can't reach, and without a log there's no way
 * to diagnose them. File is rotated at 2MB with one backup; worst case
 * the user has ~4MB of logs sitting in their .claude dir.
 *
 * Every function here swallows its own errors — logging MUST NOT be
 * able to break the process it's instrumenting.
 */

const LOG_DIR = join(homedir(), ".claude", "claudecompress");
const LOG_PATH = join(LOG_DIR, "events.log");
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const BACKUP_PATH = LOG_PATH + ".1";

let warned = false;

function ensureDirOnce(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function rotateIfNeeded(): void {
  try {
    const st = statSync(LOG_PATH);
    if (st.size < MAX_SIZE) return;
    try {
      if (existsSync(BACKUP_PATH)) unlinkSync(BACKUP_PATH);
    } catch {
      // ignore
    }
    renameSync(LOG_PATH, BACKUP_PATH);
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

function writeLine(obj: Record<string, unknown>): void {
  try {
    ensureDirOnce();
    rotateIfNeeded();
    appendFileSync(LOG_PATH, JSON.stringify(obj) + "\n", "utf8");
  } catch (err) {
    // If we can't even write to the log, fall back to stderr once.
    if (!warned) {
      warned = true;
      try {
        process.stderr.write(
          `[claudecompress] warning: could not write to ${LOG_PATH} (${String(
            err instanceof Error ? err.message : err,
          )})\n`,
        );
      } catch {
        // really nothing we can do
      }
    }
  }
}

function basePayload(source: string, level: "error" | "info"): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    v: VERSION,
    level,
    pid: process.pid,
    platform: process.platform,
    source,
  };
}

/**
 * Log an error with full context. `source` is a short label like
 * "ccw.performPendingTrim" or "hook.runCompressHook" so the caller
 * is obvious in tail. `ctx` is an optional record of state at the
 * moment of the error (session id, mode, paths, etc.).
 */
export function logError(
  source: string,
  err: unknown,
  ctx?: Record<string, unknown>,
): void {
  const payload = basePayload(source, "error");
  if (err instanceof Error) {
    payload.error = err.message;
    payload.stack = err.stack;
    if ((err as NodeJS.ErrnoException).code) {
      payload.code = (err as NodeJS.ErrnoException).code;
    }
  } else {
    payload.error = String(err);
  }
  if (ctx) payload.ctx = ctx;
  writeLine(payload);
}

/**
 * Log a lifecycle event. Use sparingly — just enough to give errors
 * narrative context (compress started, session resolved, resume fired).
 * Not for debug tracing.
 */
export function logEvent(
  source: string,
  message: string,
  ctx?: Record<string, unknown>,
): void {
  const payload = basePayload(source, "info");
  payload.message = message;
  if (ctx) payload.ctx = ctx;
  writeLine(payload);
}

export function getLogPath(): string {
  return LOG_PATH;
}
