import { describe, it, expect } from 'vitest'
import { configurationsOf, earnsOwnRow, listOf, splitVariants } from './standings.mjs'

// A build of a project earns a nested row unless every figure it would publish
// matches the row above it. These cases are the whole rule, so they are written
// out rather than derived: the interesting ones are the near-misses, where two
// builds agree on the headline and disagree on a column beside it.
//
// The fixtures carry the fields a real row carries. An earlier version of this
// file invented a `grade` field to compare against, which no site row has - so
// the test passed against a shape the site never produces.

const row = (over = {}) => ({
  slug: 'extenddb-sqlite',
  version: 'v0.1.3',
  runDate: '2026-08-14',
  passed: 904,
  failed: 21,
  skipped: 129,
  count: 1054,
  cohort: '27 of 32',
  tier1: '0.8%',
  tier2: '2.7%',
  tier3: '3.2%',
  ...over,
})

const parentRow = (over = {}) => row({ slug: 'extenddb', ...over })

describe('whether a build earns its own row', () => {
  it('folds a build that matches its parent on every published figure', () => {
    expect(earnsOwnRow(row(), parentRow())).toBe(false)
  })

  it('gives a row to a build with one more failure that rounds to the same percentage', () => {
    // 21 and 22 failures over 1054 both print 2.0%. Comparing the printed
    // figure folded them and published the parent's fail count for both, so a
    // reader was told 21 about a build that failed 22.
    const variant = row({ failed: 22, passed: 903 })
    expect(earnsOwnRow(variant, parentRow())).toBe(true)
  })

  it('gives a row to a build whose failures fall in different tiers', () => {
    // Same totals, same headline percentages, different shape. The row would
    // otherwise publish the parent's tier breakdown as though it were both.
    const variant = row({ tier1: '0.0%', tier2: '3.5%' })
    expect(earnsOwnRow(variant, parentRow())).toBe(true)
  })

  it('gives a row to a build measured from a different release', () => {
    // The row publishes one version. Folding a build built from another would
    // restate its version as the parent's.
    expect(earnsOwnRow(row({ version: 'v0.1.2' }), parentRow())).toBe(true)
  })

  it('gives a row to a build measured on a different day', () => {
    // Two builds measured weeks apart were never shown to agree; they were
    // never run against the same suite on the same day.
    expect(earnsOwnRow(row({ runDate: '2026-07-20' }), parentRow())).toBe(true)
  })

  it('gives a row to a build that skipped a different amount', () => {
    expect(earnsOwnRow(row({ skipped: 130, passed: 903 }), parentRow())).toBe(true)
  })

  it('gives a row to a build measured across a different region cohort', () => {
    expect(earnsOwnRow(row({ cohort: '4 of 32' }), parentRow())).toBe(true)
  })

  it('gives a row to a build with nothing above it to compare against', () => {
    // The grouping promotes a build to parent when the reference build has no
    // result. It then stands for the project and must render.
    expect(earnsOwnRow(row(), null)).toBe(true)
    expect(earnsOwnRow(row(), undefined)).toBe(true)
  })

  it('gives a row to a build compared against itself', () => {
    const only = row()
    expect(earnsOwnRow(only, only)).toBe(true)
  })
})

describe('the rule reaching the same answer on either surface', () => {
  // The published table's rows carry a `grade` and per-tier percentage strings.
  // The site's carry neither: it computes the letter at render time and holds
  // tiers as objects. Comparing counts rather than rendered fields is what lets
  // one rule serve both, so this checks the site's shape explicitly.
  const siteRow = (over = {}) => ({
    slug: 'extenddb-sqlite',
    version: 'v0.1.3',
    runDate: '2026-08-14',
    passed: 904,
    failed: 21,
    skipped: 129,
    count: 1054,
    divergenceValue: 2.0,
    coverageValue: 87.8,
    tiers: {
      tier1: { divergence: '0.8%', coverage: '100.0%' },
      tier2: { divergence: '2.7%', coverage: '80.0%' },
      tier3: { divergence: '3.2%', coverage: '90.0%' },
    },
    ...over,
  })

  it('folds identical site-shaped rows despite them carrying no grade', () => {
    expect(earnsOwnRow(siteRow(), siteRow({ slug: 'extenddb' }))).toBe(false)
  })

  it('separates site-shaped rows that differ only inside a tier', () => {
    const variant = siteRow({
      tiers: {
        tier1: { divergence: '0.0%', coverage: '100.0%' },
        tier2: { divergence: '3.5%', coverage: '80.0%' },
        tier3: { divergence: '3.2%', coverage: '90.0%' },
      },
    })
    expect(earnsOwnRow(variant, siteRow({ slug: 'extenddb' }))).toBe(true)
  })
})

describe('splitting a parent’s builds', () => {
  it('separates the builds that differ from the ones that match', () => {
    const parent = parentRow()
    const matching = row({ slug: 'extenddb-sqlite' })
    const differing = row({ slug: 'extenddb-mongodb', failed: 40, passed: 885 })
    parent.variants = [matching, differing]

    const { shown, collapsed } = splitVariants(parent)
    expect(shown.map((v) => v.slug)).toEqual(['extenddb-mongodb'])
    expect(collapsed.map((v) => v.slug)).toEqual(['extenddb-sqlite'])
  })

  it('handles a parent carrying no builds at all', () => {
    const { shown, collapsed } = splitVariants(parentRow())
    expect(shown).toEqual([])
    expect(collapsed).toEqual([])
  })
})

describe('naming the configurations on a folded row', () => {
  it('puts the reference configuration first', () => {
    const parent = parentRow()
    const collapsed = [row({ slug: 'extenddb-sqlite' })]
    expect(configurationsOf(parent, collapsed)).toEqual(['PostgreSQL', 'SQLite'])
  })

  it('names only the parent when nothing folded into it', () => {
    expect(configurationsOf(parentRow(), [])).toEqual(['PostgreSQL'])
  })

  it('says nothing for a project that declares no configurations', () => {
    expect(configurationsOf(row({ slug: 'dynalite' }), [])).toEqual([])
  })
})

describe('joining those names into a phrase', () => {
  it('uses a comma before the last once there are three', () => {
    // The multi-name branch was unreachable from any test while every fixture
    // had at most two configurations, and ExtendDB's MongoDB build is named in
    // the registry as the next one due to land.
    expect(listOf(['PostgreSQL', 'SQLite', 'MongoDB'])).toBe('PostgreSQL, SQLite and MongoDB')
  })

  it('joins two with "and", and leaves one alone', () => {
    expect(listOf(['PostgreSQL', 'SQLite'])).toBe('PostgreSQL and SQLite')
    expect(listOf(['PostgreSQL'])).toBe('PostgreSQL')
    expect(listOf([])).toBe('')
  })
})
