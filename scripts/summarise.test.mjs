import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBadge } from './badges.mjs'
import { GROUND_TRUTH_SLUG, loadScoringContext, scoreTarget } from './lib/score.mjs'
import {
  SUMMARY_PATH,
  SUMMARY_SCHEMA_VERSION,
  buildSummary,
  label,
  readTargets,
  regionStanding,
  renderTable,
  tableCaption,
  tableRows,
  writeSummaryFile,
} from './summarise.mjs'

const DAY = '2026-07-06'
const health = (regions) => ({ regions })
const entry = (consecutiveUnresolved, lastResolved = DAY) => ({
  lastResolved,
  consecutiveUnresolved,
})

// Two healthy regions, one admitted split between them. The committed
// assertion encodes us-east-1's answer (pinned), so a target passing it
// matches us-east-1 and not eu-west-2.
const HEALTHY = health({ 'eu-west-2': entry(0), 'us-east-1': entry(0) })
const REGISTRY = {
  splits: [
    {
      id: 'example-split',
      test: { file: 'tests/tier3/split.test.ts', fullName: 'suite splits' },
      pinned: 'us-east-1',
      regions: {
        'us-east-1': { outcome: 'accepted' },
        'eu-west-2': { outcome: 'rejected' },
      },
    },
  ],
}

// Minimal Vitest-shaped result: { '<file>': [['fullName', 'status'], ...] }.
function rawDoc(files, startTime = Date.UTC(2026, 6, 6)) {
  return {
    startTime,
    testResults: Object.entries(files).map(([name, assertions]) => ({
      name,
      assertionResults: assertions.map(([fullName, status]) => ({
        title: fullName,
        fullName,
        status,
        meta: {},
      })),
    })),
  }
}

const target = (slug, raw, overrides = {}) => ({
  slug,
  raw,
  sidecar: null,
  version: '1.0.0',
  runDate: DAY,
  ...overrides,
})

// Two region-invariant passes plus the split test with the given status.
const suiteDoc = (splitStatus) =>
  rawDoc({
    '/repo/tests/tier1/a.test.ts': [
      ['a', 'passed'],
      ['b', 'passed'],
    ],
    '/repo/tests/tier3/split.test.ts': [['suite splits', splitStatus]],
  })

describe('regionStanding', () => {
  it('keeps healthy regions observed with nothing unresolved or dropped', () => {
    expect(regionStanding(HEALTHY)).toEqual({
      observed: ['eu-west-2', 'us-east-1'],
      unresolved: [],
      dropped: [],
    })
  })

  it('a region that missed one sweep stays observed but is named unresolved', () => {
    const standing = regionStanding(health({ 'eu-west-2': entry(0), 'us-east-1': entry(1) }))
    expect(standing.observed).toEqual(['eu-west-2', 'us-east-1'])
    expect(standing.unresolved).toEqual(['us-east-1'])
    expect(standing.dropped).toEqual([])
  })

  it('two consecutive misses drop a region out of the observed set', () => {
    const standing = regionStanding(health({ 'eu-west-2': entry(0), 'us-east-1': entry(2) }))
    expect(standing.observed).toEqual(['eu-west-2'])
    expect(standing.dropped).toEqual(['us-east-1'])
  })

  it('a region that has never resolved is not observed', () => {
    const standing = regionStanding(
      health({ 'eu-west-2': entry(0), 'ap-southeast-2': entry(0, null) }),
    )
    expect(standing.observed).toEqual(['eu-west-2'])
    expect(standing.dropped).toEqual(['ap-southeast-2'])
  })

  it('every region dropping at once is loud, not a silently empty set', () => {
    expect(() => regionStanding(health({ 'eu-west-2': entry(2) }))).toThrow(
      /no observed regions/,
    )
  })
})

