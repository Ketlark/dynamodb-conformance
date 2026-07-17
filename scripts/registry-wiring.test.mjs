import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadRegistry } from './lib/registry.mjs'
import { PROVISIONAL_ACCEPTED_DETAIL } from '../src/observation-sink.js'

// Per-region scoring joins three hand-maintained artefacts on prose
// identity: a registry row names its test by (file, fullName), the wired
// test records the target's answer via src/observation-sink.ts, and an
// accepted answer is credited only when the detail string the test stamps
// byte-matches the row's. None of those joins fails loudly on its own - a
// renamed test, an unwired row, or a reworded detail just degrades scoring
// back to the conservative fail-everywhere path with nothing going red,
// which is exactly how 2.0.0 shipped with the evidence half missing. These
// assertions are what make that drift loud.

const registry = loadRegistry()

// Titles as they appear in source: the first string literal argument of a
// describe()/it() call. The split tests use plain single-quoted titles; a
// row whose test moves to a template literal or computed title will fail the
// fullName join below, which is the correct moment for a human to strengthen
// this extraction.
const titleLiterals = (source, kind) =>
  [...source.matchAll(new RegExp(`\\b${kind}\\(\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map(
    (m) => m[1].replaceAll("\\'", "'"),
  )

describe('every registry row resolves to a wired split test', () => {
  it('no two rows share a test file, which keeps per-file assertions exact', () => {
    // The checks below are file-scoped. With two rows in one file, one wired
    // test could satisfy both rows' checks; if the registry legitimately
    // grows a second row in an existing file, scope the assertions to the
    // named test's block instead of deleting this guard.
    const files = registry.splits.map((row) => row.test.file)
    expect(new Set(files).size).toBe(files.length)
  })

  for (const row of registry.splits) {
    describe(row.id, () => {
      const source = existsSync(row.test.file) ? readFileSync(row.test.file, 'utf8') : null
      const acceptedDetails = Object.values(row.regions)
        .filter((observation) => observation.outcome === 'accepted')
        .map((observation) => observation.detail)

      it('names a test file that exists', () => {
        expect(source, `${row.test.file} does not exist`).not.toBeNull()
      })

      it('joins on a fullName composed of a real describe/it pair in that file', () => {
        // Scoring and drift detection join rows to results on fullName
        // (describe title + space + it title). A renamed title silently
        // un-joins the row - every target then scores the conservative
        // fail-everywhere path - so the composition is asserted here.
        const titles = titleLiterals(source, 'it')
        const title = titles.find((t) => row.test.fullName.endsWith(` ${t}`))
        expect(title, `no it() title in ${row.test.file} ends ${row.test.fullName}`)
          .toBeDefined()
        const prefix = row.test.fullName.slice(0, -(title.length + 1))
        expect(titleLiterals(source, 'describe')).toContain(prefix)
      })

      it('is named by its test, which records an observation', () => {
        // Convention: a split test carries its registry row id in a comment,
        // and captures the target's answer. A row admitted without wiring
        // the test would score as fail-everywhere for every target.
        expect(source).toContain(row.id)
        expect(source).toMatch(/observeSplit|recordObserved/)
      })

      it('has every accepted detail it records present verbatim in the test', () => {
        // An accepted answer is stamped from a literal in the test, so a
        // reworded registry detail silently stops matching unless the test
        // moves in lockstep. Rejected answers are captured verbatim from the
        // target at run time and need no literal.
        for (const detail of acceptedDetails) {
          expect(source, `detail "${detail}" not found in ${row.test.file}`).toContain(detail)
        }
      })

      it('never records the provisional accepted detail as a real answer', () => {
        // The provisional detail exists to match nothing; a row recording it
        // would let an unverified acceptance claim a region match.
        expect(acceptedDetails).not.toContain(PROVISIONAL_ACCEPTED_DETAIL)
      })
    })
  }
})
