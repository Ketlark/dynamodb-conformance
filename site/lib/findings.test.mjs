import { test } from "node:test";
import assert from "node:assert/strict";

import { findingId, normaliseName, findingsOf, sourceUrl, findingsForArea, areaFailures } from "./findings.mjs";

const CI = "/home/runner/work/dynamodb-conformance/dynamodb-conformance/";

// A Vitest-shaped assertion. Defaults to a failure with a parseable stack frame,
// since that is the case every finding is derived from.
const ar = (over = {}) => ({
  fullName: "UpdateTable — GSI validation rejects a GSI keyed on a stored attribute",
  status: "failed",
  tags: ["update-table", "control-plane", "gsi"],
  failureMessages: [`AssertionError: expected\n    at Proxy.<anonymous> (file://${CI}tests/tier2/updateTable/gsi.test.ts:745:5)`],
  ...over,
});

// A results payload: one test file holding the given assertions.
const raw = (assertions, file = "tests/tier2/updateTable/gsi.test.ts") => ({
  testResults: [{ name: CI + file, assertionResults: assertions }],
});

const meta = { version: "0.11.4", sha: "c0a3586" };

test("derives one record per failing assertion, carrying name, tier, group, tags and version", () => {
  const out = findingsOf(raw([ar({ fullName: "a" }), ar({ fullName: "b" }), ar({ fullName: "c" })]), meta);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((f) => f.fullName), ["a", "b", "c"]);
  const [first] = out;
  assert.equal(first.tier, "tier2");
  assert.equal(first.group, "updateTable");
  assert.deepEqual(first.tags, ["update-table", "control-plane", "gsi"]);
  assert.equal(first.version, "0.11.4");
});

test("parses file and line from the assertion's stack frame", () => {
  const [f] = findingsOf(raw([ar()]), meta);
  assert.equal(f.file, "tests/tier2/updateTable/gsi.test.ts");
  assert.equal(f.line, 745);
});

test("a failure with no parseable frame keeps the file and reports no line", () => {
  const [f] = findingsOf(raw([ar({ failureMessages: ["Error: something went wrong with no frame"] })]), meta);
  assert.equal(f.file, "tests/tier2/updateTable/gsi.test.ts");
  assert.equal(f.line, null);
});

test("ignores stack frames that are not in the suite's own test files", () => {
  const msgs = [`Error\n    at node_modules/vitest/dist/index.js:99:1\n    at file://${CI}tests/tier1/putItem/basic.test.ts:12:3`];
  const [f] = findingsOf(raw([ar({ failureMessages: msgs })], "tests/tier1/putItem/basic.test.ts"), meta);
  assert.equal(f.line, 12, "should take the first frame inside tests/, not the node_modules frame");
});

test("skipped and passing assertions produce no findings", () => {
  const out = findingsOf(raw([ar({ status: "passed" }), ar({ status: "pending" }), ar({ status: "skipped" })]), meta);
  assert.deepEqual(out, []);
});

test("a payload with no failures returns an empty array, not null", () => {
  assert.deepEqual(findingsOf(raw([ar({ status: "passed" })]), meta), []);
  assert.deepEqual(findingsOf({ testResults: [] }, meta), []);
  assert.deepEqual(findingsOf(null, meta), []);
});

test("a test file outside the tier structure is skipped rather than throwing", () => {
  const out = findingsOf(raw([ar()], "tests/helpers/setup.test.ts"), meta);
  assert.deepEqual(out, []);
});

test("identity is stable across whitespace and dash styling in the name", () => {
  assert.equal(findingId("PutItem — rejects  an  empty set"), findingId("PutItem - rejects an empty set"));
  assert.equal(normaliseName("PutItem — rejects  an  empty set"), normaliseName("PutItem - rejects an empty set"));
});

test("identity differs for genuinely different names", () => {
  assert.notEqual(findingId("PutItem rejects an empty set"), findingId("PutItem accepts an empty set"));
});