describe('buildSummary', () => {
  it('scores each target in every observed region and headlines the max (per-region columns)', () => {
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: HEALTHY,
    })
    const t = summary.targets.alpha

    // One entry per observed region, and the headline is their max - here
    // us-east-1, whose recorded answer the passing committed assertion encodes.
    expect(Object.keys(t.regions)).toEqual(['eu-west-2', 'us-east-1'])
    expect(t.regions['us-east-1'].rate).toBe(100)
    expect(t.regions['eu-west-2'].rate).toBe(66.7)
    expect(t.headline).toEqual({ region: 'us-east-1', rate: 100 })
    expect(summary.schemaVersion).toBe(SUMMARY_SCHEMA_VERSION)
  })

  it('carries the ground-truth run date and pins its rate at 100 (self-agreement)', () => {
    const summary = buildSummary(
      [target(GROUND_TRUTH_SLUG, suiteDoc('passed')), target('alpha', suiteDoc('passed'))],
      { registry: REGISTRY, health: HEALTHY },
    )
    expect(summary.groundTruth).toEqual({ slug: GROUND_TRUTH_SLUG, rate: 100, runDate: DAY })
    // The ground truth is never listed as a target of itself.
    expect(Object.keys(summary.targets)).toEqual(['alpha'])
  })

  it('an unresolved region appears explicitly and is still scored against (AE6)', () => {
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: health({ 'eu-west-2': entry(0), 'us-east-1': entry(1) }),
    })
    expect(summary.regions.unresolved).toEqual(['us-east-1'])
    // Its registry rows are retained: the target's headline still draws on it.
    expect(summary.targets.alpha.headline.region).toBe('us-east-1')
    expect(renderTable(summary)).toContain('`us-east-1` did not resolve the latest sweep')
  })

  it('a dropped region is excluded from the headline max and labelled dropped (AE5)', () => {
    const summary = buildSummary([target('alpha', suiteDoc('passed'))], {
      registry: REGISTRY,
      health: health({ 'eu-west-2': entry(0), 'us-east-1': entry(2) }),
    })
    expect(summary.regions.dropped).toEqual(['us-east-1'])
    // us-east-1 would give this target 100%, but a dropped region cannot
    // contribute: the headline falls back to the best remaining region.
    expect(summary.targets.alpha.headline).toEqual({ region: 'eu-west-2', rate: 66.7 })
    expect(summary.targets.alpha.regions['us-east-1']).toBeUndefined()
    expect(renderTable(summary)).toContain(
      '`us-east-1` has been dropped from the observed set',
    )
  })

  it('a run-level indeterminate empties the rate rather than failing the target', () => {
    const sidecar = { runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning' }] }
    const summary = buildSummary([target('alpha', suiteDoc('failed'), { sidecar })], {
      registry: REGISTRY,
      health: HEALTHY,
    })
    const t = summary.targets.alpha
    expect(t.headline.rate).toBeNull()
    expect(t.regions['eu-west-2']).toMatchObject({ rate: null, indeterminate: 3, failed: 0 })
  })

  it('skips files that are not a target run (e.g. the tag manifest)', () => {
    const summary = buildSummary(
      [target('tag-manifest', { schema: 1, describes: {} }), target('alpha', suiteDoc('passed'))],
      { registry: REGISTRY, health: HEALTHY },
    )
    expect(Object.keys(summary.targets)).toEqual(['alpha'])
  })
})

describe('tableRows / renderTable', () => {
  const docs = {
    [GROUND_TRUTH_SLUG]: suiteDoc('passed'),
    alpha: suiteDoc('passed'),
    beta: suiteDoc('failed'),
    empty: rawDoc({ '/repo/tests/tier1/a.test.ts': [] }),
  }
  const summary = buildSummary(
    Object.entries(docs).map(([slug, doc]) => target(slug, doc)),
    { registry: REGISTRY, health: HEALTHY },
  )
  const rows = tableRows(summary)

  it('renders the ground-truth row first, at an earned 100% across all regions', () => {
    // 100% by self-agreement: each real region scores 100% against its own
    // recorded behaviour, so the max over any observed set is 100%.
    expect(rows[0]).toMatchObject({
      target: label(GROUND_TRUTH_SLUG),
      total: '100%',
      region: 'all regions',
      failed: 0,
      passed: 3, // the suite size: the largest count seen in a full run
    })
  })

  it('sorts targets by headline rate, dateless "-" rates last', () => {
    expect(rows.map((r) => r.target)).toEqual([
      label(GROUND_TRUTH_SLUG),
      'alpha',
      'beta',
      'empty',
    ])
    expect(rows.at(-1)).toMatchObject({ total: '-', region: '-' })
  })

  it('names the matched cohort, not the alphabetical tie-break winner', () => {
    // alpha matches us-east-1 alone (it beats the eu-west-2 baseline), so its
    // cohort is a single named region.
    const alpha = rows.find((r) => r.target === 'alpha')
    expect(alpha).toMatchObject({ total: '100.0%', region: 'us-east-1', passed: 3, failed: 0 })
    // beta fails the split test everywhere (a fail without an observation is
    // evidence of nothing beyond "not the pinned answer"), so it ties across
    // every region and reads "all regions" rather than crowning eu-west-2.
    const beta = rows.find((r) => r.target === 'beta')
    expect(beta).toMatchObject({ total: '66.7%', region: 'all regions', passed: 2, failed: 1 })
  })

  it('names the observed regions in the caption', () => {
    expect(tableCaption(summary.regions)).toContain('`eu-west-2`, `us-east-1`')
  })

  it('badge and table cannot disagree: every total equals the badge percentage', () => {
    // Both surfaces are rendered from the one shared headline (scoreTarget),
    // so the invariant is structural; this pins it against a future caller
    // reintroducing its own scoring.
    const context = { registry: REGISTRY, observed: summary.regions.observed }
    for (const slug of Object.keys(summary.targets)) {
      const badge = buildBadge(slug, docs[slug], context)
      const row = rows.find((r) => r.target === label(slug))
      expect(row.total).toBe(badge === null ? '-' : badge.message)
    }
  })
})

