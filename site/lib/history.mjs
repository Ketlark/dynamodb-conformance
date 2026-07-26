// Assemble the conformance history model from per-target snapshots.
//
// A snapshot is a scored emulator row (see lib/scoring.mjs) plus its run
// identity: { startTime (epoch ms), sha }. Runs are derived from startTime
// dates, never from commits - a single commit often refreshes only some
// targets, and one commit can carry targets whose startTimes belong to
// different runs, so grouping by commit would invent runs that never happened.
//
// Within a run date the latest startTime per target wins (a target re-run later
// the same day supersedes the earlier result), and a target not re-tested in a
// run is carried forward at its last measured value.

import { dynamodbRow, label, display, repoUrl, sortRows, suiteSizeOf, CAPABILITIES } from "./scoring.mjs";

function deltaMovement(cur, prev) {
  if (cur == null || prev == null) {
    return { state: "flat", arrow: "–", delta: null, deltaLabel: "–", label: "unchanged" };
  }
  const r = Math.round((cur - prev) * 10) / 10;
  if (r > 0) {
    return { state: "up", arrow: "▲", delta: r, deltaLabel: `+${r.toFixed(1)}pp`, label: `rose ${r.toFixed(1)} percentage points` };
  }
  if (r < 0) {
    return { state: "down", arrow: "▼", delta: r, deltaLabel: `${r.toFixed(1)}pp`, label: `fell ${Math.abs(r).toFixed(1)} percentage points` };
  }
  return { state: "flat", arrow: "–", delta: 0, deltaLabel: "0.0pp", label: "unchanged" };
}

const newMovement = () => ({ state: "new", arrow: "–", delta: null, deltaLabel: "new", label: "first run for this target" });
const carriedMovement = () => ({ state: "carried", arrow: "–", delta: null, deltaLabel: "–", label: "not re-tested this run" });
const baselineMovement = () => ({ state: "baseline", arrow: "–", delta: null, deltaLabel: "–", label: "baseline - live AWS DynamoDB" });

const fmtRate = (r) => (r == null ? "-" : `${r.toFixed(1)}%`);

// Overlay a snapshot's headline with the best-matching region from the summary,
// where one exists for that run and target. The port's eu-west-2 score is kept
// as portTotalValue for the parity check; the summary's rate becomes the
// displayed total, so sort, movement, movers and the chart all follow the
// best-match number from the point the summary begins. Runs with no summary keep
// the eu-west-2 score exactly as before, which is what makes the pre-2.0.0
// timeline (and any build without the overlay) unchanged.
function enrichSnapshot(s, summary) {
  const sm = summary?.byRunDate?.[s.runDate]?.targets?.[s.slug];
  if (!sm) return s;
  return {
    ...s,
    portTotalValue: s.totalValue,
    portTotal: s.total,
    totalValue: sm.rate,
    total: fmtRate(sm.rate),
    regionLabel: sm.label,
    hasRegions: true,
  };
}

// Distinct runs that share a calendar date get sha-disambiguated ids. Date
// grouping makes collisions impossible in practice, but the capability is kept
// so the run-id scheme stays stable if grouping ever changes.
export function assignRunIds(runs) {
  const counts = {};
  for (const r of runs) counts[r.date] = (counts[r.date] || 0) + 1;
  return runs.map((r) => (counts[r.date] > 1 ? `${r.date}-${r.sha.slice(0, 7)}` : r.date));
}

// Every (target, run) pair that was actually measured, flat, so a page can be
// built per pair. Carried-forward dates aren't pairs: nothing was measured then,
// so a page for one would only repeat an earlier run's numbers under the wrong
// date.
//
// Derived from a model rather than computed inside buildModel, so the committed
// fallback (which is a serialised model, not a rebuilt one) gets it too. Without
// that, a build that falls back would find no pagination data and fail outright.
// The baseline is excluded. Its series is synthesised one point per run, never
// measured, so a page per date would describe a run that never happened for it
// and read as though real DynamoDB had been tested and scored.
export const targetRunsOf = (model) =>
  (model?.targets ?? [])
    .filter((slug) => !model.perTarget?.[slug]?.baseline)
    .flatMap((slug) => (model.perTarget?.[slug]?.series ?? []).map((p) => ({ slug, runId: p.runId, date: p.date })));

