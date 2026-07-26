import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreEmulator } from "./scoring.mjs";
import { buildModel, assignRunIds, targetRunsOf, leanForFallback } from "./history.mjs";

test("targetRunsOf pairs each target with the runs that measured it", () => {
  const model = {
    targets: ["dynoxide", "dynalite"],
    perTarget: {
      dynoxide: { series: [{ runId: "2026-07-01", date: "2026-07-01" }, { runId: "2026-07-20", date: "2026-07-20" }] },
      dynalite: { series: [{ runId: "2026-07-20", date: "2026-07-20" }] },
    },
  };
  assert.deepEqual(targetRunsOf(model), [
    { slug: "dynoxide", runId: "2026-07-01", date: "2026-07-01" },
    { slug: "dynoxide", runId: "2026-07-20", date: "2026-07-20" },
    { slug: "dynalite", runId: "2026-07-20", date: "2026-07-20" },
  ]);
});

test("targetRunsOf degrades to an empty list rather than throwing", () => {
  // A committed fallback predating per-(target, run) pages has no targetRuns.
  // Missing pagination data fails the entire build, not just those pages, so
  // this has to be derivable from any model shape.
  assert.deepEqual(targetRunsOf(undefined), []);
  assert.deepEqual(targetRunsOf({}), []);
  assert.deepEqual(targetRunsOf({ targets: ["x"], perTarget: {} }), []);
  assert.deepEqual(targetRunsOf({ targets: ["x"], perTarget: { x: {} } }), []);
});

// Craft a Vitest-shaped raw whose tier tallies produce a known total, then
// score it the same way the real pipeline does, so test snapshots share the
// exact shape history.mjs consumes in production.
function raw(startTimeISO, { t1 = [], t2 = [], t3 = [] }) {
  return {
    startTime: Date.parse(startTimeISO),
    testResults: [
      { name: "/x/tier1/a.test.ts", assertionResults: t1.map((status) => ({ status })) },
      { name: "/x/tier2/b.test.ts", assertionResults: t2.map((status) => ({ status })) },
      { name: "/x/tier3/c.test.ts", assertionResults: t3.map((status) => ({ status })) },
    ],
  };
}

const P = (n) => Array(n).fill("passed");
const F = (n) => Array(n).fill("failed");

// A snapshot is a scored row plus its run identity (startTime epoch) and sha.
function snap(slug, startTimeISO, sha, tiers, version = "-") {
  const scored = scoreEmulator(slug, raw(startTimeISO, tiers), version);
  return { ...scored, startTime: Date.parse(startTimeISO), sha };
}

// Whole-tier-1 snapshot at a chosen pass rate (passed of 100), keeps totals tidy.
const at = (slug, iso, sha, passed, version = "-") =>
  snap(slug, iso, sha, { t1: [...P(passed), ...F(100 - passed)] }, version);

const rowFor = (run, slug) => run.standings.find((r) => r.slug === slug);

test("groups snapshots into runs by startTime date, newest first", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a1", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b2", 100),
    at("dynoxide", "2026-01-03T10:00:00Z", "c3", 90),
  ]);
  assert.deepEqual(
    model.runs.map((r) => r.date),
    ["2026-01-03", "2026-01-02", "2026-01-01"],
  );
  assert.equal(model.latest.date, "2026-01-03");
});

test("a single commit touching a subset, and one date carrying different startTimes, group by date not commit", () => {
  // Same date, 12h apart, different shas (the 90-min intra-run spread case).
  const model = buildModel([
    at("dynoxide", "2026-02-01T08:00:00Z", "aaa", 100),
    at("localstack", "2026-02-01T20:00:00Z", "bbb", 88),
    at("floci", "2026-02-01T09:30:00Z", "aaa", 60),
  ]);
  assert.equal(model.runs.length, 1);
  assert.equal(model.runs[0].date, "2026-02-01");
  assert.equal(model.runs[0].emulatorCount, 3);
});

test("the latest snapshot of a target on a date wins; counts are not duplicated", () => {
  // The 2026-04-27 case: floci added at 13:30, re-run at 21:30 the same day.
  const model = buildModel([
    at("floci", "2026-04-27T13:30:00Z", "early", 60),
    at("floci", "2026-04-27T21:30:00Z", "late", 75),
  ]);
  assert.equal(model.runs.length, 1);
  const floci = rowFor(model.runs[0], "floci");
  assert.equal(floci.totalValue, 75); // the later run won
  assert.equal(model.runs[0].emulatorCount, 1); // not duplicated
});

