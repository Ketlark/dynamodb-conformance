import { describe, expect, it } from 'vitest'
import {
  COMMERCIAL_REGIONS,
  DEFAULT_CEILINGS,
  REGION_CEILING_OVERRIDES,
  ceilingsFor,
} from './regions.js'

describe('ceilingsFor', () => {
  it('gives a region with no override the default ceilings', () => {
    expect(ceilingsFor('eu-west-2')).toEqual(DEFAULT_CEILINGS)
  })

  it('defaults are unchanged from the values the suite has always used', () => {
    // Nothing about the eu-west-2 run may change: these are the constants that
    // were previously hardcoded in src/helpers.ts and src/infra.ts.
    expect(DEFAULT_CEILINGS).toEqual({
      tableActiveMs: 120_000,
      crossRegionActiveMs: 60_000,
      gsiConsistencyMs: 10_000,
    })
  })

  it('applies a per-region override on top of the default', () => {
    const overrides = { 'ap-southeast-7': { tableActiveMs: 300_000 } }
    expect(ceilingsFor('ap-southeast-7', overrides)).toEqual({
      ...DEFAULT_CEILINGS,
      tableActiveMs: 300_000,
    })
    // Regions without an entry in the same table still get the default.
    expect(ceilingsFor('eu-west-2', overrides)).toEqual(DEFAULT_CEILINGS)
  })

  it('falls back to the default for an unknown region rather than throwing', () => {
    // A newly-launched AWS region must not break a run.
    expect(ceilingsFor('xx-nowhere-9')).toEqual(DEFAULT_CEILINGS)
    expect(ceilingsFor(undefined)).toEqual(DEFAULT_CEILINGS)
  })

  it('ships with an empty override table: numbers come from observation, not guesses', () => {
    expect(Object.keys(REGION_CEILING_OVERRIDES)).toHaveLength(0)
  })
})

describe('COMMERCIAL_REGIONS', () => {
  it('is a non-empty set of well-formed commercial region names', () => {
    expect(COMMERCIAL_REGIONS.length).toBeGreaterThan(0)
    for (const region of COMMERCIAL_REGIONS) {
      expect(region).toMatch(/^[a-z]{2}(-[a-z]+)+-\d+$/)
    }
    expect(COMMERCIAL_REGIONS).toContain('eu-west-2')
    expect(COMMERCIAL_REGIONS).toContain('us-east-1')
  })

  it('contains no duplicates', () => {
    expect(new Set(COMMERCIAL_REGIONS).size).toBe(COMMERCIAL_REGIONS.length)
  })
})