// The model with per-failure findings thinned to what the committed fallback
// needs. Carrying every run's findings takes the file from ~1.3 MB to ~30 MB,
// because each failing test's name, tags and path repeat for each target on
// each run.
//
// Only the two references the site renders from keep their findings:
// `perTarget[].findings` feeds the target page, and the newest `series[]` point
// feeds that target's newest per-run page. The same records also reach the file
// through `runs[].standings[]`, `latest.standings[]` and `perTarget[].current`,
// which are separate copies once serialised, so each is dropped or the whole set
// leaks back in. Two of those three were missed on earlier attempts, which is
// what this function and its test exist to stop recurring.
//
// The digest is taken from the full model before this runs, so it still moves
// when only findings change.
export function leanForFallback(model) {
  const drop = ({ findings, ...rest }) => rest;
  return {
    ...model,
    runs: (model.runs ?? []).map((r) => ({ ...r, standings: r.standings.map(drop) })),
    latest: model.latest ? { ...model.latest, standings: model.latest.standings.map(drop) } : model.latest,
    perTarget: Object.fromEntries(
      Object.entries(model.perTarget ?? {}).map(([slug, t]) => {
        const series = t.series ?? [];
        return [
          slug,
          {
            ...t,
            current: t.current ? drop(t.current) : t.current,
            series: series.map((p, i) => (i === series.length - 1 ? p : drop(p))),
          },
        ];
      }),
    ),
  };
}

