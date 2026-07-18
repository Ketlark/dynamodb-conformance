#!/usr/bin/env node

/**
 * Post-process Vitest JSON output files into the published results artefacts:
 * the Markdown comparison table (README) and the versioned per-region summary
 * the site consumes (results/summary.json).
 *
 * Usage:
 *   node scripts/summarise.mjs                 # all results/*.json -> table on stdout
 *   node scripts/summarise.mjs results/*.json  # explicit files     -> table on stdout
 *   node scripts/summarise.mjs --write         # splice the README markers and
 *                                              # refresh results/summary.json
 *
 * Each JSON file is a Vitest --reporter=json output; the target slug is the
 * filename (e.g. "dynoxide" from "dynoxide.json"). Run date comes from the
 * Vitest run; target version from an optional sibling "<slug>.version" file;
 * an optional "<slug>.indeterminate.json" sidecar (src/indeterminate-sink.ts)
 * qualifies the run's failed observations.
 *
 * Scoring is per region: each target is scored against every observed
 * region's recorded expectations (scripts/lib/score.mjs, reading the split
 * registry), and its headline - the table's Total - is the best of them. The
 * real-DynamoDB row renders 100%, earned rather than assumed: each real region
 * scores 100% against its own recorded behaviour by construction, so the max
 * over any observed set is 100% too.
 *
 * The percentage is correctness over IMPLEMENTED, OBSERVED operations:
 * passed / (passed + failed). Two kinds of test are excluded from it, for two
 * reasons that must not be blurred: skips (honest scope - the feature probe
 * declined to run an operation the target does not implement, reported in
 * their own column) and indeterminates (failed observations - a timeout,
 * exhausted throttle or transport fault means nobody knows the answer).
 *
 * results/summary.json is ADDITIVE: the per-target results/<slug>.json files
 * are never modified or reshaped here, so the site's existing reader (and its
 * tag-manifest join on file path + top-level describe) keeps working while the
 * new per-region view is adopted on its own schedule.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  GROUND_TRUTH_SLUG,
  cohortOf,
  isPublishedTarget,
  loadScoringContext,
  passRate,
  regionLabel,
  scoreTarget,
} from './lib/score.mjs'
import { isObserved, observedRegions } from './lib/observed.mjs'

/** Version of the results/summary.json contract the site consumes. */
export const SUMMARY_SCHEMA_VERSION = 1

/** Where the versioned summary artefact lives. */
export const SUMMARY_PATH = 'results/summary.json'

// Display names for the published table. Unlisted slugs fall back to a
// hyphen-stripped form.
const DISPLAY = {
  dynamodb: 'DynamoDB',
  'dynamodb-local': 'DynamoDB Local',
  dynoxide: 'Dynoxide',
  dynalite: 'Dynalite',
  localstack: 'LocalStack',
  ministack: 'Ministack',
  floci: 'Floci',
  extenddb: 'ExtendDB',
}
const display = (slug) => DISPLAY[slug] ?? slug.replace(/-/g, ' ')

// Project home for each target, linked from its name in the table. The two AWS
// targets have no source repo, so they point at their AWS pages.
const REPO = {
  dynamodb: 'https://aws.amazon.com/dynamodb/',
  'dynamodb-local':
    'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html',
  dynoxide: 'https://github.com/nubo-db/dynoxide',
  dynalite: 'https://github.com/architect/dynalite',
  localstack: 'https://github.com/localstack/localstack',
  ministack: 'https://github.com/ministackorg/ministack',
  floci: 'https://github.com/floci-io/floci',
  extenddb: 'https://github.com/ExtendDB/extenddb',
}
export const label = (slug) =>
  REPO[slug] ? `[${display(slug)}](${REPO[slug]})` : display(slug)

// ── Reading the target namespace ─────────────────────────────────────────────

/**
 * Read target result files into { slug, raw, sidecar, version, runDate }.
 * Reserved scratch slugs (local, summary) are never published targets, and
 * badge/sidecar files are companions rather than targets, so all are skipped
 * here; a sidecar is instead paired up with the results file it qualifies.
 */
export function readTargets(files) {
  const targets = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    if (file.endsWith('.badge.json') || file.endsWith('.indeterminate.json')) continue
    const slug = basename(file, '.json')
    if (!isPublishedTarget(slug)) continue

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const sidecarFile = file.replace(/\.json$/, '.indeterminate.json')
    const sidecar = existsSync(sidecarFile)
      ? JSON.parse(readFileSync(sidecarFile, 'utf8'))
      : null
    const versionFile = file.replace(/\.json$/, '.version')
    const version =
      (existsSync(versionFile) && readFileSync(versionFile, 'utf8').trim()) || '-'
    const runDate = raw.startTime
      ? new Date(raw.startTime).toISOString().slice(0, 10)
      : '-'

    targets.push({ slug, raw, sidecar, version, runDate })
  }
  return targets
}

