import { describe, it, expect } from 'vitest'
import { figuresDiffer } from './standings.mjs'
import { gradeOf } from './grade.mjs'

// ── The rule as a starting-state hint ────────────────────────────────────────
//
// What it decides now is whether a build's figures start visible, not whether
// they are published at all. So it compares the three figures a reader is
// actually comparing, and derives the grade from the two values behind it
// rather than reading a `grade` field - the published table sets one and the
// site does not, which is how the first version of this rule came to compare
// undefined against undefined on half the surfaces it served.

describe('whether two builds print different figures', () => {
  const printed = (over = {}) => ({
    slug: 'extenddb-sqlite',
    divergence: '2.0%',
    coverage: '87.8%',
    divergenceValue: 2.0,
    coverageValue: 87.8,
    ...over,
  })

  it('says no when the grade, divergence and coverage all read the same', () => {
    expect(figuresDiffer(printed(), printed({ slug: 'extenddb' }))).toBe(false)
  })

  it('says yes when the divergence differs', () => {
    const variant = printed({ divergence: '4.8%', divergenceValue: 4.8 })
    expect(figuresDiffer(variant, printed({ slug: 'extenddb' }))).toBe(true)
  })

  it('says yes when the coverage differs', () => {
    const variant = printed({ coverage: '83.4%', coverageValue: 83.4 })
    expect(figuresDiffer(variant, printed({ slug: 'extenddb' }))).toBe(true)
  })

  it('says yes when only the grade differs', () => {
    // Two rows can print the same rounded percentages either side of a band
    // boundary. The letter is what a reader compares first, so it counts.
    const a = printed({ divergenceValue: 4.9, coverageValue: 100 })
    const b = printed({ slug: 'extenddb', divergenceValue: 5.1, coverageValue: 100 })
    expect(figuresDiffer(a, b)).toBe(true)
  })

  it('works on a row carrying no grade field, which is every site row', () => {
    // The defect that started all of this: the site computes its letter at
    // render time, so a rule reading `row.grade` compared undefined there.
    const site = printed()
    const parent = printed({ slug: 'extenddb' })
    expect('grade' in site).toBe(false)
    expect(figuresDiffer(site, parent)).toBe(false)
  })

  it('says yes when there is nothing to compare against', () => {
    // A build promoted to stand for its project, or a row compared with
    // itself. Both start open, which shows everything.
    const only = printed()
    expect(figuresDiffer(only, null)).toBe(true)
    expect(figuresDiffer(only, undefined)).toBe(true)
    expect(figuresDiffer(only, only)).toBe(true)
  })

  it('treats two unscored rows as differing, not as agreeing', () => {
    // A run that recorded an indeterminate publishes neither figure, so the
    // row prints "-" for both. Two of those match cell for cell while nobody
    // knows what either target would have answered. The row is re-tested and
    // not carried, so the carried guard in sortRows does not reach it.
    const unscored = (slug) => ({ slug, divergence: '-', coverage: '-', divergenceValue: null, coverageValue: null })
    expect(figuresDiffer(unscored('extenddb-sqlite'), unscored('extenddb'))).toBe(true)
  })

  it('treats a row with no figures at all as differing', () => {
    // A target the suite refused to score prints "-" for both. Two of those
    // are not evidence of agreement, and starting open costs nothing.
    const unscored = { slug: 'x', divergence: '-', coverage: '-' }
    expect(figuresDiffer(unscored, printed({ slug: 'extenddb' }))).toBe(true)
  })
})

// ── The property, rather than one more example ───────────────────────────────
//
// Six figures were missed in turn by the rule this replaces, each found after
// the last was fixed, because the rule listed what to compare and the board
// kept growing columns. This asserts the shape instead: whenever the predicate
// says two builds read the same, the three cells each surface prints for them
// really are the same - including the letter, which the published table stamps
// onto the row and the site derives at render time.
//
// It is cheap now rather than load-bearing. A figure the predicate ignores
// costs a reader a click, not a false statement about someone else's engine.

describe('the figures it compares are the figures both surfaces print', () => {
  const pct = (v) => (v == null ? '-' : `${v.toFixed(1)}%`)

  // A row as each surface holds it. The published table stamps a `grade` field
  // (summarise.mjs); a site row carries none and its letter is computed where
  // it is drawn. Same two values underneath, two different routes to a letter.
  const published = (divergenceValue, coverageValue) => ({
    grade: gradeOf(divergenceValue, coverageValue).letter ?? '-',
    divergence: pct(divergenceValue),
    coverage: pct(coverageValue),
    divergenceValue,
    coverageValue,
  })
  const onSite = (divergenceValue, coverageValue) => ({
    divergence: pct(divergenceValue),
    coverage: pct(coverageValue),
    divergenceValue,
    coverageValue,
  })

  // Dense around the band boundaries, where a letter can change under figures
  // that print the same, and out across the range the board actually holds.
  const AXIS = [0, 0.04, 0.06, 0.9, 4.9, 4.94, 4.96, 5.1, 11.8, 12.8, 14.8, 20.9, 24.96, 25.1, 40]
  const COVERAGE = [100, 99.96, 96, 94.7, 87.8, 80.04, 79.96, 78.7, 50]

  const rows = []
  for (const d of AXIS) for (const c of COVERAGE) rows.push([d, c])

  it('gives two builds the same cells on both surfaces whenever it calls them equal', () => {
    let sameCount = 0
    for (const [d1, c1] of rows) {
      for (const [d2, c2] of rows) {
        if (figuresDiffer(published(d1, c1), published(d2, c2))) continue
        sameCount++
        const a = published(d1, c1)
        const b = published(d2, c2)
        // The published table's own letter, which the predicate never reads.
        expect([a.grade, a.divergence, a.coverage]).toEqual([b.grade, b.divergence, b.coverage])
        // And the site's, computed from the values at render time.
        const sa = onSite(d1, c1)
        const sb = onSite(d2, c2)
        expect(gradeOf(sa.divergenceValue, sa.coverageValue).letter).toEqual(
          gradeOf(sb.divergenceValue, sb.coverageValue).letter,
        )
        expect([sa.divergence, sa.coverage]).toEqual([sb.divergence, sb.coverage])
      }
    }
    // A grid that never calls anything equal would pass the loop above without
    // asserting a thing.
    expect(sameCount).toBeGreaterThan(rows.length)
  })

  it('reaches the same answer whichever surface holds the row', () => {
    // The two surfaces build rows differently, and the predicate serves both.
    // If it ever read a field only one of them carries, this is where it shows.
    for (const [d1, c1] of rows) {
      for (const [d2, c2] of rows) {
        expect(figuresDiffer(onSite(d1, c1), onSite(d2, c2))).toBe(
          figuresDiffer(published(d1, c1), published(d2, c2)),
        )
      }
    }
  })
})
