// Neutral, machine-readable views of the conformance model.
//
// These shape the same build-time model the HTML renders from into JSON a third
// party (or an agent) can consume instead of scraping the pages. Every target,
// including the live-AWS baseline, gets the identical schema: the data exposes
// the numbers and lets the consumer rank, it never editorialises or privileges
// one target's row. Like everything else on the site these are derived from the
// suite's own results at build time, so they can't drift from what's on screen.

import { CAPABILITIES, isSelfMaintained } from "./scoring.mjs";

// 2 adds the per-region dimension (each target's headline region and, on the
// latest endpoint, its full per-region breakdown and the run's region health),
// and corrects the baseline's region from the old single pin to "all".
export const DATA_SCHEMA_VERSION = 2;

// Tier metadata, surfaced so a consumer doesn't have to hard-code the names.
export const TIERS = [
  { key: "tier1", name: "Core", description: "The operations roughly 90% of DynamoDB users rely on: CRUD, queries, scans, batch operations, GSIs, UpdateTable." },
  { key: "tier2", name: "Complete", description: "Documented but less common features: transactions, PartiQL, LSIs, TTL, streams, tags." },
  { key: "tier3", name: "Strict", description: "Validation ordering, error behaviour, limits, and legacy API shapes." },
];

const groupByCapability = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c.group]));

// Tier scores as a {tier1, tier2, tier3} map, one shape whether the source row
// carries a tier or not (a missing tier is null, never absent).
function tierScores(tiers) {
  const out = {};
  for (const { key } of TIERS) {
    const t = tiers?.[key];
    out[key] = t
      ? { pct: t.pct, value: t.value, passed: t.passed, failed: t.failed, skipped: t.skipped, total: t.total }
      : null;
  }
  return out;
}

// The headline region a row's total was earned in, compacted for every row
// (latest and historical). `kind` says how the headline relates to the pinned
// baseline region: "all" (ties everywhere), "pinned-plus" (eu-west-2 is in the
// best cohort) or "beats-pinned" (the best cohort excludes eu-west-2, so the
// target matches a region eu-west-2 disagrees with). null before the per-region
// data begins. The full per-region breakdown is on the latest endpoint.
function regionSummary(row) {
  const label = row.regionLabel;
  if (!label) return null;
  return {
    kind: label.kind,
    cohort: label.regions ?? [],
    pinned: label.pinned ?? "eu-west-2",
    beatsPinned: label.kind === "beats-pinned",
  };
}

// One standings row -> the neutral, identical-schema target object every
// endpoint shares. Correctness and coverage travel together by design, so a
// high score on a narrow surface can't read as broad conformance.
function targetRow(row) {
  return {
    slug: row.slug,
    display: row.display,
    version: row.version,
    baseline: row.slug === "dynamodb",
    // Conflict-of-interest disclosure: maintained by the board's author. A
    // static fact, derived from the slug, so it can't go stale.
    maintainedByAuthor: isSelfMaintained(row.slug),
    carried: !!row.carried,
    reTested: !!row.reTested,
    total: { pct: row.total, value: row.totalValue },
    coverage: { pct: row.coverage, value: row.coverageValue },
    counts: { passed: row.passed, failed: row.failed, skipped: row.skipped, implemented: row.implemented, total: row.count },
    tiers: tierScores(row.tiers),
    region: regionSummary(row),
    movement: row.movement
      ? { state: row.movement.state, delta: row.movement.delta, deltaLabel: row.movement.deltaLabel, label: row.movement.label }
      : null,
  };
}

// A target's per-region breakdown for the latest endpoint: every observed
// region's rate, tier split and counts, with eu-west-2 flagged as the historical
// baseline and each region flagged for whether it's in the best-scoring cohort.
function regionTier(t) {
  return t ? { pct: t.pct, passed: t.passed, failed: t.failed, skipped: t.skipped, indeterminate: t.indeterminate, total: t.total } : null;
}
function regionDetail(pt) {
  return (pt.regions || []).map((r) => ({
    region: r.region,
    rate: r.rate,
    pinned: !!r.pinned,
    inCohort: !!r.inCohort,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    indeterminate: r.indeterminate,
    total: r.count,
    tiers: { tier1: regionTier(r.tiers?.tier1), tier2: regionTier(r.tiers?.tier2), tier3: regionTier(r.tiers?.tier3) },
  }));
}

