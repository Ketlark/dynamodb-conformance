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

describe('every registry row resolves to a wired split test', () => {
  for (const row of registry.splits) {
    describe(row.id, () => {
      const source = existsSync(row.test.file) ? readFileSync(row.test.file, 'utf8') : null

      it('names a test file that exists', () => {
        expect(source, `${row.test.file} does not exist`).not.toBeNull()
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
        for (const observation of Object.values(row.regions)) {
          if (observation.outcome !== 'accepted') continue
          expect(source, `detail "${observation.detail}" not found in ${row.test.file}`)
            .toContain(observation.detail)
        }
      })

      it('never records the provisional accepted detail as a real answer', () => {
        // The provisional detail exists to match nothing; a row recording it
        // would let an unverified acceptance claim a region match.
        for (const observation of Object.values(row.regions)) {
          if (observation.outcome !== 'accepted') continue
          expect(observation.detail).not.toBe(PROVISIONAL_ACCEPTED_DETAIL)
        }
      })
    })
  }
})
