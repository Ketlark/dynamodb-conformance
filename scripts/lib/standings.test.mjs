import { describe, it, expect } from 'vitest'
import { configurationsOf, earnsOwnRow, splitVariants } from './standings.mjs'

// A build of a project earns a nested row by scoring differently from the
// build above it. These cases are the whole rule, so they are written out
// rather than derived: the interesting ones are the near-misses, where two
// builds agree on everything a reader can see and the temptation is to publish
// the second row anyway.

const row = (over = {}) => ({
  slug: 'extenddb-sqlite',
  grade: 'B',
  divergence: '2.0%',
  coverage: '87.8%',
  divergenceValue: 2.0,
  coverageValue: 87.8,
  count: 1054,
  ...over,
})

const parentRow = (over = {}) => row({ slug: 'extenddb', ...over })

describe('whether a build earns its own row', () => {
  it('collapses a build that matches its parent on every published axis', () => {
    expect(earnsOwnRow(row(), parentRow())).toBe(false)
  })

  it('gives a row to a build that lands a different letter', () => {
    // Dynoxide's wasm build today: same divergence as the native one, but the
    // coverage it cannot reach drops it a grade.
    const parent = parentRow({ grade: 'A', coverage: '94.7%', coverageValue: 94.7 })
    const variant = row({ grade: 'B', coverage: '83.4%', coverageValue: 83.4 })
    expect(earnsOwnRow(variant, parent)).toBe(true)
  })

  it('gives a row to a build that differs on coverage alone', () => {
    // Grade bands are coarse enough that two builds can share a letter while
    // covering visibly different amounts of the suite.
    expect(earnsOwnRow(row({ coverage: '80.1%' }), parentRow())).toBe(true)
  })

  it('gives a row to a build whose figures match over a different suite size', () => {
    // Divergence and coverage are both ratios. Equal percentages over
    // different denominators are not the same result, and merging them under
    // one set of figures would report work that was never done.
    expect(earnsOwnRow(row({ count: 900 }), parentRow({ count: 1054 }))).toBe(true)
  })

  it('collapses a build differing only below display precision', () => {
    // Comparing raw values here would let a row appear and vanish between runs
    // over a difference no reader can see on the board.
    const variant = row({ divergenceValue: 2.0449 })
    const parent = parentRow({ divergenceValue: 2.0 })
    expect(earnsOwnRow(variant, parent)).toBe(false)
  })

  it('gives a row to a build with nothing above it to compare against', () => {
    // The grouping promotes a build to parent when the reference build has no
    // result. It then stands for the project and must render.
    expect(earnsOwnRow(row(), null)).toBe(true)
    expect(earnsOwnRow(row(), undefined)).toBe(true)
  })

  it('gives a row to a build compared against itself', () => {
    // Same object in both positions means the grouping picked it as its own
    // parent; it renders rather than collapsing into nothing.
    const only = row()
    expect(earnsOwnRow(only, only)).toBe(true)
  })
})

describe('splitting a parent’s builds', () => {
  it('separates the builds that differ from the ones that match', () => {
    const parent = parentRow()
    const matching = row({ slug: 'extenddb-sqlite' })
    const differing = row({ slug: 'extenddb-mongodb', grade: 'C', coverage: '70.0%' })
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

describe('naming the configurations on a collapsed row', () => {
  it('puts the reference configuration first', () => {
    // The parent row carries the reference build's figures, so the reference
    // is what the numbers describe and it leads the list.
    const parent = parentRow()
    const collapsed = [row({ slug: 'extenddb-sqlite' })]
    expect(configurationsOf(parent, collapsed)).toEqual(['PostgreSQL', 'SQLite'])
  })

  it('names only the parent when nothing collapsed into it', () => {
    expect(configurationsOf(parentRow(), [])).toEqual(['PostgreSQL'])
  })

  it('says nothing for a project that declares no configurations', () => {
    // A single-shape project has no configuration to name, and the board
    // should not invent one for it.
    expect(configurationsOf(row({ slug: 'dynalite' }), [])).toEqual([])
  })
})
