import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBadge, colour, rateFor } from './badges.mjs'
import { loadScoringContext } from './lib/score.mjs'

const RESULTS_DIR = 'results'

// A split-free scoring context: with no registry rows, per-region scoring is
// the identity, so one region is enough for the plain-percentage tests.
const CONTEXT = { registry: { splits: [] }, observed: ['eu-west-2'] }

// Minimal Vitest-shaped result with the given tier 1 passed/failed counts.
function result(passed, failed) {
  const fill = (status, n) => Array.from({ length: n }, () => ({ status }))
  return {
    testResults: [
      {
        name: '/repo/tests/tier1/x.test.ts',
        assertionResults: [...fill('passed', passed), ...fill('failed', failed)],
      },
    ],
  }
}

describe('colour', () => {
  it.each([
    [100, 'brightgreen'],
    [99, 'brightgreen'],
    [98.9, 'green'],
    [95, 'green'],
    [94.9, 'yellowgreen'],
    [90, 'yellowgreen'],
    [89.9, 'yellow'],
    [75, 'yellow'],
    [74.9, 'orange'],
    [50, 'orange'],
    [49.9, 'red'],
    [0, 'red'],
  ])('%s%% -> %s', (pct, expected) => {
    expect(colour(pct)).toBe(expected)
  })
})

describe('rateFor', () => {
  it('pins the ground-truth target to 100', () => {
    expect(rateFor('dynamodb', {}, CONTEXT)).toBe(100)
  })

  it('returns null for a non-result file', () => {
    expect(rateFor('tag-manifest', { schema: 1 }, CONTEXT)).toBeNull()
  })

  it('returns null for the reserved scratch and summary slugs', () => {
    // Real, well-formed run output - excluded by slug, not by structure.
    expect(rateFor('local', result(5, 0), CONTEXT)).toBeNull()
    expect(rateFor('summary', result(5, 0), CONTEXT)).toBeNull()
  })

  it('scores a real target as passed / (passed + failed)', () => {
    expect(rateFor('dynoxide', result(2, 1), CONTEXT)).toBeCloseTo(66.6667, 3)
  })

  it('takes the headline: the best observed region, not the pinned one', () => {
    // The committed assertion encodes us-east-1's answer for the one split
    // test, so a target passing it scores 100% against us-east-1 and lower
    // against eu-west-2; the badge shows the best of them.
    const context = {
      registry: {
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
      },
      observed: ['eu-west-2', 'us-east-1'],
    }
    const raw = {
      testResults: [
        { name: '/repo/tests/tier1/a.test.ts', assertionResults: [{ status: 'passed' }] },
        {
          name: '/repo/tests/tier3/split.test.ts',
          assertionResults: [{ fullName: 'suite splits', status: 'passed' }],
        },
      ],
    }
    expect(rateFor('dynoxide', raw, context)).toBe(100)
  })

  it('excludes a failed observation from both sides of the rate', () => {
    const raw = result(3, 0)
    raw.testResults[0].assertionResults.push({
      status: 'failed',
      meta: { indeterminate: { reason: 'gsi-consistency-timeout', at: 'test' } },
    })
    expect(rateFor('dynoxide', raw, CONTEXT)).toBe(100)
  })

  it('a run-level sidecar empties the rate rather than failing the target', () => {
    const sidecar = { runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning' }] }
    expect(rateFor('dynoxide', result(5, 0), { ...CONTEXT, sidecar })).toBeNull()
  })
})

describe('buildBadge', () => {
  it('returns null when there is nothing to show', () => {
    expect(buildBadge('tag-manifest', { schema: 1 }, CONTEXT)).toBeNull()
  })

  it('returns null for the reserved local scratch slug', () => {
    expect(buildBadge('local', result(5, 0), CONTEXT)).toBeNull()
  })

  it('emits the shields endpoint shape for the ground truth', () => {
    expect(buildBadge('dynamodb', {}, CONTEXT)).toEqual({
      schemaVersion: 1,
      label: 'conformance',
      message: '100.0%',
      color: 'brightgreen',
    })
  })

  it('colours off the displayed value, not the raw rate', () => {
    // 197/199 = 98.99%, which displays as "99.0%" and must colour brightgreen
    // to match the number shown rather than the sub-99 raw rate.
    const badge = buildBadge('dynoxide', result(197, 2), CONTEXT)
    expect(badge.message).toBe('99.0%')
    expect(badge.color).toBe('brightgreen')
  })
})

describe('committed badges are fresh', () => {
  // The same committed inputs the CLI writer uses: the split registry and the
  // observed region set, plus each run's indeterminate sidecar if present.
  const context = loadScoringContext()
  const resultFiles = readdirSync(RESULTS_DIR).filter(
    (f) =>
      f.endsWith('.json') && !f.endsWith('.badge.json') && !f.endsWith('.indeterminate.json'),
  )

  it.each(resultFiles)('%s matches a fresh build', (file) => {
    const slug = file.replace(/\.json$/, '')
    const raw = JSON.parse(readFileSync(join(RESULTS_DIR, file), 'utf8'))
    const sidecarPath = join(RESULTS_DIR, `${slug}.indeterminate.json`)
    const sidecar = existsSync(sidecarPath)
      ? JSON.parse(readFileSync(sidecarPath, 'utf8'))
      : null
    const expected = buildBadge(slug, raw, { ...context, sidecar })
    const badgePath = join(RESULTS_DIR, `${slug}.badge.json`)

    if (expected === null) {
      expect(existsSync(badgePath), `${slug} should not have a badge`).toBe(false)
      return
    }

    expect(
      existsSync(badgePath),
      `${slug}.badge.json missing — run \`npm run results:badges\``,
    ).toBe(true)
    const committed = JSON.parse(readFileSync(badgePath, 'utf8'))
    expect(committed, `${slug}.badge.json is stale — run \`npm run results:badges\``).toEqual(
      expected,
    )
  })
})
