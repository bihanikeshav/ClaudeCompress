import { test, expect, describe } from "bun:test";
import { isOurStatusline } from "../src/install.ts";

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
