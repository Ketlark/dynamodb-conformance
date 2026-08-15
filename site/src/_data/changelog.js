import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseChangelog } from "../../lib/changelog.mjs";

// The authoritative suite-history log lives in the conformance repo. We fetch
// it at build time and fall back to a committed copy when the fetch fails or
// the file isn't there yet (same remote + fallback pattern as the results
// pipeline). Entries are dated, and may carry a release tag.
const RAW_URL = "https://raw.githubusercontent.com/paritysuite/dynamodb-conformance/main/CHANGELOG.md";
const FETCH_TIMEOUT_MS = 5000;
const FALLBACK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "changelog-fallback.md");

// Mirrors conformance.js: a build that quietly shipped less than it fetched is
// visible in the run summary rather than passing green and silent.
function loudSignal(message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning title=Changelog::${message}`);
  }
  console.warn(`[changelog] ${message}`);
}

async function loadMarkdown() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(RAW_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!/^## +\d{4}-\d{2}-\d{2}/m.test(body)) throw new Error("fetched body has no dated entries");
    return { body, source: "remote" };
  } catch (err) {
    // Same refusal as the history and summary sources: on the unattended
    // scheduled rebuild, shipping a stale changelog beside freshly fetched
    // scores is the silent staleness the flag exists to prevent, and both S3
    // syncs carry --delete so there is no partial publish to fall back on.
    // Other triggers still fall back and render.
    if (process.env.FAIL_ON_FALLBACK === "1") {
      throw new Error(`scheduled build refused to ship the committed changelog fallback: ${err.message}`);
    }
    const body = await readFile(FALLBACK_PATH, "utf8");
    return { body, source: "fallback", error: err.message };
  }
}

export default async function () {
  const { body, source, error } = await loadMarkdown();
  if (error) loudSignal(`remote fetch failed (${error}); using committed fallback`);

  // `unreleased` is deliberately not rendered: the page is a dated history and
  // a pending section has no date yet. It is returned so the build can see it
  // exists rather than discarding it without a word.
  const { entries, skipped, unreleased } = parseChangelog(body);

  // Said out loud, because holding notes back is the one behaviour here that
  // looks identical to losing them. Before the section was recognised, an
  // Unreleased heading failed the build; now it passes, so without this a
  // release that never dated its notes would publish a changelog missing them
  // and no build would have mentioned it. Not fatal - pending notes are the
  // normal state of a branch, not an error.
  if (unreleased) loudSignal("an Unreleased section is pending; it is held off the page until a release dates it");

  // A heading we can't read is an entry missing from the page. Say so: the site
  // rendering short on a green build is exactly how it went stale before.
  if (skipped.length) {
    const message = `${skipped.length} heading(s) not recognised as dated entries and left off the page: ${skipped.join(", ")}`;
    loudSignal(message);
    if (process.env.FAIL_ON_FALLBACK === "1") {
      throw new Error(`scheduled build refused to ship an incomplete changelog: ${message}`);
    }
  }

  // Lookup by run date, so run and target pages can surface the matching note.
  const byDate = Object.fromEntries(entries.map((e) => [e.date, e]));
  return { entries, byDate, source, skipped, unreleased, fetchedAt: new Date().toISOString() };
}
