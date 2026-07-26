// Load the per-region summary model at build time, with a committed fallback.
//
// This is the one place the summary is fetched. Both src/_data/summary.js (for
// $data.summary) and src/_data/conformance.js (for the history join) call
// loadSummary(), and the result is memoised so the network work happens once
// per build.
//
// The per-region layer is additive: if it can't be loaded, the site degrades to
// its eu-west-2-only story rather than failing. So unlike the core conformance
// history, a summary that can't be fetched and has no committed fallback returns
// an unavailable marker (build stays green) rather than throwing. A committed
// fallback is still used when present, with a loud CI warning, so a stale
// overlay is visible rather than silent.
//
// FAIL_ON_FALLBACK overrides that leniency, for the same reason it does on the
// conformance history: the summary is not really additive once it lands, because
// enrichSnapshot rewrites each target's headline total with the summary's
// best-match region rate. A scheduled build that fetched live results but a stale
// summary would ship fresh scores built on a stale region model, which is exactly
// the silent staleness the flag exists to prevent.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchSummaries } from "./summary-fetch.mjs";
import { buildSummaryModel } from "./summary.mjs";

const FALLBACK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "summary-history.json");

function loudFallbackSignal(message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning title=Summary fallback::${message}`);
  }
  console.warn(`[summary] ${message}`);
}

// Turn the fetched snapshots (newest first) into per-run-date models. The first
// snapshot seen for a run date is the latest commit for it, so it wins.
export function assemble(snapshots) {
  const byRunDate = {};
  for (const s of snapshots) {
    const model = buildSummaryModel(s.raw);
    if (!model.available || !model.runDate) continue;
    if (!(model.runDate in byRunDate)) byRunDate[model.runDate] = { ...model, sha: s.sha };
  }
  const runDates = Object.keys(byRunDate).sort(); // oldest first
  const latestRunDate = runDates.length ? runDates[runDates.length - 1] : null;
  const latest = latestRunDate ? byRunDate[latestRunDate] : null;
  return { byRunDate, runDates, latest, latestRunDate };
}

async function doLoad({ token, timeoutMs }) {
  try {
    const snapshots = await fetchSummaries({ token, timeoutMs, log: (m) => console.log(`[summary] ${m}`) });
    if (!snapshots.length) throw new Error("no summary snapshots fetched");
    const assembled = assemble(snapshots);
    if (!assembled.latest) throw new Error("no usable summary snapshot reconstructed");
    return { available: true, source: "remote", ...assembled, generatedAt: new Date().toISOString() };
  } catch (err) {
    loudFallbackSignal(`remote summary fetch failed (${err.message}); trying committed fallback`);
    // The scheduled build refuses a stale overlay rather than enriching live
    // scores with it (see the note above). Other triggers still fall back.
    if (process.env.FAIL_ON_FALLBACK === "1") {
      throw new Error(`scheduled build refused the committed summary fallback: ${err.message}`);
    }
    try {
      const fallback = JSON.parse(await readFile(FALLBACK_PATH, "utf8"));
      return { ...fallback, source: "fallback", available: true, fallbackError: err.message };
    } catch (fbErr) {
      // No overlay available at all: the site renders its eu-west-2-only story.
      loudFallbackSignal(`no committed summary fallback (${fbErr.message}); rendering region overlay as unavailable`);
      return { available: false, source: "unavailable", byRunDate: {}, runDates: [], latest: null, latestRunDate: null, error: err.message };
    }
  }
}

let cached;

// Memoised across the build. Both data files share the one fetch.
export function loadSummary({ token = process.env.GITHUB_TOKEN, timeoutMs = 8000 } = {}) {
  if (!cached) cached = doLoad({ token, timeoutMs });
  return cached;
}

// Test seam: drop the memo so a test can exercise a fresh load.
export function resetSummaryCache() {
  cached = undefined;
}
