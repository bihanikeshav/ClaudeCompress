import { test, expect, describe } from "bun:test";
import {
  isOurStatusline,
  hasExistingPreCompactHook,
  addPreCompactHook,
  removePreCompactHook,
} from "../src/install.ts";

/**
 * C2 regression: the substring check used to be `cmd.includes("claudecompress statusline")`,
 * which missed the bun-mode command shape. Both install re-detection and
 * uninstall cleanup silently did nothing for users on the preferred (bun)
 * code path. These tests lock in the recognition of both shapes.
 */
describe("isOurStatusline (C2 regression)", () => {
  test("recognizes plain-CLI shape: `claudecompress statusline`", () => {
    expect(isOurStatusline("claudecompress statusline")).toBe(true);
  });

  test("recognizes bun-mode shape with quoted Windows path", () => {
    const cmd = `bun "C:/Users/Keshav/node_modules/claudecompress/dist/index.js" statusline`;
    expect(isOurStatusline(cmd)).toBe(true);
  });

  test("recognizes bun-mode shape with forward-slash POSIX path", () => {
    const cmd = `bun /home/alex/.bun/install/global/node_modules/claudecompress/dist/index.js statusline`;
    expect(isOurStatusline(cmd)).toBe(true);
  });

  test("recognizes bun-mode shape with backslash Windows path (unlikely but possible)", () => {
    const cmd = `bun "C:\\Users\\Keshav\\node_modules\\claudecompress\\dist\\index.js" statusline`;
    expect(isOurStatusline(cmd)).toBe(true);
  });

  test("rejects unrelated statusLine scripts", () => {
    expect(isOurStatusline("/usr/local/bin/my-custom-statusline.sh")).toBe(false);
    expect(isOurStatusline("bun /some/other/tool/dist/index.js statusline")).toBe(false);
    expect(isOurStatusline("echo hello")).toBe(false);
  });

  test("rejects claudecompress subcommands that aren't statusline", () => {
    // If the user has a hook command stored here by accident, it contains
    // "claudecompress" but NOT the statusline subcommand — don't claim it.
    expect(isOurStatusline("claudecompress hook")).toBe(false);
    expect(isOurStatusline("claudecompress install")).toBe(false);
    expect(isOurStatusline("bun /home/x/node_modules/claudecompress/dist/index.js hook")).toBe(false);
  });

  test("rejects empty / null / non-string inputs", () => {
    expect(isOurStatusline("")).toBe(false);
    expect(isOurStatusline("   ")).toBe(false);
    expect(isOurStatusline(undefined)).toBe(false);
    expect(isOurStatusline(null)).toBe(false);
    // The function is typed string-or-null-or-undefined; anything else
    // must be rejected too because settings.json is user-editable.
    expect(isOurStatusline((42 as unknown) as string)).toBe(false);
  });
});

/**
 * PreCompact archive hook: install() adds a `hooks.PreCompact` entry with
 * no matcher (fires on both manual and auto compaction), and uninstall()
 * removes exactly ours while leaving foreign PreCompact hooks intact.
 * Tested at the pure-function level, same as the rest of this file.
 */
describe("PreCompact hook settings mutations", () => {
  test("addPreCompactHook creates hooks.PreCompact with our command and no matcher", () => {
    const settings: any = {};
    addPreCompactHook(settings, "claudecompress hook");

    expect(Array.isArray(settings.hooks.PreCompact)).toBe(true);
    expect(settings.hooks.PreCompact).toHaveLength(1);
    const entry = settings.hooks.PreCompact[0];
    expect(entry.matcher).toBeUndefined(); // no matcher → manual AND auto
    expect(entry.hooks).toEqual([
      { type: "command", command: "claudecompress hook" },
    ]);
  });

  test("hasExistingPreCompactHook detects both plain-CLI and npx command shapes", () => {
    for (const command of ["claudecompress hook", "npx -y claudecompress hook"]) {
      const settings: any = {};
      expect(hasExistingPreCompactHook(settings)).toBe(false);
      addPreCompactHook(settings, command);
      expect(hasExistingPreCompactHook(settings)).toBe(true);
    }
  });

  test("hasExistingPreCompactHook ignores foreign PreCompact hooks and UserPromptSubmit entries", () => {
    const settings: any = {
      hooks: {
        PreCompact: [{ hooks: [{ type: "command", command: "some-other-tool" }] }],
        UserPromptSubmit: [
          { matcher: "^/compress", hooks: [{ type: "command", command: "claudecompress hook" }] },
        ],
      },
    };
    expect(hasExistingPreCompactHook(settings)).toBe(false);
  });

  test("removePreCompactHook removes only our entry, preserving foreign hooks", () => {
    const settings: any = {
      hooks: {
        PreCompact: [{ hooks: [{ type: "command", command: "some-other-tool" }] }],
      },
    };
    addPreCompactHook(settings, "claudecompress hook");
    expect(settings.hooks.PreCompact).toHaveLength(2);

    const removed = removePreCompactHook(settings);
    expect(removed).toBe(1);
    expect(settings.hooks.PreCompact).toHaveLength(1);
    expect(settings.hooks.PreCompact[0].hooks[0].command).toBe("some-other-tool");
    expect(hasExistingPreCompactHook(settings)).toBe(false);
  });

  test("removePreCompactHook is a no-op on settings without the key", () => {
    expect(removePreCompactHook({})).toBe(0);
    expect(removePreCompactHook({ hooks: {} })).toBe(0);
  });

  test("add → remove round-trips (uninstall undoes install)", () => {
    const settings: any = {};
    addPreCompactHook(settings, "claudecompress hook");
    expect(hasExistingPreCompactHook(settings)).toBe(true);
    expect(removePreCompactHook(settings)).toBe(1);
    expect(hasExistingPreCompactHook(settings)).toBe(false);
    expect(settings.hooks.PreCompact).toEqual([]);
  });
});