// ── The committed artefacts: freshness, no-drift, and the shape contract ────

describe('committed results pipeline', () => {
  const context = loadScoringContext()
  const files = readdirSync('results')
    .filter((f) => f.endsWith('.json'))
    .map((f) => join('results', f))
  const targets = readTargets(files)
  const fresh = buildSummary(targets, context)

  it('results/summary.json matches a fresh build (and a re-run is deterministic)', () => {
    const committed = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'))
    expect(committed, `${SUMMARY_PATH} is stale — run \`node scripts/summarise.mjs --write\``).toEqual(
      fresh,
    )
  })

  it('badge %% equals the summary headline for every target (the no-drift invariant)', () => {
    for (const [slug, t] of Object.entries(fresh.targets)) {
      const badge = JSON.parse(readFileSync(join('results', `${slug}.badge.json`), 'utf8'))
      const expected = t.headline.rate === null ? null : `${t.headline.rate.toFixed(1)}%`
      expect(badge.message, `${slug} badge disagrees with the summary headline`).toBe(expected)
    }
    // And the table's Total column is rendered from the same headline.
    const rows = tableRows(fresh)
    for (const [slug, t] of Object.entries(fresh.targets)) {
      const row = rows.find((r) => r.target === label(slug))
      expect(row.total).toBe(t.headline.rate === null ? '-' : `${t.headline.rate.toFixed(1)}%`)
    }
  })

  it('the ground truth earns its 100%: the real run scores 100% against its own region', () => {
    // Not an assumption: results/dynamodb.json is a real eu-west-2 run, and
    // scored against eu-west-2's recorded expectations it passes everything.
    // Self-agreement is what pins the row, so assert it from the data.
    const dynamodb = targets.find((t) => t.slug === GROUND_TRUTH_SLUG)
    const scored = scoreTarget(dynamodb.raw, dynamodb.sidecar, context)
    const own = scored.regions['eu-west-2']
    expect(own.failed).toBe(0)
    expect(own.passed).toBeGreaterThan(0)
  })

  it('leaves every results/*.json byte-identical: summary.json is additive', () => {
    // The per-target files are a de facto public contract (the site reads
    // them, and joins results/tag-manifest.json on file path + top-level
    // describe). The whole pipeline - read, score, render, write the summary -
    // must never rewrite them, or the site's current reader and its tag lens
    // would break silently.
    const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
    const before = Object.fromEntries(files.map((f) => [f, hash(f)]))

    const summary = buildSummary(readTargets(files), context)
    renderTable(summary)
    writeSummaryFile(summary, join(mkdtempSync(join(tmpdir(), 'summarise-')), 'summary.json'))

    for (const f of files) {
      expect(hash(f), `${f} was modified by the results pipeline`).toBe(before[f])
    }
  })
})

describe('readTargets', () => {
  it('pairs sidecars and versions, and skips reserved and companion files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'targets-'))
    const doc = suiteDoc('passed')
    writeFileSync(join(dir, 'alpha.json'), JSON.stringify(doc))
    writeFileSync(join(dir, 'alpha.version'), '9.9.9\n')
    writeFileSync(
      join(dir, 'alpha.indeterminate.json'),
      JSON.stringify({ target: 'alpha', runLevel: [{ reason: 'table-active-timeout' }] }),
    )
    writeFileSync(join(dir, 'alpha.badge.json'), JSON.stringify({ schemaVersion: 1 }))
    writeFileSync(join(dir, 'local.json'), JSON.stringify(doc))
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ schemaVersion: 1 }))

    const targets = readTargets(readdirSync(dir).map((f) => join(dir, f)))
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      slug: 'alpha',
      version: '9.9.9',
      runDate: '2026-07-06',
      sidecar: { runLevel: [{ reason: 'table-active-timeout' }] },
    })
  })
})