test("movement: rise is up with positive delta, fall is down, equal is flat", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 92), // +12.0pp
    at("dynoxide", "2026-01-03T10:00:00Z", "c", 92), // unchanged
    at("dynoxide", "2026-01-04T10:00:00Z", "d", 70), // -22.0pp
  ]);
  const move = (date) => rowFor(model.runs.find((r) => r.date === date), "dynoxide").movement;
  assert.equal(move("2026-01-02").state, "up");
  assert.equal(move("2026-01-02").delta, 12);
  assert.equal(move("2026-01-02").deltaLabel, "+12.0pp");
  assert.equal(move("2026-01-03").state, "flat");
  assert.equal(move("2026-01-04").state, "down");
  assert.equal(move("2026-01-04").deltaLabel, "-22.0pp");
});

test("movement: a target absent from earlier runs is flagged new", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 90),
    at("floci", "2026-01-02T10:00:00Z", "b", 55), // first appears in run 2
  ]);
  assert.equal(rowFor(model.runs.find((r) => r.date === "2026-01-02"), "floci").movement.state, "new");
  assert.equal(model.movement.floci.state, "new");
});

test("carry-forward: a target not re-tested in a later run is carried, not dropped or moved", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynalite", "2026-01-01T10:00:00Z", "a", 50),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 95), // only dynoxide re-tested in run 2
  ]);
  const run2 = model.runs.find((r) => r.date === "2026-01-02");
  const dynalite = rowFor(run2, "dynalite");
  assert.ok(dynalite, "carried-forward target still present in the later run");
  assert.equal(dynalite.carried, true);
  assert.equal(dynalite.totalValue, 50); // its last measured value
  assert.equal(dynalite.movement.state, "carried");
  assert.equal(dynalite.movement.arrow, "–");
});

test("every run carries a synthesised DynamoDB baseline at 100% across that run's suite size", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80), // 100 tests
  ]);
  const dynamodb = rowFor(model.runs[0], "dynamodb");
  assert.ok(dynamodb);
  assert.equal(dynamodb.total, "100%");
  assert.equal(dynamodb.passed, 100); // suite size of the run
  assert.equal(dynamodb.version, "live (AWS)");
  assert.equal(model.runs[0].standings[0].slug, "dynamodb"); // sorted first
});

test("standings sort by total descending with DynamoDB first", () => {
  const model = buildModel([
    at("dynalite", "2026-01-01T10:00:00Z", "a", 50),
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 95),
    at("floci", "2026-01-01T10:00:00Z", "a", 70),
  ]);
  assert.deepEqual(
    model.runs[0].standings.map((r) => r.slug),
    ["dynamodb", "dynoxide", "floci", "dynalite"],
  );
});

test("single run: every target is new and the build still succeeds", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("floci", "2026-01-01T10:00:00Z", "a", 55),
  ]);
  assert.equal(model.runs.length, 1);
  assert.equal(model.movement.dynoxide.state, "new");
  assert.equal(model.perTarget.dynoxide.series.length, 1);
});

test("per-target series holds distinct re-tests oldest-first; gaps don't crash", () => {
  const model = buildModel([
    at("floci", "2026-01-01T10:00:00Z", "a", 60),
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 90), // floci absent this run
    at("floci", "2026-01-03T10:00:00Z", "c", 70), // floci reappears, no crash
  ]);
  const floci = model.perTarget.floci;
  assert.deepEqual(floci.series.map((p) => p.date), ["2026-01-01", "2026-01-03"]);
  assert.equal(floci.series[1].movement.state, "up"); // 60 -> 70
  assert.equal(floci.series[0].movement.state, "new");
});

test("DynamoDB per-target series is a flat 100% baseline, not a trend", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 90),
  ]);
  const dynamodb = model.perTarget.dynamodb;
  assert.equal(dynamodb.baseline, true);
  assert.ok(dynamodb.series.every((p) => p.totalValue === 100));
});

