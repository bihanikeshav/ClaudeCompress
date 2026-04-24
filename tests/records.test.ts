import { test, expect, describe } from "bun:test";
import { isClientSideCommandRecord, isUserTextTurn } from "../src/records.ts";

/**
 * Foundational record classifiers — both the trimmer's keep-last-N
 * accounting and the statusline's "user is waiting on the agent" logic
 * depend on these returning the right thing for every record shape
 * Claude Code actually writes. If a new command-wrapper shape appears
 * in a future Claude Code release and these aren't updated, user turns
 * get miscounted.
 */

describe("isClientSideCommandRecord", () => {
  test("true for <local-command-*> wrappers", () => {
    const rec = { type: "user", message: { content: "<local-command-stdout>some output</local-command-stdout>" } };
    expect(isClientSideCommandRecord(rec)).toBe(true);
  });

  test("true for <command-name>, <command-message>, <command-args>", () => {
    for (const wrapper of ["<command-name>", "<command-message>", "<command-args>"]) {
      const rec = { type: "user", message: { content: `${wrapper}foo` } };
      expect(isClientSideCommandRecord(rec)).toBe(true);
    }
  });

  test("true for bare typed slash commands like /context or /compact foo", () => {
    expect(isClientSideCommandRecord({ type: "user", message: { content: "/context" } })).toBe(true);
    expect(isClientSideCommandRecord({ type: "user", message: { content: "/compact foo" } })).toBe(true);
    expect(isClientSideCommandRecord({ type: "user", message: { content: "  /context  " } })).toBe(true);
  });

  test("false for plain user text", () => {
    expect(isClientSideCommandRecord({ type: "user", message: { content: "hello there" } })).toBe(false);
    expect(isClientSideCommandRecord({ type: "user", message: { content: "can you fix this?" } })).toBe(false);
  });

  test("false for user text that merely mentions a slash command mid-sentence", () => {
    // Only records that START with a slash command count.
    expect(isClientSideCommandRecord({ type: "user", message: { content: "run /compact please" } })).toBe(false);
  });

  test("false for tool_result user records (array content)", () => {
    const rec = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] },
    };
    expect(isClientSideCommandRecord(rec)).toBe(false);
  });

  test("false for garbage / missing records", () => {
    expect(isClientSideCommandRecord({})).toBe(false);
    expect(isClientSideCommandRecord({ type: "user" })).toBe(false);
    expect(isClientSideCommandRecord({ type: "user", message: {} })).toBe(false);
    expect(isClientSideCommandRecord(null)).toBe(false);
    expect(isClientSideCommandRecord(undefined)).toBe(false);
  });
});

describe("isUserTextTurn", () => {
  test("true for plain user text", () => {
    expect(isUserTextTurn({ type: "user", message: { content: "hello" } })).toBe(true);
  });

  test("false for assistant records", () => {
    expect(isUserTextTurn({ type: "assistant", message: { content: "hi" } })).toBe(false);
  });

  test("false for tool_result user records (array content)", () => {
    const rec = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] },
    };
    expect(isUserTextTurn(rec)).toBe(false);
  });

  test("false for client-side command records", () => {
    expect(isUserTextTurn({ type: "user", message: { content: "/context" } })).toBe(false);
    expect(isUserTextTurn({ type: "user", message: { content: "<local-command-stdout>x</local-command-stdout>" } })).toBe(false);
  });
});
