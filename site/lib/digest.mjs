import { createHash } from "node:crypto";

// A stable content hash of the derived history: run ids plus each target's total
// and version per run, plus the per-region overlay. The deploy workflow compares
// this against the last deployed digest to skip the S3 sync + CloudFront
// invalidation when a scheduled rebuild produced identical data (no daily no-op
// deploys). The overlay is included so a change confined to region data - a
// non-headline region's rate, or a region dropping in or out of scoring - still
// moves the digest and ships, even when no headline number changed.
export function historyDigest(model) {
  // Per run, per target: the headline figures plus which tests were failing.
  // Totals alone aren't enough - a target that fixes one test and breaks another
  // in the same run keeps its total, and a digest that only saw totals would
  // skip the deploy while the per-run pages were showing stale failures.
  const runs = (model.runs ?? []).map((r) => [
    r.id,
    r.standings.map((s) => [s.slug, s.total, s.version, s.runDate, (s.findings ?? []).map((f) => f.id).sort()]),
  ]);

  const health = model.regionHealth
    ? [model.regionHealth.observed ?? [], model.regionHealth.unresolved ?? [], model.regionHealth.dropped ?? []]
    : null;

  // Per target, each region's rate. Rates are the source of truth the cohort
  // label and headline derive from, so hashing them covers every region-only
  // change without double-counting the label.
  const regions = model.perTarget
    ? Object.entries(model.perTarget)
        .filter(([, t]) => t.hasRegions)
        .map(([slug, t]) => [slug, (t.regions ?? []).map((x) => [x.region, x.rate])])
    : [];

  const projection = [runs, health, regions];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex").slice(0, 16);
}
