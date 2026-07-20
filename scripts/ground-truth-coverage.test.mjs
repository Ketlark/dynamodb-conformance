import { describe, it, expect } from 'vitest'
import {
  parseArgs,
  relativeTestPath,
  testIdentities,
  uncovered,
  widestReference,
} from './ground-truth-coverage.mjs'

// Minimal Vitest-shaped result: { '<file>': ['fullName', ...] }.
const doc = (files) => ({
  testResults: Object.entries(files).map(([name, names]) => ({
    name,
    assertionResults: names.map((fullName) => ({ fullName, status: 'passed' })),
  })),
})

const FULL = doc({
  '/runner/repo/tests/tier1/putItem/basic.test.ts': ['PutItem > writes an item'],
  '/runner/repo/tests/tier2/updateTable/gsi.test.ts': ['UpdateTable — add GSI > adds a hash-only GSI'],
  '/runner/repo/tests/tier2/kinesis/streamingDestination.test.ts': ['Kinesis > enables a destination'],
})

describe('relativeTestPath', () => {
  it('reduces a runner-absolutised path to its repo-relative form', () => {
    expect(relativeTestPath('/home/runner/work/x/y/tests/tier1/a.test.ts')).toBe(
      'tests/tier1/a.test.ts',
    )
  })

  it('leaves a path with no tests/ segment alone rather than mangling it', () => {
    expect(relativeTestPath('weird.test.ts')).toBe('weird.test.ts')
  })
})

describe('testIdentities', () => {
  it('keys on file and full name together', () => {
    expect(testIdentities(doc({ '/r/tests/tier1/a.test.ts': ['s > t'] }))).toEqual(
      new Set(['tests/tier1/a.test.ts::s > t']),
    )
  })

  it('does not conflate same-named tests living in different files', () => {
    const ids = testIdentities(
      doc({
        '/r/tests/tier1/a.test.ts': ['basic > rejects a missing key'],
        '/r/tests/tier1/b.test.ts': ['basic > rejects a missing key'],
      }),
    )
    // Two distinct identities, not one: collapsing them would let a test in b
    // be marked observed on the strength of a run that only covered a.
    expect(ids.size).toBe(2)
  })

  it('rejects a document that is not a Vitest result', () => {
    expect(() => testIdentities({ schema: 1 })).toThrow(/missing testResults/)
  })
})

describe('uncovered', () => {
  it('reports nothing when the lanes together cover the whole suite', () => {
    const gating = doc({ '/ci/tests/tier1/putItem/basic.test.ts': ['PutItem > writes an item'] })
    const gsi = doc({
      '/ci/tests/tier2/updateTable/gsi.test.ts': ['UpdateTable — add GSI > adds a hash-only GSI'],
    })
    const integrations = doc({
      '/ci/tests/tier2/kinesis/streamingDestination.test.ts': ['Kinesis > enables a destination'],
    })
    expect(uncovered(FULL, [gating, gsi, integrations])).toEqual([])
  })

  it('names the tests a missing lane leaves unobserved', () => {
    // The GSI lane did not run: its 1 test has no real-AWS observation, which
    // is exactly the silence this check exists to break.
    const gating = doc({ '/ci/tests/tier1/putItem/basic.test.ts': ['PutItem > writes an item'] })
    const integrations = doc({
      '/ci/tests/tier2/kinesis/streamingDestination.test.ts': ['Kinesis > enables a destination'],
    })
    expect(uncovered(FULL, [gating, integrations])).toEqual([
      'tests/tier2/updateTable/gsi.test.ts::UpdateTable — add GSI > adds a hash-only GSI',
    ])
  })

  it('counts a failed test as observed: a red answer is still an answer', () => {
    const observedButRed = {
      testResults: [
        {
          name: '/ci/tests/tier1/putItem/basic.test.ts',
          assertionResults: [{ fullName: 'PutItem > writes an item', status: 'failed' }],
        },
      ],
    }
    const reference = doc({
      '/r/tests/tier1/putItem/basic.test.ts': ['PutItem > writes an item'],
    })
    expect(uncovered(reference, [observedButRed])).toEqual([])
  })

  it('matches across checkouts, where absolute paths differ', () => {
    const reference = doc({ '/home/runner/work/a/b/tests/tier1/a.test.ts': ['s > t'] })
    const groundTruth = doc({ '/Users/dev/Projects/repo/tests/tier1/a.test.ts': ['s > t'] })
    expect(uncovered(reference, [groundTruth])).toEqual([])
  })

  it('reports the whole suite when no ground truth is supplied at all', () => {
    expect(uncovered(FULL, [])).toHaveLength(3)
  })
})

describe('parseArgs', () => {
  it('collects repeated references separately from the ground-truth files', () => {
    expect(parseArgs(['--reference', 'a.json', '--reference', 'b.json', 'gt.json'])).toEqual({
      references: ['a.json', 'b.json'],
      files: ['gt.json'],
    })
  })
})

describe('widestReference', () => {
  it('picks the largest, matching the published denominator', () => {
    const small = doc({ '/r/tests/tier1/a.test.ts': ['s > one'] })
    const large = doc({ '/r/tests/tier1/a.test.ts': ['s > one', 's > two'] })
    expect(testIdentities(widestReference([small, large])).size).toBe(2)
  })

  it('a truncated emulator run cannot shrink the reference and mask a gap', () => {
    // dynalite dying after one test must not make the check pass by comparing
    // the ground truth against a one-test suite.
    const truncated = doc({ '/r/tests/tier1/a.test.ts': ['s > one'] })
    const gaps = uncovered(widestReference([truncated, FULL]), [])
    expect(gaps).toHaveLength(3)
  })
})
