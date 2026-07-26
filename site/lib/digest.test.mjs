import { test } from "node:test";
import assert from "node:assert/strict";

import { historyDigest } from "./digest.mjs";

// A minimal model shaped like buildModel's output, enough to exercise the digest
// projection. Deep-cloned per test so a mutation only changes the intended field.
function model() {
  return {
    runs: [
      {
        id: "2026-07-16",
        standings: [
          { slug: "dynamodb", total: "100%", version: "live (AWS)", runDate: "2026-07-16" },
          { slug: "dynoxide", total: "99.4%", version: "0.11.3", runDate: "2026-07-16" },
        ],
      },
    ],
    regionHealth: { observed: ["eu-west-2", "us-east-1"], unresolved: [], dropped: ["me-south-1"] },
    perTarget: {
      dynoxide: {
        hasRegions: true,
        regionLabel: { kind: "pinned-plus" },
        regions: [
          { region: "eu-west-2", rate: 99.4 },
          { region: "us-east-1", rate: 99.0 },
        ],
      },
    },
  };
}

const clone = (m) => JSON.parse(JSON.stringify(m));

test("identical models produce identical digests", () => {
  assert.equal(historyDigest(model()), historyDigest(clone(model())));
});

test("a headline total change moves the digest (unchanged behaviour)", () => {
  const m = clone(model());
  m.runs[0].standings[1].total = "99.5%";
  assert.notEqual(historyDigest(m), historyDigest(model()));
});

test("a non-headline per-region rate change moves the digest", () => {
  const m = clone(model());
  m.perTarget.dynoxide.regions[1].rate = 98.5; // us-east-1, not the headline
  assert.notEqual(historyDigest(m), historyDigest(model()));
});

test("a region health change moves the digest", () => {
  const m = clone(model());
  m.regionHealth.dropped = []; // me-south-1 returns to scoring
  assert.notEqual(historyDigest(m), historyDigest(model()));
});

test("digest still works on a model without any region overlay", () => {
  const m = clone(model());
  delete m.regionHealth;
  delete m.perTarget;
  assert.match(historyDigest(m), /^[0-9a-f]{16}$/);
});

test("a target swapping one failing test for another moves the digest", () => {
  // The deploy skips a scheduled rebuild when the digest is unchanged. A target
  // that fixes one test and breaks another in the same run keeps its total, its
  // version and its region rates, so a totals-only projection would report no
  // change and leave the per-run pages showing failures that had moved on.
  const before = model();
  before.runs[0].standings[1].findings = [{ id: "aaaaaaaaaa" }, { id: "bbbbbbbbbb" }];
  const after = model();
  after.runs[0].standings[1].findings = [{ id: "aaaaaaaaaa" }, { id: "cccccccccc" }];
  assert.equal(before.runs[0].standings[1].total, after.runs[0].standings[1].total, "totals must be identical for this to be the case worth testing");
  assert.notEqual(historyDigest(before), historyDigest(after));
});

test("the same failing set in a different order does not move the digest", () => {
  const a = model();
  a.runs[0].standings[1].findings = [{ id: "aaaaaaaaaa" }, { id: "bbbbbbbbbb" }];
  const b = model();
  b.runs[0].standings[1].findings = [{ id: "bbbbbbbbbb" }, { id: "aaaaaaaaaa" }];
  assert.equal(historyDigest(a), historyDigest(b));
});

test("a model with no findings still digests", () => {
  // Snapshots predating per-test detail, and the committed fallback, carry none.
  assert.match(historyDigest(model()), /^[0-9a-f]{16}$/);
});
