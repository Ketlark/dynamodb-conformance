import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChangelog, dateLabel, entryRunBadges } from "./changelog.mjs";

test("dateLabel renders a human date", () => {
  assert.equal(dateLabel("2026-07-01"), "1 Jul 2026");
  assert.equal(dateLabel("2026-12-25"), "25 Dec 2026");
});

test("parses plain dated headings newest-first", () => {
  const { entries, skipped } = parseChangelog(
    ["# History", "", "## 2026-07-01", "", "Added a tier.", "", "## 2026-06-30", "", "Added a target."].join("\n"),
  );
  assert.deepEqual(
    entries.map((e) => e.date),
    ["2026-07-01", "2026-06-30"],
  );
  assert.match(entries[0].bodyHtml, /Added a tier\./);
  assert.deepEqual(skipped, []);
});

// The regression: the suite began tagging headings with a release, and an
// end-anchored date pattern silently dropped every tagged entry.
test("keeps entries whose heading carries a release tag", () => {
  const { entries, skipped } = parseChangelog(
    ["## 2026-07-17 (2.0.0)", "", "Per-region scoring lands.", "", "## 2026-07-13 (2.0.0-pre)", "", "Scoring groundwork."].join("\n"),
  );
  assert.deepEqual(
    entries.map((e) => e.date),
    ["2026-07-17", "2026-07-13"],
  );
  assert.deepEqual(
    entries.map((e) => e.version),
    ["2.0.0", "2.0.0-pre"],
  );
  assert.deepEqual(skipped, []);
});

test("version is null when the heading is bare", () => {
  const { entries } = parseChangelog("## 2026-07-01\n\nAdded a tier.");
  assert.equal(entries[0].version, null);
});

test("an entry body stops at the next heading", () => {
  const { entries } = parseChangelog(
    ["## 2026-07-17 (2.0.0)", "", "Newest note.", "", "## 2026-07-01", "", "Older note."].join("\n"),
  );
  assert.match(entries[0].bodyHtml, /Newest note\./);
  assert.doesNotMatch(entries[0].bodyHtml, /Older note\./);
});

// A heading we can't read must be reported, never dropped in silence - that
// silence is what let the site render a stale page on a green build.
test("reports unparseable headings instead of dropping them quietly", () => {
  const { entries, skipped } = parseChangelog(
    ["## Coming soon", "", "Pending.", "", "## 2026-07-01", "", "Added a tier."].join("\n"),
  );
  assert.deepEqual(
    entries.map((e) => e.date),
    ["2026-07-01"],
  );
  assert.deepEqual(skipped, ["Coming soon"]);
});

// Branches write their changelog with the work, so an Unreleased section is
// expected rather than a heading nobody anticipated. It must not reach
// `skipped`, which fails the scheduled build by design.
test("holds an Unreleased section back without reporting it as unreadable", () => {
  const { entries, skipped, unreleased } = parseChangelog(
    ["## Unreleased", "", "Pending note.", "", "## 2026-07-01", "", "Added a tier."].join("\n"),
  );
  assert.deepEqual(
    entries.map((e) => e.date),
    ["2026-07-01"],
  );
  assert.deepEqual(skipped, []);
  assert.match(unreleased.bodyHtml, /Pending note\./);
});

test("an Unreleased section stops at the next heading, and is null when absent", () => {
  const { unreleased } = parseChangelog(
    ["## Unreleased", "", "Pending note.", "", "## 2026-07-01", "", "Older note."].join("\n"),
  );
  assert.doesNotMatch(unreleased.bodyHtml, /Older note\./);
  assert.equal(parseChangelog("## 2026-07-01\n\nAdded a tier.").unreleased, null);
});

test("the committed fallback parses cleanly", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "changelog-fallback.md");
  const { entries, skipped } = parseChangelog(await readFile(path, "utf8"));
  assert.ok(entries.length > 0, "fallback should yield entries");
  assert.deepEqual(skipped, []);
});

