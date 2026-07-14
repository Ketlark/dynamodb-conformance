import { describe, expect, it } from 'vitest'
import {
  MAX_DISAGREEING_FILES,
  MAX_DISAGREEING_TESTS,
  MAX_INDETERMINATE_SHARE,
  assessRegion,
} from './health.mjs'

// Build classified verdicts the way scripts/lib/classify.mjs emits them. The
// full suite runs ~860 tests across ~110 files; fixtures use a scaled-down
// region of 200 passing tests so share-based thresholds have room to move.
function verdicts({ passes = 200, fails = [], indeterminate = 0, runLevel = false } = {}) {
  const out = []
  for (let i = 0; i < passes; i++) {
    out.push({ file: `tests/tier1/f${i % 40}.test.ts`, fullName: `p${i}`, verdict: 'pass' })
  }
  for (const [file, count] of fails) {
    for (let i = 0; i < count; i++) {
      out.push({ file, fullName: `${file} f${i}`, verdict: 'fail' })
    }
  }
  for (let i = 0; i < indeterminate; i++) {
    out.push({
      file: `tests/tier2/slow${i}.test.ts`,
      fullName: `i${i}`,
      verdict: 'indeterminate',
      reason: { reason: 'gsi-consistency-timeout', at: runLevel ? 'run' : 'test' },
    })
  }
  return out
}

describe('assessRegion', () => {
  it('resolves a clean region', () => {
    const health = assessRegion(verdicts())
    expect(health.resolved).toBe(true)
    expect(health.reasons).toEqual([])
    expect(health.counts).toMatchObject({ tests: 200, passed: 200, failed: 0 })
  })

  it('resolves a region with one clean disagreement: the split signal survives the gate', () => {
    const health = assessRegion(verdicts({ fails: [['tests/tier3/error-messages/putItem.test.ts', 1]] }))
    expect(health.resolved).toBe(true)
    expect(health.counts.failed).toBe(1)
  })

  it('a run-level provisioning indeterminate is unresolved immediately, whatever else the run recorded', () => {
    const health = assessRegion(verdicts({ passes: 3, indeterminate: 1, runLevel: true }))
    expect(health.resolved).toBe(false)
    expect(health.reasons).toEqual([
      expect.objectContaining({ kind: 'run-level-indeterminate' }),
    ])
  })

  it('widespread failures across unrelated files mark the region unresolved', () => {
    const health = assessRegion(
      verdicts({
        fails: [
          ['tests/tier1/putItem/a.test.ts', 10],
          ['tests/tier1/query/b.test.ts', 10],
          ['tests/tier2/transactions/c.test.ts', 10],
          ['tests/tier3/limits/d.test.ts', 10],
        ],
      }),
    )
    expect(health.resolved).toBe(false)
    expect(health.reasons.map((r) => r.kind)).toEqual(['widespread-failures'])
  })

  // The boundary, asserted explicitly at the chosen thresholds so a later
  // change to them is a visible decision rather than an accident.
  it(`resolves at exactly ${MAX_DISAGREEING_TESTS} failures in ${MAX_DISAGREEING_FILES} files, and not one test or file more`, () => {
    const atCeiling = verdicts({
      fails: [
        ['tests/tier3/a.test.ts', 5],
        ['tests/tier3/b.test.ts', 5],
        ['tests/tier3/c.test.ts', 5],
      ],
    })
    expect(assessRegion(atCeiling).resolved).toBe(true)

    const oneTestOver = verdicts({
      fails: [
        ['tests/tier3/a.test.ts', 6],
        ['tests/tier3/b.test.ts', 5],
        ['tests/tier3/c.test.ts', 5],
      ],
    })
    expect(assessRegion(oneTestOver).resolved).toBe(false)

    const oneFileOver = verdicts({
      fails: [
        ['tests/tier3/a.test.ts', 1],
        ['tests/tier3/b.test.ts', 1],
        ['tests/tier3/c.test.ts', 1],
        ['tests/tier3/d.test.ts', 1],
      ],
    })
    expect(assessRegion(oneFileOver).resolved).toBe(false)
    expect(assessRegion(oneFileOver).reasons.map((r) => r.kind)).toEqual([
      'widespread-failures',
    ])
  })

  it(`resolves at exactly ${MAX_INDETERMINATE_SHARE * 100}% test-level indeterminacy, and not one test more`, () => {
    // 200 passes: 6/206 ≈ 2.9% resolves; 7/207 ≈ 3.4% does not.
    expect(assessRegion(verdicts({ indeterminate: 6 })).resolved).toBe(true)
    const over = assessRegion(verdicts({ indeterminate: 7 }))
    expect(over.resolved).toBe(false)
    expect(over.reasons.map((r) => r.kind)).toEqual(['widespread-indeterminacy'])
  })

  it('a run that recorded no tests at all is unresolved, not an empty success', () => {
    const health = assessRegion([])
    expect(health.resolved).toBe(false)
    expect(health.reasons.map((r) => r.kind)).toEqual(['no-results'])
  })

  it('skips are honest scope and never count against a region', () => {
    const skips = Array.from({ length: 50 }, (_, i) => ({
      file: `tests/tier2/s${i}.test.ts`,
      fullName: `s${i}`,
      verdict: 'skip',
    }))
    const health = assessRegion([...verdicts(), ...skips])
    expect(health.resolved).toBe(true)
    expect(health.counts.skipped).toBe(50)
  })

  it('rejects malformed input loudly', () => {
    expect(() => assessRegion(null)).toThrow(/expected an array/)
    expect(() =>
      assessRegion([{ file: 'x', fullName: 'y', verdict: 'wobbly' }]),
    ).toThrow(/unrecognised verdict/)
  })
})

