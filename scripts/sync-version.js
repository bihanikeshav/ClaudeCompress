#!/usr/bin/env node
// Keep derived version strings in sync with package.json. Runs as part
// of `bun run build` so there's a single source of truth across the
// npm package, the marketing site, and the in-binary VERSION constant
// used by the error logger.
//
// Targets:
//   - docs/**/*.html  — any <tag data-version-sync>...</tag> text
//   - src/version.ts  — export const VERSION = "...";

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

const htmlTargets = [
  join(root, "docs", "index.html"),
  join(root, "docs", "theory", "index.html"),
];

// Matches an element with `data-version-sync` and replaces its text
// content. Attribute order within the tag doesn't matter. The text
// between the opening and closing tag gets fully replaced.
const re = /(<([a-zA-Z]+)\b[^>]*\bdata-version-sync\b[^>]*>)[^<]*(<\/\2>)/g;

let changed = 0;
for (const file of htmlTargets) {
  let html;
  try { html = readFileSync(file, "utf8"); } catch { continue; }
  const next = html.replace(re, `$1v${version}$3`);
  if (next !== html) {
    writeFileSync(file, next);
    changed += 1;
    console.log(`sync-version: ${file} → v${version}`);
  }
}

// src/version.ts — used at runtime by errorLog so every log entry
// carries the exact version the user is running.
const versionTs = join(root, "src", "version.ts");
try {
  const current = readFileSync(versionTs, "utf8");
  const next =
    "// Version constant kept in sync with package.json by scripts/sync-version.js.\n" +
    "// Do not edit by hand — run `bun run build` to regenerate.\n" +
    `export const VERSION = "${version}";\n`;
  if (current !== next) {
    writeFileSync(versionTs, next);
    changed += 1;
    console.log(`sync-version: ${versionTs} → v${version}`);
  }
} catch {
  // missing src/version.ts is not fatal — the bundler will error if
  // it's actually needed, which is louder than a silent create here.
}

if (changed === 0) console.log(`sync-version: already at v${version} (no changes)`);