// ── Region standing ──────────────────────────────────────────────────────────

/**
 * Sort the tracked regions into their published standing:
 *
 * - observed: regions a score may draw on (scripts/lib/observed.mjs);
 * - unresolved: the subset of observed regions that missed the latest
 *   sweep. Still scored against - their registry rows are retained - but
 *   published as carrying forward their last resolved data, never omitted;
 * - dropped: regions excluded from scoring, either for missing two
 *   consecutive sweeps or for never having resolved at all.
 *
 * A region that is silently absent would be indistinguishable from a region
 * that agreed, so every tracked region appears in exactly one of these lists.
 */
export function regionStanding(health) {
  // observedRegions throws loudly when every region has dropped, which is
  // the behaviour the table wants too: a table scored against nothing is not
  // a table.
  const observed = observedRegions(health)
  return {
    observed,
    unresolved: observed.filter((r) => health.regions[r].consecutiveUnresolved > 0),
    dropped: Object.entries(health.regions)
      .filter(([, entry]) => !isObserved(entry))
      .map(([region]) => region)
      .sort(),
  }
}

// ── The summary artefact ─────────────────────────────────────────────────────

// Published rates are rounded to one decimal everywhere (table, badge,
// summary), so the three surfaces show one number. Raw counts are carried
// alongside for anyone recomputing at full precision.
const round1 = (rate) => (rate === null ? null : Number(rate.toFixed(1)))

/**
 * Build the versioned summary object from read targets and the scoring
 * context. Deterministic for a given input: targets and regions are sorted,
 * and nothing here stamps a "generated at" time - the run dates come from the
 * result files, so a re-run over the same inputs is byte-identical.
 */
export function buildSummary(targets, { registry, health }) {
  const standing = regionStanding(health)

  const summary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    regions: {
      ...standing,
      detail: Object.fromEntries(
        Object.keys(health.regions)
          .sort()
          .map((r) => [r, health.regions[r]]),
      ),
    },
    // Real DynamoDB's row is 100% because each real region scores 100% against
    // its own recorded behaviour by construction (self-agreement), so the max
    // over any observed set is 100%. Earned, not assumed.
    groundTruth: { slug: GROUND_TRUTH_SLUG, rate: 100, runDate: '-' },
    targets: {},
  }

  for (const t of [...targets].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (t.slug === GROUND_TRUTH_SLUG) {
      // Scores are self-agreement (above); keep the date of the last
      // successful real-AWS run so the ground-truth row isn't dateless.
      summary.groundTruth.runDate = t.runDate
      continue
    }
    const scored = scoreTarget(t.raw, t.sidecar, {
      registry,
      observed: standing.observed,
    })
    // Files in results/ that aren't a target's Vitest output (e.g.
    // tag-manifest.json) score nothing; skip them rather than emit a row.
    if (!scored) continue

    const regions = {}
    for (const region of standing.observed) {
      const r = scored.regions[region]
      regions[region] = {
        rate: round1(passRate(r.passed, r.failed)),
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
        indeterminate: r.indeterminate,
        count: r.count,
        tiers: r.summary,
      }
    }

    summary.targets[t.slug] = {
      headline: { region: scored.headline.region, rate: round1(scored.headline.rate) },
      regions,
      version: t.version,
      runDate: t.runDate,
    }
  }

  return summary
}

/** Write the summary artefact (results/summary.json). */
export function writeSummaryFile(summary, path = SUMMARY_PATH) {
  writeFileSync(path, JSON.stringify(summary, null, 2) + '\n')
}

// ── The Markdown table ───────────────────────────────────────────────────────

const pct = (rate) => (rate === null ? '-' : `${rate.toFixed(1)}%`)

/**
 * The table's rows, structured: the ground-truth row first, then targets by
 * headline rate descending (dateless "-" rates last), name breaking ties.
 * Tier and count columns show the headline region's scoring - the region the
 * target's Total was earned in, named in its Region column.
 */
