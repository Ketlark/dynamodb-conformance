import { test } from "node:test";
import assert from "node:assert/strict";

import summaryData from "../src/_data/summary.js";
import { assemble, resetSummaryCache } from "../lib/summary-source.mjs";

// When the remote fetch fails, the data file must return the committed fallback
// so the per-region overlay still renders offline and in CI without a token.
test("summary data falls back to the committed snapshot when the fetch fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network disabled for test"));
  resetSummaryCache();
  try {
    const model = await summaryData();
    assert.equal(model.source, "fallback");
    assert.equal(model.available, true);
    assert.ok(model.fallbackError, "records why the fetch failed");
    assert.ok(model.latest, "fallback still yields a latest run");
    assert.ok(model.latest.regions.observed.length > 3, "fallback carries the full observed set");
  } finally {
    globalThis.fetch = originalFetch;
    resetSummaryCache();
  }
});

// The summary feeds the headline score (enrichSnapshot in lib/history.mjs rewrites
// each target's total with the summary's best-match region rate), so under
// FAIL_ON_FALLBACK it must refuse a stale overlay the same way the conformance
// history does. Otherwise a scheduled build with a live results fetch but a
// timed-out summary fetch ships fresh scores computed from a stale region model.
test("summary throws under FAIL_ON_FALLBACK instead of returning a stale overlay", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network disabled for test"));
  resetSummaryCache();
  process.env.FAIL_ON_FALLBACK = "1";
  try {
    await assert.rejects(() => summaryData(), /refused the committed summary fallback/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FAIL_ON_FALLBACK;
    resetSummaryCache();
  }
});

// assemble keys snapshots by run date, keeping the newest commit per date, and
// picks the latest run date as `latest`.
test("assemble keys snapshots by run date and picks the latest", () => {
  const snap = (runDate, dynoxideRate) => ({
    sha: `sha-${runDate}-${dynoxideRate}`,
    raw: {
      schemaVersion: 1,
      groundTruth: { slug: "dynamodb", rate: 100, runDate },
      regions: { observed: ["eu-west-2", "us-east-1"], unresolved: [], dropped: [], detail: {} },
      targets: {
        dynoxide: {
          headline: { region: "eu-west-2", rate: dynoxideRate },
          regions: {
            "eu-west-2": { rate: dynoxideRate, passed: 1, failed: 0, skipped: 0, indeterminate: 0, count: 1, tiers: { tier1: { p: 1, f: 0, s: 0, i: 0 }, tier2: {}, tier3: {} } },
            "us-east-1": { rate: dynoxideRate, passed: 1, failed: 0, skipped: 0, indeterminate: 0, count: 1, tiers: { tier1: { p: 1, f: 0, s: 0, i: 0 }, tier2: {}, tier3: {} } },
          },
        },
      },
    },
  });

  // Newest first: two commits share 2026-07-16; the first (newest) wins.
  const snapshots = [snap("2026-07-16", 99.4), snap("2026-07-16", 12.3), snap("2026-07-13", 88.0)];
  const a = assemble(snapshots);
  assert.deepEqual(a.runDates, ["2026-07-13", "2026-07-16"]);
  assert.equal(a.latestRunDate, "2026-07-16");
  assert.equal(a.latest.targets.dynoxide.rate, 99.4, "newest commit for the date wins");
  assert.ok(a.byRunDate["2026-07-13"], "older run date is retained for the timeline");
});

test("assemble skips snapshots with no usable run date without throwing", () => {
  const a = assemble([{ sha: "x", raw: { schemaVersion: 2 } }, { sha: "y", raw: null }]);
  assert.deepEqual(a.runDates, []);
  assert.equal(a.latest, null);
});