export function buildModel(snapshots, summary = null) {
  const overlay = summary?.available ? summary : null;
  // Valid, time-ordered snapshots (drop anything without a usable startTime),
  // each overlaid with its best-matching region where the summary has one.
  const snaps = snapshots
    .filter((s) => Number.isFinite(s.startTime) && s.runDate && s.runDate !== "-")
    .sort((a, b) => a.startTime - b.startTime)
    .map((s) => (overlay ? enrichSnapshot(s, overlay) : s));

  // Per target, the latest snapshot for each run date (latest startTime wins).
  const byTarget = new Map(); // slug -> Map(date -> snapshot)
  for (const s of snaps) {
    if (!byTarget.has(s.slug)) byTarget.set(s.slug, new Map());
    const m = byTarget.get(s.slug);
    const existing = m.get(s.runDate);
    if (!existing || s.startTime > existing.startTime) m.set(s.runDate, s);
  }

  // Each target's own re-test dates, oldest first (ISO strings sort chronologically).
  const targetDates = new Map();
  for (const [slug, m] of byTarget) targetDates.set(slug, [...m.keys()].sort());

  // Representative sha + startTime per run date: the latest snapshot of that date.
  const runMeta = new Map(); // date -> { sha, startTime }
  for (const s of snaps) {
    const cur = runMeta.get(s.runDate);
    if (!cur || s.startTime > cur.startTime) runMeta.set(s.runDate, { sha: s.sha, startTime: s.startTime });
  }

  const dates = [...runMeta.keys()].sort(); // oldest first

  const movementForRetest = (slug, date) => {
    const ds = targetDates.get(slug);
    const idx = ds.indexOf(date);
    if (idx <= 0) return newMovement();
    const cur = byTarget.get(slug).get(date);
    const prev = byTarget.get(slug).get(ds[idx - 1]);
    return deltaMovement(cur.totalValue, prev.totalValue);
  };

  // Build runs oldest -> newest.
  const runsAsc = dates.map((date) => {
    const meta = runMeta.get(date);
    const emulatorRows = [];
    for (const [slug, m] of byTarget) {
      let eff = m.get(date);
      const reTested = !!eff;
      if (!eff) {
        const before = targetDates.get(slug).filter((d) => d < date);
        if (before.length === 0) continue; // target not yet present
        eff = m.get(before[before.length - 1]);
      }
      const movement = reTested ? movementForRetest(slug, date) : carriedMovement();
      // Keep the per-area data out of run rows; it lives on perTarget only.
      const { breakdown: _bd, areas: _ar, capabilities: _cap, ...effRow } = eff;
      emulatorRows.push({ ...effRow, reTested, carried: !reTested, movement });
    }

    const suiteSize = suiteSizeOf(emulatorRows);
    const sorted = sortRows(emulatorRows);
    // Real DynamoDB agrees with itself in every region, so its label is "all".
    const dynamodb = {
      ...dynamodbRow(suiteSize, date),
      reTested: true,
      carried: false,
      movement: baselineMovement(),
      ...(overlay ? { regionLabel: { kind: "all", regions: [], rate: 100 }, hasRegions: false } : {}),
    };
    const standings = [dynamodb, ...sorted];
    const top = sorted[0];

    return {
      date,
      sha: meta.sha,
      startTime: meta.startTime,
      standings,
      suiteSize,
      emulatorCount: emulatorRows.length,
      headline: {
        topSlug: top?.slug ?? "dynamodb",
        topDisplay: top?.display ?? display("dynamodb"),
        topTotal: top?.total ?? "100%",
        emulatorCount: emulatorRows.length,
      },
    };
  });

  const ids = assignRunIds(runsAsc.map((r) => ({ date: r.date, sha: r.sha })));
  runsAsc.forEach((r, i) => (r.id = ids[i]));
  const idByDate = new Map(runsAsc.map((r) => [r.date, r.id]));

  // Suite growth vs the previous run. When the suite grows under a target, a
  // run-over-run dip can be the new tests biting rather than a regression, so
  // run pages surface the growth and caveat the movement arrows.
  runsAsc.forEach((r, i) => {
    const prev = i > 0 ? runsAsc[i - 1] : null;
    r.prevSuiteSize = prev ? prev.suiteSize : null;
    r.suiteGrowth = prev ? r.suiteSize - prev.suiteSize : 0;
    r.suiteGrew = r.suiteGrowth > 0;
  });

  const runs = [...runsAsc].reverse(); // newest first
  const latest = runs[0] ?? null;

  // Movement map for the latest run, keyed by slug.
  const movement = {};
  if (latest) for (const row of latest.standings) movement[row.slug] = row.movement;

  // Biggest movers in the latest run: re-tested targets that rose or fell,
  // ordered by the size of the change.
  const movers = latest
    ? latest.standings
        .filter((r) => r.movement.state === "up" || r.movement.state === "down")
        .sort((a, b) => Math.abs(b.movement.delta) - Math.abs(a.movement.delta))
        .slice(0, 3)
        .map((r) => ({
          slug: r.slug,
          display: r.display,
          total: r.total,
          arrow: r.movement.arrow,
          deltaLabel: r.movement.deltaLabel,
          delta: r.movement.delta,
          state: r.movement.state,
          label: r.movement.label,
        }))
    : [];

  // Per-target series of distinct re-tests, each with movement vs the previous one.
  const perTarget = {};
  for (const [slug, m] of byTarget) {
    const ds = targetDates.get(slug);
    const series = ds.map((date, i) => {
      const s = m.get(date);
      const mv = i === 0 ? newMovement() : deltaMovement(s.totalValue, m.get(ds[i - 1]).totalValue);
      return {
        runId: idByDate.get(date),
        date,
        startTime: s.startTime,
        totalValue: s.totalValue,
        total: s.total,
        tiers: s.tiers,
        version: s.version,
        passed: s.passed,
        failed: s.failed,
        skipped: s.skipped,
        count: s.count,
        movement: mv,
        // What this run actually found, so a run's view of this target shows
        // that run's gaps rather than today's.
        findings: s.findings ?? [],
        sha: s.sha,
      };
    });
    const current = latest ? latest.standings.find((r) => r.slug === slug) : null;
    const latestSnap = m.get(ds[ds.length - 1]);
    // The per-region breakdown for the drilldown, from the target's latest
    // tested run (falling back to the overall latest summary).
    const smTarget = overlay ? overlay.byRunDate[ds[ds.length - 1]]?.targets?.[slug] ?? overlay.latest?.targets?.[slug] ?? null : null;
    perTarget[slug] = {
      slug,
      display: display(slug),
      target: label(slug),
      repoUrl: repoUrl(slug),
      baseline: false,
      current,
      currentVersion: current?.version ?? series[series.length - 1]?.version ?? "-",
      firstDate: ds[0],
      lastDate: ds[ds.length - 1],
      series,
      // Where the target currently falls short, and its full per-area state
      // (both from its latest snapshot).
      breakdown: latestSnap?.breakdown ?? [],
      // The same gaps as records rather than titles, so the target page can link
      // each one to its own assertion. Everything a record needs is already on it
      // from fetch.mjs; nothing is re-stamped here. Older snapshots predate
      // findings and render from the plain titles in `breakdown` instead.
      findings: latestSnap?.findings ?? [],
      areas: latestSnap?.areas ?? [],
      capabilities: latestSnap?.capabilities ?? [],
      supports: (latestSnap?.areas ?? []).filter((a) => a.state === "supported"),
      // Per-region detail and headline cohort for the drilldown (empty when the
      // overlay is unavailable).
      regions: smTarget?.regions ?? [],
      regionLabel: smTarget?.label ?? null,
      hasRegions: !!smTarget,
      runsPresent: runs.filter((r) => r.standings.some((x) => x.slug === slug)).map((r) => r.id),
    };
  }

  // The union of every operation area any target touches in its latest snapshot
  // - the matrix axis, and the set DynamoDB supports by definition.
  const allAreas = [];
  const seenArea = new Set();
  for (const slug of byTarget.keys()) {
    for (const a of perTarget[slug].areas) {
      if (seenArea.has(a.key)) continue;
      seenArea.add(a.key);
      allAreas.push({ key: a.key, tier: a.tier, group: a.group });
    }
  }
  allAreas.sort((a, b) => a.tier.localeCompare(b.tier) || a.group.localeCompare(b.group));

  // DynamoDB: a definitional flat-100% baseline, one point per run, not a trend.
  if (runsAsc.length > 0) {
    const series = runsAsc.map((r) => {
      const ddb = dynamodbRow(r.suiteSize, r.date);
      return {
        runId: r.id,
        date: r.date,
        startTime: r.startTime,
        totalValue: 100,
        total: "100%",
        tiers: ddb.tiers,
        version: "live (AWS)",
        passed: r.suiteSize,
        failed: 0,
        skipped: 0,
        count: r.suiteSize,
        movement: baselineMovement(),
      };
    });
    perTarget.dynamodb = {
      slug: "dynamodb",
      display: display("dynamodb"),
      target: label("dynamodb"),
      repoUrl: repoUrl("dynamodb"),
      baseline: true,
      current: latest ? latest.standings.find((r) => r.slug === "dynamodb") : null,
      currentVersion: "live (AWS)",
      firstDate: runsAsc[0].date,
      lastDate: latest.date,
      series,
      breakdown: [],
      // DynamoDB is the ground truth: it supports every area by definition.
      areas: allAreas.map((a) => ({ ...a, passed: 0, failed: 0, skipped: 0, total: 0, state: "supported" })),
      capabilities: CAPABILITIES.map((c) => ({ key: c.key, label: c.label, passed: 0, failed: 0, skipped: 0, total: 0, state: "supported" })),
      supports: allAreas.map((a) => ({ ...a, state: "supported" })),
      // The baseline agrees with itself everywhere, so it has no per-region
      // drilldown, only the "all regions" label.
      regions: [],
      regionLabel: overlay ? { kind: "all", regions: [], rate: 100 } : null,
      hasRegions: false,
      runsPresent: runs.map((r) => r.id),
    };
  }

  // Target order for indexes/pagination: the latest run's standings order
  // (DynamoDB first, then total descending), with any never-in-latest targets
  // appended. Carry-forward guarantees every seen target is in the latest run.
  const inLatest = latest ? latest.standings.map((r) => r.slug) : [];
  const others = [...byTarget.keys()].filter((s) => !inLatest.includes(s));
  const targets = [...inLatest, ...others];

  // The latest run's region health, surfaced on the model so the deploy digest
  // covers region-only changes (a region dropping in or out) even when no
  // headline number moves.
  const regionHealth = overlay?.latest?.regions ?? null;

  // The board shows each target's current build. That version comes from the
  // suite's summary, which the suite keeps current, rather than the version
  // captured at the run's commit. The two differ only when a version is
  // corrected without a fresh run - the wasm row, whose engine shipped in a
  // later release - where re-running just to move the label would cost the
  // target its "new" status. Scoped to the current display: historical runs
  // (runs[].standings and each target's series) keep the version they were
  // tested at.
  if (overlay?.latest?.targets) {
    for (const row of latest?.standings ?? []) {
      const v = overlay.latest.targets[row.slug]?.version;
      if (v) row.version = v; // perTarget[].current references this same row
    }
    for (const [slug, t] of Object.entries(perTarget)) {
      const v = overlay.latest.targets[slug]?.version;
      if (v) t.currentVersion = v;
    }
  }

  return { runs, latest, movement, movers, targets, perTarget, allAreas, regionHealth, targetRuns: targetRunsOf({ targets, perTarget }) };
}
