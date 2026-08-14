import { describe, it, expect } from 'vitest'
import { figuresDiffer } from './standings.mjs'

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

  it('treats a row with no figures at all as differing', () => {
    // A target the suite refused to score prints "-" for both. Two of those
    // are not evidence of agreement, and starting open costs nothing.
    const unscored = { slug: 'x', divergence: '-', coverage: '-' }
    expect(figuresDiffer(unscored, printed({ slug: 'extenddb' }))).toBe(true)
  })
})