test("identity is a short stable hex token", () => {
  const id = findingId("PutItem rejects an empty set");
  assert.match(id, /^[0-9a-f]{10}$/);
  assert.equal(id, findingId("PutItem rejects an empty set"), "must be deterministic across calls");
});

test("two assertions sharing a name in different files produce distinct records and flag the clash", () => {
  const payload = {
    testResults: [
      { name: CI + "tests/tier1/putItem/basic.test.ts", assertionResults: [ar({ fullName: "same title" })] },
      { name: CI + "tests/tier2/transactions/write.test.ts", assertionResults: [ar({ fullName: "same title" })] },
    ],
  };
  const out = findingsOf(payload, meta);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].id, out[1].id, "ids must not collide when the same title appears in two files");
});

test("an id is the same regardless of what else failed alongside it", () => {
  // The qualifier used to be decided per run from the failing set, so one test
  // got different ids on two targets depending on their other failures.
  const alone = findingsOf(raw([ar({ fullName: "shared" })]), meta);
  const alongside = findingsOf({
    testResults: [
      { name: CI + "tests/tier2/updateTable/gsi.test.ts", assertionResults: [ar({ fullName: "shared" })] },
      { name: CI + "tests/tier1/putItem/basic.test.ts", assertionResults: [ar({ fullName: "shared" })] },
    ],
  }, meta);
  assert.equal(alone[0].id, alongside[0].id, "same test, same file, same id either way");
});

test("records carry the run's sha so a source link can pin to it", () => {
  const [f] = findingsOf(raw([ar()]), meta);
  assert.equal(f.sha, "c0a3586");
});

test("missing tags degrade to an empty array rather than undefined", () => {
  const [f] = findingsOf(raw([ar({ tags: undefined })]), meta);
  assert.deepEqual(f.tags, []);
});

const REPO = "https://github.com/paritysuite/dynamodb-conformance";

test("a finding with a line pins the source to the measured commit at that line", () => {
  const [f] = findingsOf(raw([ar()]), meta);
  assert.equal(sourceUrl(f, REPO), `${REPO}/blob/c0a3586/tests/tier2/updateTable/gsi.test.ts#L745`);
});

test("a finding with no line pins to the file with no fragment", () => {
  const [f] = findingsOf(raw([ar({ failureMessages: ["no frame here"] })]), meta);
  const url = sourceUrl(f, REPO);
  assert.equal(url, `${REPO}/blob/c0a3586/tests/tier2/updateTable/gsi.test.ts`);
  assert.ok(!url.includes("#L"), "must not emit a dangling #L fragment");
});

test("a finding with no sha falls back to the default branch rather than emitting an empty ref", () => {
  const [f] = findingsOf(raw([ar()]), { ...meta, sha: null });
  assert.equal(sourceUrl(f, REPO), `${REPO}/blob/main/tests/tier2/updateTable/gsi.test.ts#L745`);
});

test("areaFailures prefers finding records when the snapshot carries them", () => {
  const all = findingsOf(raw([ar({ fullName: "x" })]), meta);
  const area = { key: "tier2/updateTable", failures: ["stale title"] };
  const out = areaFailures(area, all);
  assert.equal(out.length, 1);
  assert.equal(out[0].fullName, "x");
  assert.ok(out[0].id, "record-backed entries are citable");
});

test("areaFailures degrades to plain titles for snapshots predating findings", () => {
  const area = { key: "tier2/updateTable", failures: ["an older title", "another"] };
  const out = areaFailures(area, undefined);
  assert.deepEqual(out.map((f) => f.fullName), ["an older title", "another"]);
  assert.ok(out.every((f) => f.id === null), "degraded entries render but are not citable");
});

test("areaFailures returns an empty list for an area with no failures", () => {
  assert.deepEqual(areaFailures({ key: "tier1/putItem", failures: [] }, []), []);
  assert.deepEqual(areaFailures(undefined, undefined), []);
});

