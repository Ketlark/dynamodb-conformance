import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  tierOf,
  areaOf,
  breakdownOf,
  areaTallies,
  areaState,
  pct,
  display,
  label,
  DISPLAY,
  REPO,
  scoreEmulator,
  summariseToMarkdown,
  isSelfMaintained,
} from "./scoring.mjs";
import * as suite from "dynamodb-conformance/scripts/summarise.mjs";
import * as suiteScore from "dynamodb-conformance/scripts/lib/score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "test", "fixtures");

// Read a fixture run directory into the {slug, raw, version} entries that both
// summarise.mjs and our renderer consume.
function readRun(name) {
  const dir = join(fixtures, name);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const slug = f.replace(/\.json$/, "");
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const versionFile = join(dir, `${slug}.version`);
      const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "-";
      return { slug, raw, version };
    });
}

test("tierOf classifies by /tierN/ regardless of path prefix", () => {
  assert.equal(tierOf("/home/runner/work/x/tests/tier1/foo.test.ts"), "tier1");
  assert.equal(tierOf("/Users/martin/Projects/x/tests/tier2/foo.test.ts"), "tier2");
  assert.equal(tierOf("/anything/tier3/foo.test.ts"), "tier3");
  assert.equal(tierOf("/no/tier/here.test.ts"), "other");
});

test("pct is correctness over implemented (passed, failed) - skips excluded", () => {
  assert.equal(pct(1, 1), "50.0%"); // 1 passed, 1 failed
  assert.equal(pct(625, 0), "100.0%"); // all implemented passed
  assert.equal(pct(0, 0), "-"); // nothing implemented
  assert.equal(pct(2, 1), "66.7%"); // 2 of 3 implemented pass
});

test("display proper-cases known slugs and humanises unknown ones", () => {
  assert.equal(display("dynamodb-local"), "DynamoDB Local");
  assert.equal(display("dynoxide"), "Dynoxide");
  assert.equal(display("some-new-thing"), "some new thing");
});

test("label links known targets and leaves unknown ones bare", () => {
  assert.equal(label("dynoxide"), "[Dynoxide](https://github.com/nubo-db/dynoxide)");
  assert.equal(label("some-new-thing"), "some new thing");
});

test("scoreEmulator buckets tiers, counts statuses, derives date + version", () => {
  const raw = {
    startTime: Date.parse("2026-05-24T07:18:15.825Z"),
    testResults: [
      { name: "/x/tier1/a.test.ts", assertionResults: [{ status: "passed" }, { status: "failed" }] },
      { name: "/x/tier2/b.test.ts", assertionResults: [{ status: "passed" }, { status: "skipped" }] },
      { name: "/x/tier3/c.test.ts", assertionResults: [{ status: "passed" }] },
    ],
  };
  const r = scoreEmulator("dynoxide", raw, "0.9.13");
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.count, 5); // count still includes the skip
  assert.equal(r.tiers.tier1.pct, "50.0%"); // 1 passed, 1 failed
  assert.equal(r.tiers.tier2.pct, "100.0%"); // 1 passed, 0 failed, 1 skip excluded
  assert.equal(r.tiers.tier3.pct, "100.0%");
  assert.equal(r.total, "75.0%"); // 3 passed / (3 + 1 failed); skip excluded
  assert.equal(r.totalValue, 75);
  assert.equal(r.version, "0.9.13");
  assert.equal(r.runDate, "2026-05-24");
});

test("scoreEmulator treats any non-passed/failed status as a skip", () => {
  const raw = {
    startTime: Date.parse("2026-01-01T00:00:00Z"),
    testResults: [
      { name: "/x/tier1/a.test.ts", assertionResults: [{ status: "todo" }, { status: "pending" }] },
    ],
  };
  const r = scoreEmulator("x", raw, "-");
  assert.equal(r.skipped, 2);
  assert.equal(r.failed, 0);
});

test("scoreEmulator surfaces a missing version as '-' and missing startTime as '-'", () => {
  const raw = { testResults: [] };
  const r = scoreEmulator("x", raw, "-");
  assert.equal(r.version, "-");
  assert.equal(r.runDate, "-");
  assert.equal(r.total, "-");
  assert.equal(r.totalValue, null);
});

