import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildSplitsModel, shapeSplit, renderSplitEvidence } from "./splits.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "..", "data", "splits-fallback.json"), "utf8"));

test("buildSplitsModel shapes the registry and features the most divergent split", () => {
  const model = buildSplitsModel(raw);
  assert.equal(model.available, true);
  assert.ok(model.count >= 1);
  assert.ok(model.featured.groups.length >= 2, "a split has at least two answer cohorts");
  // The featured split has at least as many distinct error kinds as any other.
  const kinds = (s) => new Set(s.groups.map((g) => g.error?.name ?? g.outcome)).size;
  for (const s of model.splits) assert.ok(kinds(model.featured) >= kinds(s));
});

test("shapeSplit groups regions by their distinct answer, largest cohort first", () => {
  const split = shapeSplit({
    id: "x",
    behaviour: "b",
    pinned: "eu-west-2",
    regions: {
      "eu-west-2": { outcome: "rejected", error: { name: "ValidationException", message: "one error" } },
      "us-east-1": { outcome: "rejected", error: { name: "ValidationException", message: "two errors" } },
      "us-east-2": { outcome: "rejected", error: { name: "ValidationException", message: "two errors" } },
    },
  });
  assert.equal(split.groups.length, 2);
  assert.equal(split.groups[0].count, 2, "largest cohort first");
  assert.equal(split.groups[1].hasPinned, true, "eu-west-2 cohort is flagged");
});

test("renderSplitEvidence marks the baseline region and shows cohort counts", () => {
  const model = buildSplitsModel(raw);
  const html = renderSplitEvidence(model.featured);
  assert.match(html, /baseline/);
  assert.match(html, /regions?</);
});

test("an empty registry degrades to unavailable", () => {
  assert.equal(buildSplitsModel({ splits: [] }).available, false);
  assert.equal(buildSplitsModel(null).available, false);
  assert.equal(renderSplitEvidence(null), "");
});