test("findingsForArea groups findings by their operation area", () => {
  const payload = {
    testResults: [
      { name: CI + "tests/tier1/putItem/basic.test.ts", assertionResults: [ar({ fullName: "p1" }), ar({ fullName: "p2" })] },
      { name: CI + "tests/tier2/transactions/write.test.ts", assertionResults: [ar({ fullName: "t1" })] },
    ],
  };
  const all = findingsOf(payload, meta);
  assert.deepEqual(findingsForArea(all, "tier1/putItem").map((f) => f.fullName), ["p1", "p2"]);
  assert.deepEqual(findingsForArea(all, "tier2/transactions").map((f) => f.fullName), ["t1"]);
  assert.deepEqual(findingsForArea(all, "tier3/nothing"), []);
  assert.deepEqual(findingsForArea(undefined, "tier1/putItem"), [], "missing findings degrade to empty");
});

test("two failures sharing a title in the same file get distinct ids", () => {
  // A parameterised test emits the same fullName more than once in one file, so
  // the file cannot separate them and an ordinal has to.
  const [a, b] = findingsOf(raw([ar({ fullName: "same title" }), ar({ fullName: "same title" })]), meta);
  assert.notEqual(a.id, b.id);
});

test("a line number is only taken from the finding's own file", () => {
  const msgs = [`Error\n    at file://${CI}tests/tier1/putItem/helpers.test.ts:900:1\n    at file://${CI}tests/tier2/updateTable/gsi.test.ts:745:5`];
  const [f] = findingsOf(raw([ar({ failureMessages: msgs })]), meta);
  assert.equal(f.line, 745, "must skip the frame from another test file, even though it comes first");
});

test("a test path with an unbalanced regex metacharacter parses rather than throwing", () => {
  // An unescaped path went straight into a RegExp, so a file like q(a.test.ts
  // built an invalid pattern and threw. The throw was uncaught in the fetch
  // loop, which would have dropped a whole build to the fallback: one oddly
  // named upstream file failing the daily deploy.
  const file = "tests/tier2/updateTable/q(a.test.ts";
  const msgs = [`Error\n    at file://${CI}${file}:12:3`];
  const raw = { testResults: [{ name: CI + file, assertionResults: [ar({ failureMessages: msgs })] }] };
  const [f] = findingsOf(raw, meta);
  assert.equal(f.line, 12);
  assert.equal(f.file, file);
});

test("a decoy frame whose path only matches under dot-wildcarding is not taken", () => {
  // The finding's file is gsi.test.ts. A frame for gsiXtest.ts:99 matches it
  // only if the dots in the path are treated as regex wildcards, which is what
  // an unescaped path would do. The real frame is second, so a greedy match
  // would return 99 instead of 745.
  const msgs = [`Error\n    at file://${CI}tests/tier2/updateTable/gsiXtest.ts:99:1\n    at file://${CI}tests/tier2/updateTable/gsi.test.ts:745:5`];
  const [f] = findingsOf(raw([ar({ failureMessages: msgs })]), meta);
  assert.equal(f.line, 745);
});

test("a frame for a different file yields no line rather than a wrong one", () => {
  const msgs = [`Error\n    at file://${CI}tests/tier1/putItem/other.test.ts:31:2`];
  const [f] = findingsOf(raw([ar({ failureMessages: msgs })]), meta);
  assert.equal(f.line, null);
});

test("sourceUrl returns null for a degraded record or a missing repo base", () => {
  const [degraded] = areaFailures({ key: "k", failures: ["an older title"] }, undefined);
  assert.equal(sourceUrl(degraded, REPO), null, "a title-only record has no file to link to");
  assert.equal(sourceUrl(null, REPO), null);
});

test("a test with no fullName falls back to its title, then to a placeholder", () => {
  const [byTitle] = findingsOf(raw([ar({ fullName: undefined, title: "just the title" })]), meta);
  assert.equal(byTitle.fullName, "just the title");
  const [unnamed] = findingsOf(raw([ar({ fullName: undefined, title: undefined })]), meta);
  assert.equal(unnamed.fullName, "(unnamed test)");
});
