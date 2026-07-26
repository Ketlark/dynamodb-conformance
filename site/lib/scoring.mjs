// Scoring for the site, built on the suite's own scoring modules.
//
// The target maps, tier classification and pass-rate maths are imported from
// the suite rather than restated here. They used to be a hand-copied port, and
// the copies drifted: a target added to the suite's maps took a further day to
// reach the site's, so for that day the board scored a target it could not
// name. Anything a reader could see on both surfaces now has one definition.
//
// What stays site-side is what the suite has no use for: the per-area and
// per-capability views, and the display choices behind them.
import {
  DISPLAY,
  REPO,
  display,
  repoUrl,
  label,
} from "dynamodb-conformance/scripts/summarise.mjs";
import { passRate, scoreResults, tierOf } from "dynamodb-conformance/scripts/lib/score.mjs";

export { DISPLAY, REPO, display, repoUrl, label, tierOf };

// Targets maintained by the person who also runs this board. The conflict of
// interest is disclosed at the score itself, because that disclosure is the
// board's credibility: the number is produced by the same automated tests as
// every other engine, not adjusted by hand.
export const SELF_MAINTAINED = new Set(["dynoxide"]);
export const isSelfMaintained = (slug) => SELF_MAINTAINED.has(slug);

// The operation group within a tier, e.g. tier2/transactions, taken from the
// test file's directory. Stable across the suite's growth (unlike test titles).
export const areaOf = (filePath) => {
  const m = filePath.match(/\/(tier[123])\/([^/]+)\//);
  return m ? { tier: m[1], group: m[2], key: `${m[1]}/${m[2]}` } : null;
};

// Per-area breakdown of where a target falls short: the operation groups with
// failing or skipped tests, each carrying the exact test titles. Sorted by the
// size of the gap. Used on target pages; not part of the README parity table.
export function breakdownOf(raw) {
  const map = new Map();
  for (const tr of raw?.testResults ?? []) {
    const area = areaOf(tr.name);
    if (!area) continue;
    if (!map.has(area.key)) {
      map.set(area.key, { key: area.key, tier: area.tier, group: area.group, passed: 0, failed: 0, skipped: 0, failures: [], skips: [] });
    }
    const e = map.get(area.key);
    for (const ar of tr.assertionResults ?? []) {
      const title = ar.fullName || ar.title || "(unnamed test)";
      if (ar.status === "passed") e.passed++;
      else if (ar.status === "failed") { e.failed++; e.failures.push(title); }
      else { e.skipped++; e.skips.push(title); }
    }
  }
  return [...map.values()]
    .filter((e) => e.failed + e.skipped > 0)
    .map((e) => ({ ...e, total: e.passed + e.failed + e.skipped }))
    .sort((a, b) => b.failed + b.skipped - (a.failed + a.skipped) || a.key.localeCompare(b.key));
}

// The support state of an operation area, shared by the badges and the matrix:
//   supported   - passes everything it runs, nothing skipped (fully implemented)
//   partial     - implemented, but not a clean pass: passes some, and fails
//                 and/or skips others (the operation works, with specific gaps)
//   failing     - implemented, but no test passes (every implemented test is wrong)
//   unsupported - every test skipped (the target implements none of it)
//
// A single failing edge case no longer paints a whole operation as failing:
// an area that mostly passes reads as partial, so the matrix distinguishes
// "works, with gaps" from "implemented but wholly wrong". `failing` is reserved
// for the genuinely broken case where nothing the target runs passes.
export function areaState({ passed, failed, skipped }) {
  if (passed === 0 && failed === 0) return "unsupported"; // nothing implemented (all skipped)
  if (failed === 0 && skipped === 0) return "supported"; // every test passes
  if (passed === 0) return "failing"; // implemented, but every run fails
  return "partial"; // a mix: passes some, fails and/or skips others
}

// Every operation area a target's results touch, with counts and derived state.
// Unlike breakdownOf this keeps the fully-supported areas too, so the badges
// (supported areas) and the matrix (all areas) can both build from it.
export function areaTallies(raw) {
  const map = new Map();
  for (const tr of raw?.testResults ?? []) {
    const area = areaOf(tr.name);
    if (!area) continue;
    if (!map.has(area.key)) {
      map.set(area.key, { key: area.key, tier: area.tier, group: area.group, passed: 0, failed: 0, skipped: 0 });
    }
    const e = map.get(area.key);
    for (const ar of tr.assertionResults ?? []) {
      if (ar.status === "passed") e.passed++;
      else if (ar.status === "failed") e.failed++;
      else e.skipped++;
    }
  }
  return [...map.values()]
    .map((e) => ({ ...e, total: e.passed + e.failed + e.skipped, state: areaState(e) }))
    .sort((a, b) => a.tier.localeCompare(b.tier) || a.group.localeCompare(b.group));
}

// Cross-cutting capability axes surfaced on the capability grid (target x
// capability). These are the chooser-relevant features the operation matrix
// can't show as one line because a directory tree fragments them - GSI support
// is exercised across createTable/query/scan/updateTable, legacy parameters
// span several operations, and so on.
//
// This list is a *display* choice: which tags to surface as columns, and their
// labels. Membership - which tests carry which tag - is NOT decided here. It
// comes from the suite's published tag manifest (results/tag-manifest.json),
// generated from the applied tags in src/tags.ts, so there is one source of
// truth and no path-pattern taxonomy to drift.
//
// Two groups. "core" is DynamoDB's own surface - indexes, PartiQL, transactions,
// streams, TTL, legacy params. "wider" features reach beyond DynamoDB into other
// AWS services: S3 for export/import, Kinesis for streaming, IAM for resource
// policies, CloudWatch for Contributor Insights, plus backups/PITR and the
// account-level APIs. A DynamoDB-only emulator won't have these; one that also
// emulates the surrounding services can, and some do. The group is surfaced
// rather than hidden, so a high score can't imply a feature the suite skipped.
export const CAPABILITIES = [
  { key: "gsi", label: "GSI", group: "core" },
  { key: "lsi", label: "LSI", group: "core" },
  { key: "partiql", label: "PartiQL", group: "core" },
  { key: "transactions", label: "Transactions", group: "core" },
  { key: "streams", label: "Streams", group: "core" },
  { key: "ttl", label: "TTL", group: "core" },
  { key: "legacy", label: "Legacy params", group: "core" },
  { key: "backups", label: "Backups / PITR", group: "wider" },
  { key: "export-import", label: "Export / import", group: "wider" },
  { key: "kinesis", label: "Kinesis", group: "wider" },
  { key: "resource-policy", label: "Resource policies", group: "wider" },
  { key: "contributor-insights", label: "Contributor Insights", group: "wider" },
  { key: "account", label: "Account API", group: "wider" },
];

// The capability groups, in display order, with the column heading each spans.
export const CAPABILITY_GROUPS = [
  { key: "core", label: "Core DynamoDB" },
  { key: "wider", label: "Other AWS services" },
];

// The repo-relative "tests/..." tail of a test file path, the manifest's join
// key. Results carry an absolute (CI) or local path; the manifest is keyed
// relative to the repo root.
const testsKey = (file) => {
  const i = file.indexOf("tests/");
  return i >= 0 ? file.slice(i) : file;
};

// Per-capability tally for one target's raw results, joined to the tag manifest:
// for each test, look up its resolved tags by (file, top-level describe title),
// then sum pass/fail/skip into every capability column that tag set includes.
// State is derived the same way areaState does, so the glyphs match the matrix.
// With no manifest (e.g. a fetch fallback) every capability reports n/a.
export function capabilityTallies(raw, manifest) {
  const describes = manifest?.describes ?? {};
  const tally = Object.fromEntries(CAPABILITIES.map((c) => [c.key, { passed: 0, failed: 0, skipped: 0 }]));
  for (const tr of raw?.testResults ?? []) {
    const byTitle = describes[testsKey(tr.name)] ?? {};
    for (const ar of tr.assertionResults ?? []) {
      const tags = byTitle[ar.ancestorTitles?.[0]] ?? [];
      for (const c of CAPABILITIES) {
        if (!tags.includes(c.key)) continue;
        const e = tally[c.key];
        if (ar.status === "passed") e.passed++;
        else if (ar.status === "failed") e.failed++;
        else e.skipped++;
      }
    }
  }
  return CAPABILITIES.map((c) => {
    const e = tally[c.key];
    return { key: c.key, label: c.label, ...e, total: e.passed + e.failed + e.skipped, state: areaState(e) };
  });
}

// Numeric correctness for charts / sorting / movement: correctness over
// IMPLEMENTED operations, passed / (passed + failed). Skips are excluded from
// the denominator (an operation the target doesn't implement is scope, not a
// fail). null when nothing was implemented. The suite's passRate under the
// name the site's callers already use.
const value = passRate;

// The same number as a display string, one decimal place, "-" when nothing was
// implemented. Formatting is the only thing the site adds over passRate.
export const pct = (passed, failed) => {
  const rate = passRate(passed, failed);
  return rate === null ? "-" : `${rate.toFixed(1)}%`;
};

export const runDateOf = (raw) =>
  raw?.startTime ? new Date(raw.startTime).toISOString().slice(0, 10) : "-";

// A document with no testResults array scores nothing. The suite's scorer says
// so by returning null; the site still has to render a row, so an empty tally
// stands in and the target shows "-" rather than vanishing from the board.
const NOTHING_SCORED = {
  summary: {
    tier1: { p: 0, f: 0, s: 0, i: 0 },
    tier2: { p: 0, f: 0, s: 0, i: 0 },
    tier3: { p: 0, f: 0, s: 0, i: 0 },
  },
  passed: 0,
  failed: 0,
  skipped: 0,
  indeterminate: 0,
  count: 0,
};

const tierTotal = (t) => t.p + t.f + t.s + t.i;

// Score one target's Vitest JSON into the canonical row the rest of the site
// builds on. Not used for the synthesised DynamoDB ground-truth row.
//
// The tallying is the suite's (scoreResults -> classifyResults), so a test the
// suite counts one way cannot be counted another way here. That matters most
// for the verdict the raw status cannot express: a timeout or an exhausted
// throttle records as "failed" but means nobody observed an answer, and the
// suite excludes it from the score rather than holding it against the target.
// Tallying it here from `status` alone would have scored those runs lower than
// the published table does.
//
// No sidecar is passed. The site reads historical results one file at a time
// from the published tree and has no run-level indeterminate document to go
// with them, so only per-test markers are honoured. That is the same input the
// site has always had; it is now read through the shared classifier.
export function scoreEmulator(slug, raw, version) {
  const scored = scoreResults(raw, null) ?? NOTHING_SCORED;
  const s = scored.summary;

  const tier = (t) => ({
    passed: t.p,
    failed: t.f,
    skipped: t.s,
    indeterminate: t.i,
    total: tierTotal(t),
    pct: pct(t.p, t.f),
    value: value(t.p, t.f),
  });

  const { passed, failed, skipped, indeterminate, count } = scored;
  // Scope axis, distinct from correctness: how much of the suite the target
  // actually implements. Always shown beside the correctness percentage so a
  // high score on a narrow surface can't read as broad conformance.
  const implemented = passed + failed;
  const coverageValue = count === 0 ? null : (implemented / count) * 100;

  return {
    slug,
    target: label(slug),
    display: display(slug),
    repoUrl: repoUrl(slug),
    tiers: { tier1: tier(s.tier1), tier2: tier(s.tier2), tier3: tier(s.tier3) },
    passed,
    failed,
    skipped,
    indeterminate,
    count,
    implemented,
    unsupported: skipped,
    coverageValue,
    coverage: coverageValue === null ? "-" : `${coverageValue.toFixed(1)}%`,
    total: pct(passed, failed),
    totalValue: value(passed, failed),
    version: version || "-",
    runDate: runDateOf(raw),
  };
}

// Synthesise the DynamoDB ground-truth row: real DynamoDB is 100% by
// definition across the full suite, so the row is present and correct even on
// runs that never exercised AWS. suiteSize is the largest emulator count seen.
export function dynamodbRow(suiteSize, date) {
  return {
    slug: "dynamodb",
    target: label("dynamodb"),
    display: display("dynamodb"),
    repoUrl: repoUrl("dynamodb"),
    tiers: {
      tier1: { passed: suiteSize, failed: 0, skipped: 0, total: suiteSize, pct: "100%", value: 100 },
      tier2: { passed: suiteSize, failed: 0, skipped: 0, total: suiteSize, pct: "100%", value: 100 },
      tier3: { passed: suiteSize, failed: 0, skipped: 0, total: suiteSize, pct: "100%", value: 100 },
    },
    passed: suiteSize,
    failed: 0,
    skipped: 0,
    count: suiteSize,
    implemented: suiteSize,
    unsupported: 0,
    coverageValue: 100,
    coverage: "100%",
    total: "100%",
    totalValue: 100,
    version: "live (AWS)",
    runDate: date,
    synthesised: true,
    // The one flag that governs "gets no dated pages, gets no dated links",
    // matching the `baseline` on this target's perTarget entry, so the standings
    // row and the model agree. `synthesised` stays for display only (the movement
    // label and the ground-truth styling).
    baseline: true,
  };
}

// Largest emulator count in a set of scored rows - the full-suite size.
export const suiteSizeOf = (rows) => Math.max(0, ...rows.map((r) => r.count));

// Sort emulators by total descending ("-" last), then by display name, exactly
// as summarise.mjs does. The tie-break compares the plain name, not the
// `[name](url)` label: comparing the label sorts on the first character after
// the name - a "]" for a bare name, a space for a parenthetical one - so
// "Dynoxide (wasm)" would sort above "Dynoxide" on an equal total, putting the
// preview above the engine it is a variant of. Comparing names makes a base
// engine a prefix of its variant, so "Dynoxide" sorts above "Dynoxide (wasm)".
const numTotal = (t) => (t === "-" ? -1 : parseFloat(t));
const sortName = (row) => {
  const m = row.target.match(/^\[([^\]]+)\]/);
  return m ? m[1] : row.target;
};
export function sortRows(rows) {
  return [...rows].sort(
    (a, b) => numTotal(b.total) - numTotal(a.total) || sortName(a).localeCompare(sortName(b)),
  );
}

// The site used to carry a second markdown-table renderer here, reproducing the
// suite's published table so a test could diff the two and catch drift. The
// suite has since rewritten its table per region, and the fixtures that pinned
// this one dated from before that, so it was pinning the site against its own
// past rather than against the suite. The scoring it shared with the suite is
// now imported outright, and the guard that does real work is the numeric check
// in scoring.test.mjs against the published summary.