// Shaped like history's runs, trimmed to what the badge needs. Real dates and
// sizes from the suite, so the expectations below are the published figures.
const RUNS = [
  { date: "2026-06-21", id: "2026-06-21", suiteSize: 706 },
  { date: "2026-06-22", id: "2026-06-22", suiteSize: 736 },
  { date: "2026-06-23", id: "2026-06-23", suiteSize: 744 },
  { date: "2026-06-24", id: "2026-06-24", suiteSize: 762 },
  { date: "2026-06-27", id: "2026-06-27", suiteSize: 817 },
  { date: "2026-06-29", id: "2026-06-29", suiteSize: 817 },
  { date: "2026-06-30", id: "2026-06-30", suiteSize: 824 },
  { date: "2026-07-01", id: "2026-07-01", suiteSize: 873 },
  { date: "2026-07-06", id: "2026-07-06", suiteSize: 873 },
  { date: "2026-07-13", id: "2026-07-13", suiteSize: 873 },
  { date: "2026-07-14", id: "2026-07-14", suiteSize: 954 },
  { date: "2026-07-17", id: "2026-07-17", suiteSize: 954 },
];

// Default pairing: the nearest run on or after the entry.
test("badges the nearest run on or after the entry", () => {
  const badges = entryRunBadges(["2026-07-13"], RUNS, {});
  assert.equal(badges["2026-07-13"].size, 873);
  assert.equal(badges["2026-07-13"].id, "2026-07-13");
});

// 2026-07-13's tests landed after its run, so the shipped override points the
// entry at the run that measured the 954 its prose describes.
test("an override names the run that measured the entry", () => {
  const badges = entryRunBadges(["2026-07-13"], RUNS);
  assert.equal(badges["2026-07-13"].size, 954);
  assert.equal(badges["2026-07-13"].id, "2026-07-14");
});

// The override names a run, never a number: the figure still comes from the
// run's own data, so correcting the data corrects the badge.
test("an override takes its figure from the named run's data", () => {
  const moved = RUNS.map((r) => (r.id === "2026-07-14" ? { ...r, suiteSize: 961 } : r));
  const badges = entryRunBadges(["2026-07-13"], moved);
  assert.equal(badges["2026-07-13"].size, 961);
});

// A run that isn't in the data (a fallback that predates it) must not blank the
// badge - the entry falls back to the nearest run.
test("an override naming an absent run falls back to the nearest", () => {
  const badges = entryRunBadges(["2026-07-13"], RUNS, { "2026-07-13": "2026-09-01" });
  assert.equal(badges["2026-07-13"].id, "2026-07-13");
});

test("badges an entry whose own run measured the change", () => {
  const badges = entryRunBadges(["2026-06-30"], RUNS);
  assert.equal(badges["2026-06-30"].size, 824);
  assert.equal(badges["2026-06-30"].id, "2026-06-30");
});

// The gap fill: without it these entries rendered with no figure at all.
test("badges an entry falling on a date with no run", () => {
  const badges = entryRunBadges(["2026-06-26"], RUNS);
  assert.equal(badges["2026-06-26"].size, 817);
  assert.equal(badges["2026-06-26"].id, "2026-06-27");
});

// An entry that added a target rather than tests keeps its own flat reading,
// and is never credited with the next run's growth.
test("an entry that moved nothing keeps its own run", () => {
  const flat = [
    { date: "2026-04-27", id: "2026-04-27", suiteSize: 601 },
    { date: "2026-05-23", id: "2026-05-23", suiteSize: 601 },
    { date: "2026-05-24", id: "2026-05-24", suiteSize: 625 },
  ];
  const badges = entryRunBadges(["2026-05-23"], flat);
  assert.equal(badges["2026-05-23"].size, 601);
  assert.equal(badges["2026-05-23"].id, "2026-05-23");
});

test("the oldest entry takes the first run on or after it", () => {
  const badges = entryRunBadges(["2026-06-21"], RUNS);
  assert.equal(badges["2026-06-21"].id, "2026-06-21");
  assert.equal(badges["2026-06-21"].size, 706);
});

test("an entry newer than every run gets no badge", () => {
  assert.deepEqual(entryRunBadges(["2026-08-01"], RUNS), {});
});

test("no runs yields no badges", () => {
  assert.deepEqual(entryRunBadges(["2026-07-13"], []), {});
});