// Self-describing header shared by every endpoint: schema version, provenance,
// licence and the baseline's identity, so any single file stands on its own.
function envelope(conformance, site) {
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    source: site.url,
    repository: site.sourceRepo,
    license: site.dataLicense,
    licenseName: site.dataLicenseName,
    attribution: site.dataAttribution,
    ...(conformance.generatedAt ? { generatedAt: conformance.generatedAt } : {}),
    baseline: {
      slug: "dynamodb",
      region: "all",
      description: "Live AWS DynamoDB. The ground truth: 100% by definition in every region, the value every other target is measured against.",
    },
  };
}

// Discovery manifest: a neutral map of the data surface, the tier and capability
// vocabularies, and where the documentation lives.
export function buildIndex(conformance, site) {
  const { latest, runs = [] } = conformance;
  return {
    ...envelope(conformance, site),
    name: "DynamoDB emulator conformance results",
    description:
      "Tier-level conformance scores for DynamoDB-compatible emulators, measured against live AWS DynamoDB and recorded run over run. Identical schema for every target, including the live-AWS baseline. Use these endpoints instead of scraping the pages.",
    documentation: site.url + "/for-agents",
    latestRun: latest?.id ?? null,
    runCount: runs.length,
    suiteSize: latest?.suiteSize ?? null,
    tiers: TIERS,
    capabilities: CAPABILITIES.map((c) => ({ key: c.key, label: c.label, group: c.group })),
    regions: {
      pinned: "eu-west-2",
      description:
        "Each target is scored against every observed region, and its total is its best-matching region. A target's `region` field says how that headline relates to the pinned region (all, pinned-plus or beats-pinned); the latest endpoint carries every region's rate and tier split per target, plus the run's region health.",
      health: [
        { key: "observed", description: "Completed this sweep and counts towards scores." },
        { key: "unresolved", description: "Missed this sweep but still trusted." },
        { key: "dropped", description: "Missed twice; out of scoring until it returns." },
      ],
    },
    endpoints: [
      { name: "Latest run", format: "application/json", url: site.url + "/data/latest.json", description: "Current standings: per target, per tier, coverage, capabilities, operation areas, and the full per-region breakdown." },
      { name: "All runs", format: "application/json", url: site.url + "/data/runs.json", description: "Full history: every run's per-target tier scores, coverage, movement and headline region." },
      { name: "Runs feed", format: "application/atom+xml", url: site.url + "/feed.xml", description: "Atom feed, one entry per run." },
    ],
  };
}

// The latest run in full: per target, per tier, coverage, plus the per-capability
// and per-operation-area state the matrix and capability grid are built from.
export function buildLatest(conformance, site) {
  const { latest, perTarget = {} } = conformance;
  if (!latest) return { ...envelope(conformance, site), run: null, tiers: TIERS, regionHealth: null, targets: [] };
  return {
    ...envelope(conformance, site),
    run: { id: latest.id, date: latest.date, suiteSize: latest.suiteSize, emulatorCount: latest.emulatorCount },
    tiers: TIERS,
    // Which regions scored this run: observed count towards scores, unresolved
    // missed this sweep but are still trusted, dropped are out of scoring. null
    // before the per-region data begins.
    regionHealth: conformance.regionHealth ?? null,
    targets: latest.standings.map((row) => {
      const pt = perTarget[row.slug] || {};
      return {
        ...targetRow(row),
        capabilities: (pt.capabilities || []).map((c) => ({
          key: c.key, label: c.label, group: groupByCapability[c.key] ?? null, state: c.state,
          passed: c.passed, failed: c.failed, skipped: c.skipped, total: c.total,
        })),
        areas: (pt.areas || []).map((a) => ({
          key: a.key, tier: a.tier, group: a.group, state: a.state,
          passed: a.passed, failed: a.failed, skipped: a.skipped, total: a.total,
        })),
        regions: regionDetail(pt),
      };
    }),
  };
}

// The full history: every run's standings, newest first. Tier scores, coverage
// and movement per target; the per-capability and per-area detail lives on the
// latest endpoint, since the model only carries it for the latest snapshot.
export function buildRuns(conformance, site) {
  const { runs = [], latest } = conformance;
  return {
    ...envelope(conformance, site),
    tiers: TIERS,
    latestRun: latest?.id ?? null,
    runs: runs.map((r) => ({
      id: r.id,
      date: r.date,
      sha: r.sha,
      suiteSize: r.suiteSize,
      emulatorCount: r.emulatorCount,
      targets: r.standings.map(targetRow),
    })),
  };
}