test("an all-skipped target has a null total, sorts last, and doesn't break movement or movers", () => {
  const model = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 90),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 80), // a real mover
    snap("ghost", "2026-01-02T10:00:00Z", "b", { t1: Array(10).fill("skipped") }), // implements nothing
  ]);
  const run2 = model.runs.find((r) => r.date === "2026-01-02");
  const ghost = rowFor(run2, "ghost");
  assert.equal(ghost.totalValue, null);
  assert.equal(ghost.total, "-");
  // sorts last (a no-score target trails the scored ones)
  assert.equal(run2.standings[run2.standings.length - 1].slug, "ghost");
  // movers is computed without NaN and never includes the null-total target
  assert.ok(model.movers.every((m) => m.slug !== "ghost"));
});

test("movers lists the latest run's biggest changes, ordered by size", () => {
  const m = buildModel([
    at("dynoxide", "2026-01-01T10:00:00Z", "a", 90),
    at("floci", "2026-01-01T10:00:00Z", "a", 50),
    at("dynalite", "2026-01-01T10:00:00Z", "a", 90),
    at("dynoxide", "2026-01-02T10:00:00Z", "b", 85), // -5
    at("floci", "2026-01-02T10:00:00Z", "b", 62), // +12
    at("dynalite", "2026-01-02T10:00:00Z", "b", 89), // -1
  ]);
  assert.deepEqual(m.movers.map((x) => x.slug), ["floci", "dynoxide", "dynalite"]);
  assert.equal(m.movers[0].state, "up");
  assert.equal(m.movers[0].delta, 12);
});

test("each run records its suite growth vs the previous run", () => {
  const model = buildModel([
    snap("dynoxide", "2026-01-01T10:00:00Z", "a", { t1: P(100) }), // 100 tests
    snap("dynoxide", "2026-01-02T10:00:00Z", "b", { t1: P(120) }), // grew to 120
    snap("dynoxide", "2026-01-03T10:00:00Z", "c", { t1: P(120) }), // unchanged
  ]);
  const r = (date) => model.runs.find((x) => x.date === date);
  // First run: no previous run to compare against.
  assert.equal(r("2026-01-01").prevSuiteSize, null);
  assert.equal(r("2026-01-01").suiteGrowth, 0);
  assert.equal(r("2026-01-01").suiteGrew, false);
  // Grew 100 -> 120.
  assert.equal(r("2026-01-02").prevSuiteSize, 100);
  assert.equal(r("2026-01-02").suiteGrowth, 20);
  assert.equal(r("2026-01-02").suiteGrew, true);
  // Flat run: no growth.
  assert.equal(r("2026-01-03").suiteGrowth, 0);
  assert.equal(r("2026-01-03").suiteGrew, false);
});

test("assignRunIds: distinct runs sharing a date get sha-disambiguated ids", () => {
  const ids = assignRunIds([
    { date: "2026-05-23", sha: "abcdef1234" },
    { date: "2026-05-23", sha: "999fff8888" },
    { date: "2026-05-24", sha: "1234567890" },
  ]);
  assert.deepEqual(ids, ["2026-05-23-abcdef1", "2026-05-23-999fff8", "2026-05-24"]);
});