export function tableRows(summary) {
  const rows = Object.entries(summary.targets).map(([slug, t]) => {
    const best = t.regions[t.headline.region]
    // Name the cohort the headline was earned in, not the lone tie-break
    // winner. Ties are read off the published per-region rates, the same
    // numbers a viewer sees, so the label matches paritysuite.org's.
    const cohort = cohortOf(
      Object.entries(t.regions).map(([region, r]) => ({ region, rate: r.rate })),
    )
    return {
      target: label(slug),
      tier1: pct(passRate(best.tiers.tier1.p, best.tiers.tier1.f)),
      tier2: pct(passRate(best.tiers.tier2.p, best.tiers.tier2.f)),
      tier3: pct(passRate(best.tiers.tier3.p, best.tiers.tier3.f)),
      total: pct(t.headline.rate),
      region: t.headline.rate === null ? '-' : regionLabel(cohort),
      passed: best.passed,
      failed: best.failed,
      skipped: best.skipped,
      count: best.count,
      version: t.version,
      runDate: t.runDate,
    }
  })

  const num = (t) => (t === '-' ? -1 : parseFloat(t))
  rows.sort((a, b) => num(b.total) - num(a.total) || a.target.localeCompare(b.target))

  // Suite size: the largest test count seen, i.e. a full-suite run.
  const suiteSize = Math.max(0, ...rows.map((r) => r.count))
  const groundTruth = {
    target: label(summary.groundTruth.slug),
    tier1: '100%',
    tier2: '100%',
    tier3: '100%',
    total: '100%',
    // Real DynamoDB is every region's own behaviour, so its row is not pinned
    // to one region the way a target's headline is.
    region: 'all regions',
    passed: suiteSize,
    failed: 0,
    skipped: 0,
    count: suiteSize,
    version: 'live (AWS)',
    runDate: summary.groundTruth.runDate,
  }

  return [groundTruth, ...rows]
}

/**
 * The caption above the table: which regions the numbers were scored against,
 * with unresolved and dropped regions named explicitly. A reader must never be
 * able to mistake an unresolved region for an agreeing one, so absence is
 * spelled out rather than implied.
 */
export function tableCaption(regions) {
  const list = (rs) => rs.map((r) => `\`${r}\``).join(', ')
  const sentences = [
    `Scored against real DynamoDB's recorded behaviour in each observed region ` +
      `(${list(regions.observed)}); a target's Total is its best-matching region, and ` +
      `the Region column names the cohort tied at that rate - all regions, the ` +
      `\`eu-west-2\` baseline plus a count, or a single region it matches that ` +
      `eu-west-2 disagrees with. Behaviour varies by region and over time, so these ` +
      `are point-in-time figures.`,
  ]
  if (regions.unresolved.length > 0) {
    sentences.push(
      `${list(regions.unresolved)} did not resolve the latest sweep and ` +
        `${regions.unresolved.length === 1 ? 'carries' : 'carry'} forward the last ` +
        `resolved data.`,
    )
  }
  if (regions.dropped.length > 0) {
    sentences.push(
      `${list(regions.dropped)} ${regions.dropped.length === 1 ? 'has' : 'have'} been ` +
        `dropped from the observed set and ` +
        `${regions.dropped.length === 1 ? 'is' : 'are'} not scored against.`,
    )
  }
  return `_${sentences.join(' ')}_`
}

/** Render the full table block: caption plus Markdown table. */
export function renderTable(summary) {
  const fmt = (r) =>
    `| ${r.target} | ${r.tier1} | ${r.tier2} | ${r.tier3} | ${r.total} | ${r.region} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.version} | ${r.runDate} |`
  const body = [
    '| Target | Tier 1 | Tier 2 | Tier 3 | Total | Region | Pass | Fail | Skip | Version | Date |',
    '|--------|--------|--------|--------|-------|--------|------|------|------|---------|------|',
    ...tableRows(summary).map(fmt),
  ].join('\n')
  return `${tableCaption(summary.regions)}\n\n${body}`
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const files = argv.filter((a) => !a.startsWith('--'))

  if (files.length === 0) {
    try {
      files.push(
        ...readdirSync('results')
          .filter((f) => f.endsWith('.json'))
          .map((f) => join('results', f)),
      )
    } catch {
      console.error('Usage: node scripts/summarise.mjs [--write] [results/*.json]')
      process.exit(1)
    }
  }

  if (files.length === 0) {
    console.error('No result files found.')
    process.exit(1)
  }

  const summary = buildSummary(readTargets(files), loadScoringContext())
  const table = renderTable(summary)

  if (write) {
    const path = 'README.md'
    const start = '<!-- results:start -->'
    const end = '<!-- results:end -->'
    const md = readFileSync(path, 'utf8')
    const s = md.indexOf(start)
    const e = md.indexOf(end)
    if (s === -1 || e === -1) {
      console.error(`Could not find ${start} / ${end} markers in ${path}`)
      process.exit(1)
    }
    const updated = `${md.slice(0, s + start.length)}\n${table}\n${md.slice(e)}`
    writeFileSync(path, updated)
    writeSummaryFile(summary)
    console.error(`Updated the results table in ${path} and wrote ${SUMMARY_PATH}.`)
  } else {
    console.log(table)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
