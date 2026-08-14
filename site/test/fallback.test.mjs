import { test } from "node:test";
import assert from "node:assert/strict";

import conformanceData from "../src/_data/conformance.js";
import changelogData from "../src/_data/changelog.js";

// When the upstream fetch rejects, the data file must return the committed
// fallback model and the build must not fail.
test("conformance data falls back to the committed snapshot when the fetch fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network disabled for test"));
  try {
    const model = await conformanceData();
    assert.equal(model.source, "fallback");
    assert.ok(model.fallbackError, "records why the fetch failed");
    assert.ok(model.latest, "fallback still yields a latest run");
    assert.ok(model.runs.length > 0, "fallback yields runs");
    assert.ok(model.perTarget.dynamodb, "fallback yields the DynamoDB baseline");
    assert.match(model.historyHash, /^[0-9a-f]{16}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The scheduled-deploy guard: with FAIL_ON_FALLBACK set, a failed fetch must
// throw (failing the build) rather than quietly shipping the committed fallback.
test("FAIL_ON_FALLBACK makes the data file throw instead of returning the fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network disabled for test"));
  process.env.FAIL_ON_FALLBACK = "1";
  try {
    await assert.rejects(() => conformanceData(), /refused to ship the committed fallback/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FAIL_ON_FALLBACK;
  }
});

// The changelog needs the same refusal as the history. It renders a page and
// its entries carry the test-count badges, so a scheduled build that shipped
// fresh scores beside a stale changelog would publish a page disagreeing with
// the run it sits next to. The guard used to cover only unparseable headings,
// which meant an outage took the quiet path.
test("the changelog falls back on a failed fetch, and refuses to under FAIL_ON_FALLBACK", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network disabled for test"));
  try {
    const lenient = await changelogData();
    assert.equal(lenient.source, "fallback");
    assert.ok(lenient.entries.length > 0, "the fallback still yields entries");

    process.env.FAIL_ON_FALLBACK = "1";
    await assert.rejects(
      () => changelogData(),
      /refused to ship the committed changelog fallback/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FAIL_ON_FALLBACK;
  }
});

// A committed fallback predating per-(target, run) pages carries no targetRuns,
// and Eleventy treats missing pagination data as fatal for the whole build, not
// just the template that wanted it. Asserted rather than assumed, so it keeps
// holding once `npm run snapshot` regenerates the fixture with the key present.
test("the fallback yields targetRuns whether or not the committed snapshot carries it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("network disabled for test"));
  try {
    const model = await conformanceData();
    assert.equal(model.source, "fallback");
    assert.ok(Array.isArray(model.targetRuns), "targetRuns must exist");
    assert.ok(model.targetRuns.length > 0, "and must not be empty");
    const [pair] = model.targetRuns;
    assert.ok(pair.slug && pair.runId, "each pair identifies a target and a run");
    assert.ok(model.perTarget[pair.slug].series.some((p) => p.runId === pair.runId), "every pair resolves to a series point the page can render");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The other half of the changelog guard: a fetch that succeeds but returns a
// heading the parser cannot read. Every test above mocks a rejecting fetch, so
// this path - the one the Unreleased convention sits directly upstream of - was
// never exercised. deploy.yml sets FAIL_ON_FALLBACK on every push to main that
// touches CHANGELOG.md, so this is what a malformed heading does to a deploy.
test("FAIL_ON_FALLBACK refuses a fetched changelog carrying an unreadable heading", async () => {
  const originalFetch = globalThis.fetch;
  const body = ["# History", "", "## Coming soon", "", "Pending.", "", "## 2026-07-01", "", "Added a tier."].join("\n");
  globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
  try {
    // Lenient: renders what it could read, and says what it left off.
    const lenient = await changelogData();
    assert.equal(lenient.source, "remote");
    assert.deepEqual(lenient.skipped, ["Coming soon"]);

    process.env.FAIL_ON_FALLBACK = "1";
    await assert.rejects(() => changelogData(), /refused to ship an incomplete changelog/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FAIL_ON_FALLBACK;
  }
});

// And the convention itself must not trip that guard.
test("an Unreleased section does not count as an unreadable heading", async () => {
  const originalFetch = globalThis.fetch;
  const body = ["# History", "", "## Unreleased", "", "Pending.", "", "## 2026-07-01", "", "Added a tier."].join("\n");
  globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
  try {
    process.env.FAIL_ON_FALLBACK = "1";
    const data = await changelogData();
    assert.deepEqual(data.skipped, []);
    assert.ok(data.unreleased, "the pending section is kept, not discarded");
    assert.deepEqual(data.entries.map((e) => e.date), ["2026-07-01"]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FAIL_ON_FALLBACK;
  }
});
