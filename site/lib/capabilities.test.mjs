import { test } from "node:test";
import assert from "node:assert/strict";

import { capabilityTallies, CAPABILITIES, CAPABILITY_GROUPS } from "./scoring.mjs";
import { renderCapabilities, renderCapabilityCards } from "./capabilities.mjs";

// A tag manifest like the suite publishes: (file, top-level describe title) -> tags.
const manifest = {
  describes: {
    "tests/tier2/partiql/executeStatement.test.ts": { "ExecuteStatement — PartiQL": ["partiql", "data-plane"] },
    "tests/tier1/query/gsi.test.ts": { "Query — GSI": ["query", "data-plane", "gsi"] },
  },
};

// Raw Vitest output: one file with an absolute (CI) path, one with a repo-relative
// path, to prove the join normalises both to the "tests/..." tail.
const raw = {
  testResults: [
    {
      name: "/home/runner/work/dynamodb-conformance/dynamodb-conformance/tests/tier2/partiql/executeStatement.test.ts",
      assertionResults: [
        { ancestorTitles: ["ExecuteStatement — PartiQL"], status: "passed" },
        { ancestorTitles: ["ExecuteStatement — PartiQL"], status: "failed" },
      ],
    },
    {
      name: "tests/tier1/query/gsi.test.ts",
      assertionResults: [
        { ancestorTitles: ["Query — GSI"], status: "passed" },
        { ancestorTitles: ["Query — GSI"], status: "skipped" },
      ],
    },
  ],
};

const byKey = (caps) => Object.fromEntries(caps.map((c) => [c.key, c]));

test("capabilityTallies joins results to the manifest by (file, describe title)", () => {
  const caps = byKey(capabilityTallies(raw, manifest));
  // partiql: one pass + one fail across the partiql file -> partial
  assert.deepEqual(
    [caps.partiql.passed, caps.partiql.failed, caps.partiql.skipped, caps.partiql.state],
    [1, 1, 0, "partial"],
  );
  // gsi: one pass + one skip from the gsi file -> partial (works, with a gap)
  assert.deepEqual(
    [caps.gsi.passed, caps.gsi.skipped, caps.gsi.state],
    [1, 1, "partial"],
  );
});

test("capabilityTallies counts only declared capability columns, ignoring other tags", () => {
  const caps = byKey(capabilityTallies(raw, manifest));
  // 'query' and 'data-plane' are real tags but not capability columns, so they
  // contribute to no column. Capabilities never seen stay at zero -> unsupported.
  assert.equal(caps.query, undefined);
  assert.equal(caps.transactions.total, 0);
  assert.equal(caps.transactions.state, "unsupported");
});

test("capabilityTallies returns one entry per capability column, in order", () => {
  const caps = capabilityTallies(raw, manifest);
  assert.deepEqual(caps.map((c) => c.key), CAPABILITIES.map((c) => c.key));
});

test("capabilityTallies degrades to unsupported with no manifest, rather than crashing", () => {
  const caps = byKey(capabilityTallies(raw, undefined));
  assert.ok(caps.partiql);
  assert.equal(caps.partiql.total, 0);
  assert.equal(caps.partiql.state, "unsupported");
});

// A model shaped like buildModel's output, enough to render the grid.
const model = {
  targets: ["dynamodb", "dynoxide", "extenddb"],
  perTarget: {
    dynamodb: { display: "DynamoDB", currentVersion: "live (AWS)", baseline: true },
    dynoxide: {
      display: "Dynoxide",
      currentVersion: "0.10.0",
      capabilities: [
        { key: "gsi", label: "GSI", state: "supported", passed: 26, failed: 0, skipped: 0 },
        { key: "partiql", label: "PartiQL", state: "supported", passed: 35, failed: 0, skipped: 0 },
      ],
    },
    extenddb: {
      display: "ExtendDB",
      currentVersion: "v0.1.1",
      capabilities: [
        { key: "partiql", label: "PartiQL", state: "unsupported", passed: 0, failed: 0, skipped: 42 },
      ],
    },
  },
};

test("renderCapabilities renders a row per target with glyphs, versions and counts", () => {
  const html = renderCapabilities(model);
  // every capability column header is present
  for (const c of CAPABILITIES) assert.ok(html.includes(c.label), `missing column ${c.label}`);
  // glyphs map to states (colour never alone: a spoken describe accompanies each)
  assert.match(html, /✓/); // supported (dynoxide gsi)
  assert.match(html, /–/); // unsupported (extenddb partiql)
  assert.match(html, /Dynoxide GSI: supported \(26 pass\)/);
  assert.match(html, /ExtendDB PartiQL: not supported \(42 skip\)/);
  // version travels with the target
  assert.match(html, /0\.10\.0/);
});

test("renderCapabilities leaves the baseline out", () => {
  // Every cell in its row was supported by definition, so the row was a line of
  // ticks a reader could do nothing with. The prose above the grid carries the
  // point instead.
  const html = renderCapabilities(model);
  assert.doesNotMatch(html, /DynamoDB GSI: supported/);
  assert.doesNotMatch(html, /href="\/targets\/dynamodb"/);
  // The emulators are all still there.
  assert.match(html, /Dynoxide GSI/);
  assert.match(html, /href="\/targets\/extenddb"/);
});

test("renderCapabilityCards folds to one card per target, with both group headings and every capability", () => {
  const html = renderCapabilityCards(model);
  // a card per target
  for (const t of ["DynamoDB", "Dynoxide", "ExtendDB"]) assert.ok(html.includes(t), `missing target ${t}`);
  // both group headings, and every capability label, appear in each fold
  for (const g of CAPABILITY_GROUPS) assert.ok(html.includes(g.label), `missing group ${g.label}`);
  for (const c of CAPABILITIES) assert.ok(html.includes(c.label), `missing capability ${c.label}`);
  // glyph + spoken label travel together (colour never alone)
  assert.match(html, /Dynoxide GSI: supported \(26 pass\)/);
});

test("renderCapabilityCards escapes target names rather than injecting markup", () => {
  const evil = {
    targets: ["x"],
    perTarget: { x: { display: "<script>alert(1)</script>", currentVersion: "1", capabilities: [] } },
  };
  const html = renderCapabilityCards(evil);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderCapabilities escapes target names rather than injecting markup", () => {
  const evil = {
    targets: ["x"],
    perTarget: { x: { display: "<script>alert(1)</script>", currentVersion: "1", capabilities: [] } },
  };
  const html = renderCapabilities(evil);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});