test("skips are excluded from the score, raising it above the skip-inclusive figure", () => {
  // 8 passed, 2 failed, 90 skipped: correctness is 8/10 = 80%, not 8/100.
  const raw = {
    startTime: Date.parse("2026-05-24T00:00:00Z"),
    testResults: [
      {
        name: "/x/tier1/a.test.ts",
        assertionResults: [
          ...Array(8).fill({ status: "passed" }),
          ...Array(2).fill({ status: "failed" }),
          ...Array(90).fill({ status: "skipped" }),
        ],
      },
    ],
  };
  const r = scoreEmulator("x", raw, "-");
  assert.equal(r.total, "80.0%"); // 8 / (8 + 2)
  assert.equal(r.totalValue, 80);
  assert.equal(r.skipped, 90); // still reported
  assert.equal(r.count, 100); // count still includes skips
  // Scope axis: 10 of 100 operations implemented, 90 unsupported.
  assert.equal(r.implemented, 10);
  assert.equal(r.unsupported, 90);
  assert.equal(r.coverage, "10.0%");
  assert.equal(r.coverageValue, 10);
});

test("a target with everything skipped has no score (passed + failed === 0)", () => {
  const raw = {
    startTime: Date.parse("2026-05-24T00:00:00Z"),
    testResults: [{ name: "/x/tier2/partiql/a.test.ts", assertionResults: [{ status: "skipped" }, { status: "skipped" }] }],
  };
  const r = scoreEmulator("x", raw, "-");
  assert.equal(r.total, "-");
  assert.equal(r.totalValue, null);
  assert.equal(r.skipped, 2);
});

test("areaOf extracts the tier/group from a test path", () => {
  assert.deepEqual(areaOf("/x/tests/tier2/transactions/basic.test.ts"), {
    tier: "tier2",
    group: "transactions",
    key: "tier2/transactions",
  });
  assert.equal(areaOf("/no/tier/here.test.ts"), null);
});

test("breakdownOf lists only areas with gaps, with titles, sorted by gap size", () => {
  const raw = {
    testResults: [
      {
        name: "/x/tier2/transactions/a.test.ts",
        assertionResults: [
          { status: "failed", fullName: "Transactions writes atomically" },
          { status: "failed", fullName: "Transactions roll back" },
          { status: "skipped", fullName: "Transactions support idempotency" },
        ],
      },
      {
        name: "/x/tier1/putItem/b.test.ts",
        assertionResults: [
          { status: "passed", fullName: "PutItem stores an item" },
          { status: "failed", fullName: "PutItem rejects oversized items" },
        ],
      },
      {
        name: "/x/tier1/getItem/c.test.ts",
        assertionResults: [{ status: "passed", fullName: "GetItem returns an item" }],
      },
    ],
  };
  const b = breakdownOf(raw);
  // getItem is all-passing, so it's excluded; transactions (3 gaps) before putItem (1 gap).
  assert.deepEqual(b.map((a) => a.key), ["tier2/transactions", "tier1/putItem"]);
  assert.equal(b[0].failed, 2);
  assert.equal(b[0].skipped, 1);
  assert.deepEqual(b[0].skips, ["Transactions support idempotency"]);
  assert.equal(b[1].failures[0], "PutItem rejects oversized items");
});

test("areaState classifies supported / partial / unsupported / failing", () => {
  assert.equal(areaState({ passed: 5, failed: 0, skipped: 0 }), "supported"); // clean pass
  assert.equal(areaState({ passed: 5, failed: 0, skipped: 2 }), "partial"); // passes what it runs, skips some
  assert.equal(areaState({ passed: 4, failed: 1, skipped: 0 }), "partial"); // mostly passes, one gap
  assert.equal(areaState({ passed: 4, failed: 1, skipped: 2 }), "partial"); // passes, fails and skips mixed
  assert.equal(areaState({ passed: 0, failed: 0, skipped: 3 }), "unsupported"); // implements none of it
  assert.equal(areaState({ passed: 0, failed: 2, skipped: 0 }), "failing"); // implemented, nothing passes
  assert.equal(areaState({ passed: 0, failed: 2, skipped: 9 }), "failing"); // implemented but every run fails
});

test("areaTallies keeps every area with counts + state, sorted by tier then group", () => {
  const raw = {
    testResults: [
      { name: "/x/tier1/getItem/a.test.ts", assertionResults: [{ status: "passed" }, { status: "passed" }] },
      { name: "/x/tier2/transactions/b.test.ts", assertionResults: [{ status: "skipped" }, { status: "skipped" }] },
      { name: "/x/tier1/putItem/c.test.ts", assertionResults: [{ status: "passed" }, { status: "failed" }] },
    ],
  };
  const a = areaTallies(raw);
  assert.deepEqual(a.map((x) => x.key), ["tier1/getItem", "tier1/putItem", "tier2/transactions"]);
  assert.equal(a.find((x) => x.group === "getItem").state, "supported");
  assert.equal(a.find((x) => x.group === "putItem").state, "partial"); // 1 pass, 1 fail: a mix
  assert.equal(a.find((x) => x.group === "transactions").state, "unsupported");
});

