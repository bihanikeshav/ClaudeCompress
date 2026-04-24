/**
 * Shared record-classification helpers used by the trimmer and the
 * statusline. Claude Code writes several kinds of "user" records to the
 * JSONL — plain user messages, tool_result replies, and client-side UI
 * artifacts (the `<local-command-*>` wrappers, captured slash-command
 * stdout, etc.). We care about three distinctions:
 *
 *   1. Is this a genuine conversational user turn? (trimmer uses this to
 *      count "keep last N user turns" boundaries.)
 *   2. Is this a client-side command record? (statusline uses this to
 *      avoid treating a UI artifact as "user newer than assistant".)
 *   3. Is this a tool_result record? (array content; pass through.)
 *
 * Extracted here to keep trimmer.ts and statusline.ts from drifting as
 * new command record shapes appear.
 */

/**
 * True when the record is a Claude Code client-side command artifact —
 * one of the `<local-command-*>` / `<command-*>` wrappers, or a bare
 * slash command like `/context` that the user typed. These are NOT
 * genuine "user is talking to the model" turns.
 */
export function isClientSideCommandRecord(rec: any): boolean {
  const content = rec?.message?.content;
  if (typeof content !== "string") return false;
  const trimmed = content.trimStart();
  if (
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<command-message>") ||
    trimmed.startsWith("<command-args>")
  ) {
    return true;
  }
  // Bare typed slash command — "/context" or "/compact foo". Handled
  // either client-side or by injecting new content; not a real turn.
  return /^\/[a-zA-Z][\w:-]*(\s|$)/.test(trimmed);
}

/**
 * True when the record anchors a conversational exchange — the user
 * said something that expects an assistant response. Tool_result records
 * (array content) and client-side command records (<local-command-*>,
 * bare /commands) are NOT exchange starts even though their `type` is
 * "user".
 */
export function isUserTextTurn(rec: any): boolean {
  if (rec?.type !== "user") return false;
  if (typeof rec?.message?.content !== "string") return false;
  return !isClientSideCommandRecord(rec);
}