// The per-region overlay. Without a summary the model is the eu-west-2-only
// result, byte-for-byte; with one, the best-match rate drives the headline.
test("without a summary overlay the model is unchanged (characterisation)", () => {
  const snaps = [
    at("dynoxide", "2026-01-01T10:00:00Z", "a1", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b2", 90),
    at("localstack", "2026-01-02T11:00:00Z", "b2", 70),
  ];
  const base = buildModel(snaps);
  assert.deepEqual(buildModel(snaps, null), base);
  assert.deepEqual(buildModel(snaps, { available: false }), base);
});

test("with a summary overlay, best-match drives total, sort and movement", () => {
  const snaps = [
    at("dynoxide", "2026-01-01T10:00:00Z", "a1", 80),
    at("dynoxide", "2026-01-02T10:00:00Z", "b2", 80),
  ];
  const label = { kind: "beats-pinned", regions: ["us-east-1"], rate: 92, others: 0, pinned: "eu-west-2", pinnedRate: 80 };
  const target = { rate: 92, label, regions: [{ region: "us-east-1", rate: 92 }] };
  const summary = {
    available: true,
    latest: { targets: { dynoxide: target } },
    byRunDate: { "2026-01-02": { targets: { dynoxide: target } } },
  };
  const model = buildModel(snaps, summary);
  const row = rowFor(model.latest, "dynoxide");
  assert.equal(row.total, "92.0%");
  assert.equal(row.totalValue, 92);
  assert.equal(row.portTotalValue, 80, "keeps the eu-west-2 score");
  assert.equal(row.regionLabel.kind, "beats-pinned");
  assert.equal(row.movement.state, "up", "movement follows the best-match number");
  assert.equal(model.perTarget.dynoxide.hasRegions, true);
  assert.equal(model.perTarget.dynoxide.regionLabel.kind, "beats-pinned");
  // The earlier run has no summary, so it stays on its eu-west-2 score.
  const earlier = model.runs.find((r) => r.date === "2026-01-01");
  assert.equal(rowFor(earlier, "dynoxide").total, "80.0%");
});

test("targetRunsOf excludes the synthesised baseline", () => {
  // DynamoDB's series is one synthetic point per run, never a measurement, so a
  // page per date would claim real DynamoDB had been tested and scored.
  const model = {
    targets: ["dynamodb", "dynoxide"],
    perTarget: {
      dynamodb: { baseline: true, series: [{ runId: "2026-07-20", date: "2026-07-20" }] },
      dynoxide: { baseline: false, series: [{ runId: "2026-07-20", date: "2026-07-20" }] },
    },
  };
  assert.deepEqual(targetRunsOf(model), [{ slug: "dynoxide", runId: "2026-07-20", date: "2026-07-20" }]);
});

// A model shaped like buildModel's output, with findings on all four references
// that carry them, so the strip can be checked reference by reference.
function modelWithFindings() {
  const F = (id) => ({ id, fullName: id, file: `tests/tier1/x.test.ts`, line: 1 });
  const row = (slug, findings) => ({ slug, total: "90%", findings });
  return {
    runs: [
      { id: "2026-07-20", standings: [row("dynoxide", [F("newA"), F("newB")])] },
      { id: "2026-07-06", standings: [row("dynoxide", [F("oldA")])] },
    ],
    latest: { id: "2026-07-20", standings: [row("dynoxide", [F("newA"), F("newB")])] },
    perTarget: {
      dynoxide: {
        findings: [F("newA"), F("newB")],
        current: { slug: "dynoxide", findings: [F("newA"), F("newB")] },
        series: [
          { runId: "2026-07-06", findings: [F("oldA")] },
          { runId: "2026-07-20", findings: [F("newA"), F("newB")] },
        ],
      },
    },
  };
}

const findingCount = (arr) => (arr ?? []).length;

test("leanForFallback keeps findings only where the site renders them", () => {
  const lean = leanForFallback(modelWithFindings());
  // Kept: the target page's own findings, and the newest series point.
  assert.equal(findingCount(lean.perTarget.dynoxide.findings), 2);
  const series = lean.perTarget.dynoxide.series;
  assert.equal(findingCount(series[series.length - 1].findings), 2, "newest series point keeps findings");
  // Dropped everywhere else: the copies nothing renders from.
  assert.equal(findingCount(series[0].findings), 0, "older series points are thinned");
  assert.equal(findingCount(lean.perTarget.dynoxide.current.findings), 0, "current is a copy nothing reads");
  assert.equal(findingCount(lean.runs[0].standings[0].findings), 0, "run standings only feed the digest");
  assert.equal(findingCount(lean.latest.standings[0].findings), 0, "latest standings likewise");
});

test("leanForFallback leaves everything but findings intact", () => {
  const lean = leanForFallback(modelWithFindings());
  assert.equal(lean.runs[0].standings[0].total, "90%");
  assert.equal(lean.runs[0].standings[0].slug, "dynoxide");
  assert.equal(lean.latest.id, "2026-07-20");
  assert.equal(lean.perTarget.dynoxide.series.length, 2);
});

test("leanForFallback degrades on absent sections rather than throwing", () => {
  assert.doesNotThrow(() => leanForFallback({}));
  assert.doesNotThrow(() => leanForFallback({ runs: [], perTarget: {}, latest: null }));
});
