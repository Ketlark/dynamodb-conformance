import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchSnapshots } from "../../lib/fetch.mjs";
import { buildModel, targetRunsOf } from "../../lib/history.mjs";
import { historyDigest } from "../../lib/digest.mjs";
import { loadSummary } from "../../lib/summary-source.mjs";

const FALLBACK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "conformance-history.json");
const MANIFEST_FALLBACK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "tag-manifest.json");

// The committed tag manifest, used when the live fetch can't reach the suite's
// published copy. Empty describes degrade the capability grid to n/a rather than
// throwing.
async function readFallbackManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_FALLBACK_PATH, "utf8"));
  } catch {
    return { describes: {} };
  }
}

// Emit a GitHub Actions warning annotation when running in CI, so an
// unattended scheduled rebuild that quietly shipped stale data is visible in
// the run summary rather than passing green and silent.
function loudFallbackSignal(message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning title=Conformance fallback::${message}`);
  }
  console.warn(`[conformance] ${message}`);
}

export default async function () {
  try {
    const [snapshots, summary] = await Promise.all([
      fetchSnapshots({
        token: process.env.GITHUB_TOKEN,
        timeoutMs: 8000,
        log: (msg) => console.log(`[conformance] ${msg}`),
        fallbackManifest: await readFallbackManifest(),
      }),
      // Additive per-region overlay; unavailable degrades to eu-west-2-only.
      loadSummary(),
    ]);
    const model = buildModel(snapshots, summary);
    if (!model.latest) throw new Error("no runs reconstructed from fetched history");
    return {
      ...model,
      source: "remote",
      historyHash: historyDigest(model),
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    loudFallbackSignal(`remote history fetch failed (${err.message}); using committed fallback at data/conformance-history.json`);
    // On the unattended scheduled rebuild we'd rather fail than ship stale data
    // with a green run. Other triggers fall back and still render.
    if (process.env.FAIL_ON_FALLBACK === "1") {
      throw new Error(`scheduled build refused to ship the committed fallback: ${err.message}`);
    }
    const fallback = JSON.parse(await readFile(FALLBACK_PATH, "utf8"));
    return {
      ...fallback,
      // Derived rather than read: a fallback committed before per-(target, run)
      // pages existed carries no targetRuns, and missing pagination data fails
      // the whole build rather than just those pages.
      targetRuns: fallback.targetRuns ?? targetRunsOf(fallback),
      source: "fallback",
      fallbackError: err.message,
      historyHash: historyDigest(fallback),
      generatedAt: new Date().toISOString(),
    };
  }
}
