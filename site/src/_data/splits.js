// $data.splits: the suite's confirmed regional splits, for the explainer's live
// evidence. Current-state (no history walk), remote fetch with a committed
// fallback, degrading to unavailable so the explainer falls back to prose.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildSplitsModel } from "../../lib/splits.mjs";

const RAW_URL = "https://raw.githubusercontent.com/paritysuite/dynamodb-conformance/main/registry/splits.json";
const FETCH_TIMEOUT_MS = 5000;
const FALLBACK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "splits-fallback.json");

function loudFallbackSignal(message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning title=Splits fallback::${message}`);
  }
  console.warn(`[splits] ${message}`);
}

export default async function () {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(RAW_URL, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const model = buildSplitsModel(await res.json());
    if (!model.available) throw new Error("no splits in fetched registry");
    return { ...model, source: "remote" };
  } catch (err) {
    loudFallbackSignal(`registry fetch failed (${err.message}); trying committed fallback`);
    try {
      const model = buildSplitsModel(JSON.parse(await readFile(FALLBACK_PATH, "utf8")));
      return { ...model, source: "fallback", fallbackError: err.message };
    } catch (fbErr) {
      loudFallbackSignal(`no committed splits fallback (${fbErr.message}); rendering the explainer without live evidence`);
      return { available: false, splits: [], count: 0, featured: null, source: "unavailable" };
    }
  }
}