// Reproduce summarise.mjs's exact table for verbatim fixtures from the real
// results. These fixtures are pinned pre-2.0.0 (single-region ground truth, no
// Region column). Since 2.0.0 the suite's own table gained a Region column and
// a best-matching-region Total, so summariseToMarkdown no longer reproduces the
// current suite table, and these fixtures must not be regenerated from a current
// run without updating summariseToMarkdown or retiring these two assertions. The
// live consistency guarantee for the region-aware era is the numeric parity
// test below (port eu-west-2 score == summary.json eu-west-2 rate).
test("parity: newest run reproduces summarise.mjs output exactly", () => {
  const expected = readFileSync(join(fixtures, "newest.expected.txt"), "utf8").trim();
  const actual = summariseToMarkdown(readRun("newest")).trim();
  assert.equal(actual, expected);
});

test("parity: oldest run (local paths, no versions, smaller suite) reproduces summarise.mjs output exactly", () => {
  const expected = readFileSync(join(fixtures, "oldest.expected.txt"), "utf8").trim();
  const actual = summariseToMarkdown(readRun("oldest")).trim();
  assert.equal(actual, expected);
});

test("parity: DynamoDB row is synthesised at 100% across suite size even when no dynamodb.json is present", () => {
  // The oldest fixture set has no dynamodb.json, yet the row must appear.
  const table = summariseToMarkdown(readRun("oldest"));
  assert.match(table, /\| \[DynamoDB\]\([^)]+\) \| 100% \| 100% \| 100% \| 100% \| 526 \| 0 \| 0 \| live \(AWS\) \| - \|/);
});

// The region-aware parity guard. The headline number now comes from the suite's
// summary.json, so it can't disagree by construction; what can drift is the
// number the port still owns - the eu-west-2 column. This pins the port's score
// for each target to summary.json's eu-west-2 rate for the same run, reading a
// captured post-2.0.0 summary plus its matching results verbatim.
test("parity: the port's score equals summary.json's eu-west-2 rate for every target", () => {
  const dir = join(fixtures, "regions");
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  const round1 = (n) => Math.round(n * 10) / 10;
  let checked = 0;
  for (const slug of Object.keys(summary.targets)) {
    const euw2 = summary.targets[slug].regions["eu-west-2"];
    if (!euw2) continue; // a target absent from eu-west-2 this run is not a mismatch
    const raw = JSON.parse(readFileSync(join(dir, "results", `${slug}.json`), "utf8"));
    const scored = scoreEmulator(slug, raw, "-");
    assert.equal(round1(scored.totalValue), euw2.rate, `${slug}: port ${scored.totalValue} vs summary eu-west-2 ${euw2.rate}`);
    checked++;
  }
  assert.ok(checked >= 7, `expected every target checked, got ${checked}`);
});

test("isSelfMaintained flags the board author's own engine for the disclosure", () => {
  assert.equal(isSelfMaintained("dynoxide"), true);
  assert.equal(isSelfMaintained("dynalite"), false);
});

// The maps must be the suite's own objects, not a copy that happens to agree
// today. Comparing values would pass the moment someone reintroduced a local
// literal with the same contents, which is precisely the drift this module was
// changed to prevent; comparing identity fails the instant the import is
// replaced by a declaration.
test("the target maps are the suite's objects rather than a local copy", () => {
  assert.strictEqual(DISPLAY, suite.DISPLAY);
  assert.strictEqual(REPO, suite.REPO);
  assert.strictEqual(display, suite.display);
  assert.strictEqual(label, suite.label);
  assert.strictEqual(tierOf, suiteScore.tierOf);
});

test("every scored target is nameable and linkable from the shared maps", () => {
  // A slug present in one map and not the other renders as a bare slug or an
  // unlinked name on the board. Cheap to assert, invisible until published.
  for (const slug of Object.keys(DISPLAY)) {
    assert.equal(display(slug), DISPLAY[slug], `${slug} lost its display name`);
    assert.ok(REPO[slug], `${slug} has a display name but no project URL`);
  }
  assert.deepEqual(Object.keys(REPO).sort(), Object.keys(DISPLAY).sort());
});
