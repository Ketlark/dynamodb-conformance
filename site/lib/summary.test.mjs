import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildSummaryModel, cohortOf, regionLabel, groupRegionsByRate, renderRegionGroups } from "./summary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "..", "test", "fixtures", "regions", "summary.json"), "utf8"));
const model = buildSummaryModel(raw);

test("a real summary builds an available model with the observed region set", () => {
  assert.equal(model.available, true);
  assert.equal(model.schemaVersion, 1);
  assert.ok(model.regions.observed.length > 3, "reads the full observed set, not a hardcoded few");
  assert.ok(model.groundTruth.rate === 100, "ground truth is 100 (earned self-agreement)");
});

test("region health separates observed, unresolved and dropped", () => {
  assert.ok(Array.isArray(model.regions.dropped));
  assert.ok(model.regions.dropped.includes("me-south-1"), "the dropped region is surfaced, not hidden");
  assert.ok(!model.regions.observed.includes("me-south-1"), "a dropped region is not also observed");
});

test("a target tied across every region reads as 'all regions', not a tie-break winner", () => {
  // Dynalite scores identically in all observed regions in the fixture.
  const dynalite = model.targets.dynalite;
  assert.equal(dynalite.label.kind, "all");
  assert.equal(regionLabel(dynalite.label), "all regions");
});

test("a target whose best cohort includes eu-west-2 anchors on eu-west-2", () => {
  // Dynoxide scores highest in a six-region cohort that includes eu-west-2.
  const dynoxide = model.targets.dynoxide;
  assert.equal(dynoxide.label.kind, "pinned-plus");
  assert.equal(dynoxide.label.regions.includes("eu-west-2"), true);
  assert.equal(regionLabel(dynoxide.label), `eu-west-2 + ${dynoxide.label.others} regions`);
  // The headline rate is the suite's, and equals the top of the per-region rates.
  const top = Math.max(...dynoxide.regions.map((r) => r.rate));
  assert.equal(dynoxide.rate, top);
});

test("regions are ordered by rate then name, and the cohort is flagged", () => {
  const dynoxide = model.targets.dynoxide;
  for (let i = 1; i < dynoxide.regions.length; i++) {
    assert.ok(dynoxide.regions[i - 1].rate >= dynoxide.regions[i].rate, "sorted by rate desc");
  }
  const euw2 = dynoxide.regions.find((r) => r.region === "eu-west-2");
  assert.equal(euw2.pinned, true);
  assert.equal(euw2.inCohort, true);
});

test("cohortOf names a non-pinned region only when it beats eu-west-2", () => {
  // No live instance today, so exercise the branch directly: an engine that
  // matches us-east-1 (which eu-west-2 disagrees with) scores higher there.
  const entries = [
    { region: "eu-west-2", rate: 90 },
    { region: "eu-central-1", rate: 90 },
    { region: "us-east-1", rate: 92 },
  ];
  const label = cohortOf(entries);
  assert.equal(label.kind, "beats-pinned");
  assert.equal(label.regions[0], "us-east-1");
  assert.equal(label.pinnedRate, 90);
  assert.equal(regionLabel(label), "us-east-1");
});

test("beats-pinned uses a count when several regions beat eu-west-2 (no arbitrary representative)", () => {
  const entries = [
    { region: "eu-west-2", rate: 90 },
    { region: "us-east-1", rate: 92 },
    { region: "us-east-2", rate: 92 },
  ];
  const label = cohortOf(entries);
  assert.equal(label.kind, "beats-pinned");
  assert.equal(regionLabel(label), "2 regions");
});

test("a single-region pinned cohort drops the '+ N' suffix", () => {
  const entries = [
    { region: "eu-west-2", rate: 95 },
    { region: "us-east-1", rate: 90 },
  ];
  const label = cohortOf(entries);
  assert.equal(label.kind, "pinned-plus");
  assert.equal(regionLabel(label), "eu-west-2");
});

test("indeterminate results are surfaced per region, not read as a disagreement", () => {
  const raw2 = {
    schemaVersion: 1,
    groundTruth: { slug: "dynamodb", rate: 100, runDate: "2026-07-16" },
    regions: { observed: ["eu-west-2", "ap-east-1"], unresolved: [], dropped: [], detail: {} },
    targets: {
      foo: {
        headline: { region: "eu-west-2", rate: 90 },
        regions: {
          "eu-west-2": { rate: 90, passed: 9, failed: 1, skipped: 0, indeterminate: 0, count: 10, tiers: { tier1: { p: 9, f: 1, s: 0, i: 0 }, tier2: { p: 0, f: 0, s: 0, i: 0 }, tier3: { p: 0, f: 0, s: 0, i: 0 } } },
          "ap-east-1": { rate: 90, passed: 9, failed: 1, skipped: 0, indeterminate: 2, count: 10, tiers: { tier1: { p: 9, f: 1, s: 0, i: 2 }, tier2: { p: 0, f: 0, s: 0, i: 0 }, tier3: { p: 0, f: 0, s: 0, i: 0 } } },
        },
      },
    },
  };
  const m = buildSummaryModel(raw2);
  const ap = m.targets.foo.regions.find((r) => r.region === "ap-east-1");
  assert.equal(ap.indeterminate, 2);
  assert.equal(ap.indeterminatePresent, true);
});

test("a missing or wrong-schema payload degrades to unavailable rather than throwing", () => {
  assert.equal(buildSummaryModel(null).available, false);
  assert.equal(buildSummaryModel({ schemaVersion: 2, targets: {} }).available, false);
  assert.equal(buildSummaryModel(undefined).targets && Object.keys(buildSummaryModel(undefined).targets).length, 0);
});

test("groupRegionsByRate clusters regions into rate bands, highest first", () => {
  const regions = [
    { region: "eu-west-2", rate: 99.4, pinned: true, inCohort: true },
    { region: "eu-central-1", rate: 99.4, inCohort: true },
    { region: "af-south-1", rate: 99.0 },
    { region: "ap-east-1", rate: 99.0 },
  ];
  const groups = groupRegionsByRate(regions);
  assert.equal(groups.length, 2);
  assert.deepEqual([groups[0].rate, groups[1].rate], [99.4, 99.0]);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[1].count, 2);
});

test("renderRegionGroups marks the baseline and indeterminate regions", () => {
  const html = renderRegionGroups([
    { region: "eu-west-2", rate: 90, pinned: true, inCohort: true, indeterminate: 0, indeterminatePresent: false },
    { region: "ap-east-1", rate: 88, pinned: false, inCohort: false, indeterminate: 3, indeterminatePresent: true },
  ]);
  assert.match(html, /eu-west-2/);
  assert.match(html, /baseline/);
  assert.match(html, /3 indeterminate/);
  assert.match(html, /90%/);
  assert.match(html, /88%/);
});

test("renderRegionGroups is empty for a target with no regions", () => {
  assert.equal(renderRegionGroups([]), "");
});
