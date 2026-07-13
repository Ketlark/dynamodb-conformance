import { describe, it, expect } from 'vitest'
import {
  GROUND_TRUTH_SLUG,
  isPublishedTarget,
  loadScoringContext,
  passRate,
  scoreAcrossRegions,
  scoreAgainstRegion,
  scoreResults,
  scoreTarget,
  scoreVerdicts,
  tierOf,
  verdictsForRegion,
} from './score.mjs'

// Build a minimal Vitest-shaped result: one test file per named tier directory,
// each carrying the given passed/failed/skipped assertion counts.
function result(tiers) {
  const fill = (status, n) => Array.from({ length: n }, () => ({ status }))
  const testResults = Object.entries(tiers).map(([tier, { p = 0, f = 0, s = 0 }]) => ({
    name: `/repo/tests/${tier}/x.test.ts`,
    assertionResults: [...fill('passed', p), ...fill('failed', f), ...fill('skipped', s)],
  }))
  return { testResults }
}

describe('tierOf', () => {
  it('maps tier directories and falls back to other', () => {
    expect(tierOf('/repo/tests/tier1/a.test.ts')).toBe('tier1')
    expect(tierOf('/repo/tests/tier2/a.test.ts')).toBe('tier2')
    expect(tierOf('/repo/tests/tier3/a.test.ts')).toBe('tier3')
    expect(tierOf('/repo/tests/misc/a.test.ts')).toBe('other')
  })
})

