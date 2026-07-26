#!/usr/bin/env node
// Fingerprint the built stylesheet with a content hash, so its cache-busting
// query changes only when the CSS actually changes.
//
// The stylesheet is served immutable (max-age one year), so it needs a query to
// bust returning visitors' caches when it changes. A build-time timestamp busted
// it on every deploy even when the bytes were identical, and rendered a slightly
// different value per page (each page built on a different tick), so navigating
// between pages re-fetched the render-blocking CSS. A content hash fixes both:
// every page in a build shares one URL, and the URL is stable across deploys
// that don't touch the CSS.
//
// Runs after build:css, because Tailwind builds the stylesheet by scanning the
// rendered HTML, so it doesn't exist until eleventy has run.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "_site");

const css = await readFile(join(SITE, "css", "style.css"));
const hash = createHash("sha256").update(css).digest("hex").slice(0, 12);

const entries = await readdir(SITE, { recursive: true, withFileTypes: true });
let rewritten = 0;
for (const e of entries) {
  if (!e.isFile() || !e.name.endsWith(".html")) continue;
  const file = join(e.parentPath ?? e.path, e.name);
  const html = await readFile(file, "utf8");
  const out = html.replaceAll('"/css/style.css"', `"/css/style.css?v=${hash}"`);
  if (out !== html) {
    await writeFile(file, out);
    rewritten++;
  }
}

console.error(`[fingerprint] style.css -> ?v=${hash} across ${rewritten} pages`);
