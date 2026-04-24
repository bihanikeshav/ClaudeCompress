#!/usr/bin/env node
// Keep docs/index.html's header version badge in sync with package.json.
// Runs as part of `bun run build` so there's a single source of truth
// for the published version across npm and the marketing site.
//
// Marker: any element with `data-version-sync` gets its text content
// replaced with `v<version-from-package.json>`.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

const targets = [
  join(root, "docs", "index.html"),
  join(root, "docs", "theory", "index.html"),
];

// Matches an element with `data-version-sync` and replaces its text
// content. Attribute order within the tag doesn't matter. The text
// between the opening and closing tag gets fully replaced.
const re = /(<([a-zA-Z]+)\b[^>]*\bdata-version-sync\b[^>]*>)[^<]*(<\/\2>)/g;

let changed = 0;
for (const file of targets) {
  let html;
  try { html = readFileSync(file, "utf8"); } catch { continue; }
  const next = html.replace(re, `$1v${version}$3`);
  if (next !== html) {
    writeFileSync(file, next);
    changed += 1;
    console.log(`sync-version: ${file} → v${version}`);
  }
}
if (changed === 0) console.log(`sync-version: already at v${version} (no changes)`);