// A failure on a test with an admitted split-registry row is a recorded
// regional difference, not sickness. The predicate is injected by the caller
// (scripts/sweep-detect.mjs builds it from the registry), so these tests
// drive it directly.
describe('assessRegion with admitted splits (isExplained)', () => {
  const explainedBelow = (dir) => (v) => v.file.startsWith(dir)

  it('a region whose only definite failures are admitted splits resolves, with the failures visible in counts', () => {
    const health = assessRegion(
      verdicts({
        fails: [
          ['tests/tier3/admitted/a.test.ts', 1],
          ['tests/tier3/admitted/b.test.ts', 1],
          ['tests/tier3/admitted/c.test.ts', 1],
          ['tests/tier3/admitted/d.test.ts', 1],
        ],
      }),
      { isExplained: explainedBelow('tests/tier3/admitted/') },
    )
    expect(health.resolved).toBe(true)
    expect(health.counts).toMatchObject({ failed: 4, explainedFailed: 4, failingFiles: 4 })
  })

  it('three admitted failures plus one novel failure resolves, and the novel one stays visible', () => {
    // The shape ap-southeast-2 produced on 2026-07-14: three June-rollout
    // splits plus the Sydney-only nesting-depth failure.
    const health = assessRegion(
      verdicts({
        fails: [
          ['tests/tier3/admitted/a.test.ts', 1],
          ['tests/tier3/admitted/b.test.ts', 1],
          ['tests/tier3/admitted/c.test.ts', 1],
          ['tests/tier3/limits/nestingDepth.test.ts', 1],
        ],
      }),
      { isExplained: explainedBelow('tests/tier3/admitted/') },
    )
    expect(health.resolved).toBe(true)
    expect(health.counts).toMatchObject({ failed: 4, explainedFailed: 3 })
  })

  it('unexplained failures alone still trip both ceilings: exactly 3 unexplained files plus admitted extras resolves, a 4th tips it', () => {
    const admitted = [
      ['tests/tier3/admitted/a.test.ts', 1],
      ['tests/tier3/admitted/b.test.ts', 1],
    ]
    const threeNovelFiles = [
      ['tests/tier3/x.test.ts', 1],
      ['tests/tier3/y.test.ts', 1],
      ['tests/tier3/z.test.ts', 1],
    ]
    const opts = { isExplained: explainedBelow('tests/tier3/admitted/') }
    expect(
      assessRegion(verdicts({ fails: [...admitted, ...threeNovelFiles] }), opts).resolved,
    ).toBe(true)
    const fourNovelFiles = [...threeNovelFiles, ['tests/tier3/w.test.ts', 1]]
    const over = assessRegion(verdicts({ fails: [...admitted, ...fourNovelFiles] }), opts)
    expect(over.resolved).toBe(false)
    expect(over.reasons.map((r) => r.kind)).toEqual(['widespread-failures'])
  })

  it('the unexplained test ceiling holds independently of file clustering', () => {
    const oneExplained = { isExplained: (v) => v.fullName === 'tests/tier3/a.test.ts f0' }
    // 16 failures in 2 files, one explained: 15 unexplained sits at the ceiling.
    expect(
      assessRegion(
        verdicts({ fails: [['tests/tier3/a.test.ts', 8], ['tests/tier3/b.test.ts', 8]] }),
        oneExplained,
      ).resolved,
    ).toBe(true)
    // 17 failures, one explained: 16 unexplained tips it.
    expect(
      assessRegion(
        verdicts({ fails: [['tests/tier3/a.test.ts', 9], ['tests/tier3/b.test.ts', 8]] }),
        oneExplained,
      ).resolved,
    ).toBe(false)
  })

  it('the widespread-failures detail names both the unexplained and the explained counts', () => {
    const health = assessRegion(
      verdicts({
        fails: [
          ['tests/tier3/admitted/a.test.ts', 1],
          ['tests/tier3/w.test.ts', 1],
          ['tests/tier3/x.test.ts', 1],
          ['tests/tier3/y.test.ts', 1],
          ['tests/tier3/z.test.ts', 1],
        ],
      }),
      { isExplained: explainedBelow('tests/tier3/admitted/') },
    )
    expect(health.resolved).toBe(false)
    expect(health.reasons[0].detail).toMatch(/4 unexplained definite failures across 4 files/)
    expect(health.reasons[0].detail).toMatch(/1 further failure\(s\) match admitted splits/)
  })

  it('explained-ness never applies to indeterminate verdicts: absence stays absence', () => {
    const health = assessRegion(verdicts({ indeterminate: 7 }), { isExplained: () => true })
    expect(health.resolved).toBe(false)
    expect(health.reasons.map((r) => r.kind)).toEqual(['widespread-indeterminacy'])
  })
})
