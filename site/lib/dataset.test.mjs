import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CAPABILITIES } from "./scoring.mjs";
import { buildIndex, buildLatest, buildRuns, TIERS, DATA_SCHEMA_VERSION } from "./dataset.mjs";

// The committed history fallback is a real, fully-built model, so it doubles as
// a fixture for the data endpoints without re-deriving one here.
const MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "conformance-history.json");
const model = JSON.parse(await readFile(MODEL_PATH, "utf8"));

const site = {
  url: "https://paritysuite.org",
  sourceRepo: "https://github.com/paritysuite/dynamodb-conformance",
  dataLicense: "https://creativecommons.org/licenses/by/4.0/",
  dataLicenseName: "CC BY 4.0",
  dataAttribution: "paritysuite.org",
};

const sortedKeys = (obj) => Object.keys(obj).sort();

test("every endpoint carries the self-describing envelope", () => {
  for (const doc of [buildIndex(model, site), buildLatest(model, site), buildRuns(model, site)]) {
    assert.equal(doc.schemaVersion, DATA_SCHEMA_VERSION);
    assert.equal(doc.source, site.url);
    assert.equal(doc.license, site.dataLicense);
    assert.equal(doc.licenseName, "CC BY 4.0");
    assert.equal(doc.attribution, "paritysuite.org");
    assert.equal(doc.baseline.slug, "dynamodb");
    assert.equal(doc.baseline.region, "all");
  }
});

test("latest exposes every target on an identical schema, baseline included", () => {
  const latest = buildLatest(model, site);
  assert.ok(latest.targets.length >= 2);

  const shape = sortedKeys(latest.targets[0]);
  for (const t of latest.targets) {
    assert.deepEqual(sortedKeys(t), shape, `target ${t.slug} diverges from the shared schema`);
    assert.deepEqual(Object.keys(t.tiers).sort(), ["tier1", "tier2", "tier3"]);
    assert.equal(t.capabilities.length, CAPABILITIES.length);
    // Correctness and coverage always travel together.
    assert.ok("total" in t && "coverage" in t);
  }

  const baselines = latest.targets.filter((t) => t.baseline);
  assert.equal(baselines.length, 1, "exactly one baseline row");
  assert.equal(baselines[0].slug, "dynamodb");
});

test("runs endpoint mirrors the model's runs, newest first, shared target schema", () => {
  const runs = buildRuns(model, site);
  assert.equal(runs.runs.length, model.runs.length);
  assert.equal(runs.runs[0].id, model.latest.id);
  assert.equal(runs.latestRun, model.latest.id);

  const shape = sortedKeys(runs.runs[0].targets[0]);
  for (const run of runs.runs) {
    for (const t of run.targets) {
      assert.deepEqual(sortedKeys(t), shape, `run ${run.id} target ${t.slug} diverges`);
    }
  }
});

test("index documents the tier and capability vocabularies and the endpoints", () => {
  const index = buildIndex(model, site);
  assert.equal(index.tiers.length, 3);
  assert.deepEqual(index.tiers.map((t) => t.key), TIERS.map((t) => t.key));
  assert.equal(index.capabilities.length, CAPABILITIES.length);
  assert.equal(index.latestRun, model.latest.id);
  assert.equal(index.runCount, model.runs.length);
  assert.equal(index.documentation, site.url + "/for-agents");

  const urls = index.endpoints.map((e) => e.url);
  assert.ok(urls.includes(site.url + "/data/latest.json"));
  assert.ok(urls.includes(site.url + "/data/runs.json"));
  assert.ok(urls.includes(site.url + "/feed.xml"));
});

test("schema version 2 reflects the per-region addition", () => {
  assert.equal(DATA_SCHEMA_VERSION, 2);
});

test("every target carries a uniform region summary; baseline is 'all'", () => {
  const latest = buildLatest(model, site);
  for (const t of latest.targets) {
    assert.ok("region" in t, `${t.slug} missing region key`);
    if (t.region) {
      assert.ok(["all", "pinned-plus", "beats-pinned"].includes(t.region.kind));
      assert.ok(Array.isArray(t.region.cohort));
      assert.equal(t.region.pinned, "eu-west-2");
      assert.equal(t.region.beatsPinned, t.region.kind === "beats-pinned");
    }
  }
  const ddb = latest.targets.find((t) => t.baseline);
  assert.equal(ddb.region.kind, "all");
});

test("latest exposes the per-region breakdown and the run's region health", () => {
  const latest = buildLatest(model, site);
  assert.ok("regionHealth" in latest);
  if (latest.regionHealth) {
    for (const k of ["observed", "unresolved", "dropped"]) assert.ok(Array.isArray(latest.regionHealth[k]));
  }
  const dz = latest.targets.find((t) => t.slug === "dynoxide");
  assert.ok(Array.isArray(dz.regions) && dz.regions.length > 0, "dynoxide has a per-region breakdown");
  const r = dz.regions[0];
  for (const k of ["region", "rate", "pinned", "inCohort", "indeterminate", "total", "tiers"]) assert.ok(k in r, `region entry missing ${k}`);
  assert.deepEqual(Object.keys(r.tiers).sort(), ["tier1", "tier2", "tier3"]);
  assert.ok(dz.regions.some((x) => x.region === "eu-west-2" && x.pinned === true), "eu-west-2 flagged as the baseline region");
});

test("index documents the region model and health vocabulary", () => {
  const index = buildIndex(model, site);
  assert.equal(index.regions.pinned, "eu-west-2");
  assert.deepEqual(index.regions.health.map((h) => h.key), ["observed", "unresolved", "dropped"]);
});

test("targets carry the maintainer disclosure, derived from the slug", () => {
  const latest = buildLatest(model, site);
  assert.equal(latest.targets.find((t) => t.slug === "dynoxide").maintainedByAuthor, true);
  assert.equal(latest.targets.find((t) => t.slug === "dynalite").maintainedByAuthor, false);
});