describe('scoreResults', () => {
  it('returns null for a file that is not a Vitest result', () => {
    expect(scoreResults({ schema: 1, describes: {} })).toBeNull()
    expect(scoreResults({})).toBeNull()
    expect(scoreResults(null)).toBeNull()
  })

  it('sums passed/failed/skipped across the three tiers', () => {
    const scored = scoreResults(
      result({ tier1: { p: 3 }, tier2: { p: 2, f: 1 }, tier3: { p: 1, s: 4 } }),
    )
    expect(scored).toMatchObject({ passed: 6, failed: 1, skipped: 4, count: 11 })
  })

  it('excludes the "other" tier from the counts', () => {
    const scored = scoreResults(result({ tier1: { p: 2 }, other: { p: 5, f: 5 } }))
    expect(scored).toMatchObject({ passed: 2, failed: 0, skipped: 0, count: 2 })
  })

  it('returns zeroed counts (not null) for a real result with no scored tests', () => {
    expect(scoreResults({ testResults: [] })).toMatchObject({
      passed: 0,
      failed: 0,
      skipped: 0,
      count: 0,
    })
  })

  it('classifies a failed test carrying meta.indeterminate out of both sides of the rate', () => {
    // AE2: a failed observation counts neither for nor against a target, so
    // the rate is unchanged by a region (or a run) having a bad day.
    const raw = {
      testResults: [
        {
          name: '/repo/tests/tier1/x.test.ts',
          assertionResults: [
            { title: 'a', fullName: 'a', status: 'passed', meta: {} },
            {
              title: 'b',
              fullName: 'b',
              status: 'failed',
              meta: { indeterminate: { reason: 'gsi-consistency-timeout', at: 'test' } },
            },
          ],
        },
      ],
    }
    const scored = scoreResults(raw)
    expect(scored).toMatchObject({ passed: 1, failed: 0, skipped: 0, indeterminate: 1, count: 2 })
    expect(passRate(scored.passed, scored.failed)).toBe(100)
  })

  it('a run-level sidecar makes the whole run indeterminate, not failed', () => {
    const raw = {
      testResults: [
        {
          name: '/repo/tests/tier1/x.test.ts',
          assertionResults: [{ title: 'a', fullName: 'a', status: 'passed', meta: {} }],
        },
      ],
    }
    const sidecar = { runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning' }] }
    const scored = scoreResults(raw, sidecar)
    expect(scored).toMatchObject({ passed: 0, failed: 0, indeterminate: 1 })
    expect(passRate(scored.passed, scored.failed)).toBeNull()
  })
})

describe('scoreVerdicts', () => {
  it('buckets the four verdicts per tier and counts them all', () => {
    const v = (tier, verdict) => ({ file: `/repo/tests/${tier}/x.test.ts`, verdict })
    const scored = scoreVerdicts([
      v('tier1', 'pass'),
      v('tier1', 'indeterminate'),
      v('tier2', 'fail'),
      v('tier3', 'skip'),
      v('misc', 'pass'), // outside the tiers, not counted
    ])
    expect(scored.summary.tier1).toEqual({ p: 1, f: 0, s: 0, i: 1 })
    expect(scored).toMatchObject({ passed: 1, failed: 1, skipped: 1, indeterminate: 1, count: 4 })
  })
})

describe('per-region scoring', () => {
  const accepted = { outcome: 'accepted', detail: 'stored and normalised' }
  const rejected = {
    outcome: 'rejected',
    error: { name: 'ValidationException', message: 'must have the value of true' },
  }
  // One admitted split: the committed test asserts the accepting side
  // (pinned eu-west-2), eu-central-1 agrees with it, us-east-1 rejects.
  const registry = {
    splits: [
      {
        id: 'example-split',
        test: { file: 'tests/tier3/split.test.ts', fullName: 'suite splits' },
        pinned: 'eu-west-2',
        regions: { 'eu-west-2': accepted, 'eu-central-1': accepted, 'us-east-1': rejected },
      },
    ],
  }
  const REGIONS = ['eu-west-2', 'eu-central-1', 'us-east-1']

  // A suite of verdicts: `others` region-invariant passes, plus the split test.
  const suite = (splitVerdict) => [
    { file: '/repo/tests/tier1/a.test.ts', fullName: 'a', verdict: 'pass' },
    { file: '/repo/tests/tier2/b.test.ts', fullName: 'b', verdict: 'pass' },
    { file: '/repo/tests/tier3/split.test.ts', fullName: 'suite splits', ...splitVerdict },
  ]
  const rateIn = (scored) => passRate(scored.passed, scored.failed)

  it('an engine matching every region scores 100% everywhere and 100% headline', () => {
    const verdicts = suite({ verdict: 'pass' })
    const { regions, headline } = scoreAcrossRegions(verdicts, { splits: [] }, REGIONS)
    for (const region of REGIONS) expect(rateIn(regions[region])).toBe(100)
    expect(headline.rate).toBe(100)
  })

  it('takes the best observed region as the headline (AE3)', () => {
    // The engine matches us-east-1 on every behaviour: it fails the committed
    // (eu-west-2-pinned) assertion, and its recorded observation is exactly
    // what us-east-1 returns.
    const verdicts = suite({ verdict: 'fail', observed: rejected })
    const { regions, headline } = scoreAcrossRegions(verdicts, registry, REGIONS)
    expect(rateIn(regions['us-east-1'])).toBe(100)
    expect(rateIn(regions['eu-west-2'])).toBeCloseTo((2 / 3) * 100, 5)
    expect(headline).toEqual({ region: 'us-east-1', rate: 100 })
  })

  it('an engine doing something no region does fails everywhere, and the failure survives the headline (AE4)', () => {
    // Accepts { NULL: false } but returns it unchanged on read: not what any
    // region records, so no observed region can rescue it.
    const frankenstein = { outcome: 'accepted', detail: 'stored without normalising' }
    const verdicts = suite({ verdict: 'fail', observed: frankenstein })
    const { regions, headline } = scoreAcrossRegions(verdicts, registry, REGIONS)
    for (const region of REGIONS) {
      expect(regions[region].failed).toBe(1)
    }
    expect(headline.rate).toBeCloseTo((2 / 3) * 100, 5)
  })

  it('a pass without an observation is a match with the pinned answer, and only that answer', () => {
    // Passing the committed assertion proves the target does what eu-west-2
    // does; the row says eu-central-1 records the same answer and us-east-1
    // does not.
    const verdicts = suite({ verdict: 'pass' })
    const byRegion = (region) =>
      verdictsForRegion(verdicts, registry, region).at(-1).verdict
    expect(byRegion('eu-west-2')).toBe('pass')
    expect(byRegion('eu-central-1')).toBe('pass')
    expect(byRegion('us-east-1')).toBe('fail')
  })

  it('a fail without an observation stays a fail in every region: a match is only awarded on evidence', () => {
    const verdicts = suite({ verdict: 'fail' })
    for (const region of REGIONS) {
      expect(verdictsForRegion(verdicts, registry, region).at(-1).verdict).toBe('fail')
    }
  })

  it('indeterminate and skip pass through untouched: an absence is the same absence in every region (AE2)', () => {
    for (const verdict of ['indeterminate', 'skip']) {
      const verdicts = suite({ verdict })
      for (const region of REGIONS) {
        const scored = scoreAgainstRegion(verdicts, registry, region)
        expect(rateIn(scored)).toBe(100)
        expect(scored.count).toBe(3)
      }
    }
  })

  it('a region the row does not name keeps the region-invariant expectation', () => {
    const verdicts = suite({ verdict: 'pass' })
    expect(verdictsForRegion(verdicts, registry, 'sa-east-1').at(-1).verdict).toBe('pass')
  })

  it('a target with no split-relevant tests scores identically in every region', () => {
    // The common path is a no-op: nothing here matches the registry row, so
    // per-region re-evaluation changes no verdict.
    const verdicts = [
      { file: '/repo/tests/tier1/a.test.ts', fullName: 'a', verdict: 'pass' },
      { file: '/repo/tests/tier2/b.test.ts', fullName: 'b', verdict: 'fail' },
    ]
    const { regions } = scoreAcrossRegions(verdicts, registry, REGIONS)
    for (const region of REGIONS) {
      expect(regions[region]).toEqual(regions['eu-west-2'])
    }
  })

  it('scoring against an empty observed set is an error, not a silent 0% or 100%', () => {
    expect(() => scoreAcrossRegions(suite({ verdict: 'pass' }), registry, [])).toThrow(
      /empty observed region set/,
    )
    expect(() => scoreAcrossRegions(suite({ verdict: 'pass' }), registry)).toThrow(
      /empty observed region set/,
    )
  })

  it('breaks headline ties by region name, so a re-run is byte-identical', () => {
    const verdicts = suite({ verdict: 'pass' })
    const { headline } = scoreAcrossRegions(verdicts, { splits: [] }, [
      'us-east-1',
      'eu-west-2',
      'eu-central-1',
    ])
    expect(headline.region).toBe('eu-central-1')
  })
})

describe('scoreTarget', () => {
  const context = { registry: { splits: [] }, observed: ['eu-west-2'] }

  it('returns null for a document that is not a Vitest result', () => {
    expect(scoreTarget({ schema: 1 }, null, context)).toBeNull()
    expect(scoreTarget(null, null, context)).toBeNull()
  })

  it('classifies with the sidecar before scoring across regions', () => {
    const raw = result({ tier1: { p: 5 } })
    const sidecar = { runLevel: [{ reason: 'table-active-timeout' }] }
    const clean = scoreTarget(raw, null, context)
    expect(clean.headline.rate).toBe(100)
    const doomed = scoreTarget(raw, sidecar, context)
    expect(doomed.headline.rate).toBeNull()
    expect(doomed.regions['eu-west-2'].indeterminate).toBe(5)
  })
})

describe('loadScoringContext', () => {
  it('loads the committed registry and region health into one context', () => {
    const { registry, health, observed } = loadScoringContext()
    expect(registry.splits.length).toBeGreaterThan(0)
    expect(health.regions['eu-west-2']).toBeDefined()
    expect(observed).toContain('eu-west-2')
  })
})

describe('passRate', () => {
  it('is passed / (passed + failed) as a percentage', () => {
    expect(passRate(99, 1)).toBeCloseTo(99, 5)
    expect(passRate(2, 1)).toBeCloseTo(66.6667, 3)
  })

  it('returns null when nothing ran', () => {
    expect(passRate(0, 0)).toBeNull()
  })
})

describe('GROUND_TRUTH_SLUG', () => {
  it('is dynamodb', () => {
    expect(GROUND_TRUTH_SLUG).toBe('dynamodb')
  })
})

describe('isPublishedTarget', () => {
  it('excludes the reserved local scratch slug', () => {
    expect(isPublishedTarget('local')).toBe(false)
  })

  it('excludes the summary artefact: pipeline output, not a target', () => {
    expect(isPublishedTarget('summary')).toBe(false)
  })

  it('keeps real targets, matching the slug exactly rather than by prefix', () => {
    // dynamodb-local contains "local" but is a real target; an exact-match
    // reservation must not catch it.
    expect(isPublishedTarget('dynamodb-local')).toBe(true)
    expect(isPublishedTarget('dynoxide')).toBe(true)
    expect(isPublishedTarget(GROUND_TRUTH_SLUG)).toBe(true)
  })
})
