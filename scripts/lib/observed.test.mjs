import { describe, expect, it } from 'vitest'
import {
  DROP_AFTER,
  isObserved,
  loadRegionHealth,
  recordSweep,
  observedRegions,
  validateRegionHealth,
} from './observed.mjs'

const healthy = (date = '2026-07-06') => ({ lastResolved: date, consecutiveUnresolved: 0 })

function doc(regions) {
  return {
    regions: {
      'eu-west-2': healthy(),
      'us-east-1': healthy(),
      ...regions,
    },
  }
}

describe('validateRegionHealth', () => {
  it('accepts a valid document, including a never-resolved region', () => {
    const d = doc({ 'sa-east-1': { lastResolved: null, consecutiveUnresolved: 1 } })
    expect(validateRegionHealth(d)).toBe(d)
  })

  it('rejects malformed documents loudly', () => {
    expect(() => validateRegionHealth({})).toThrow(/expected \{ regions/)
    expect(() => validateRegionHealth({ regions: [] })).toThrow(/expected \{ regions/)
    expect(() =>
      validateRegionHealth({ regions: { 'not a region': healthy() } }),
    ).toThrow(/malformed region name/)
    expect(() =>
      validateRegionHealth({
        regions: { 'eu-west-2': { lastResolved: 'last Tuesday', consecutiveUnresolved: 0 } },
      }),
    ).toThrow(/YYYY-MM-DD/)
    expect(() =>
      validateRegionHealth({
        regions: { 'eu-west-2': { lastResolved: null, consecutiveUnresolved: -1 } },
      }),
    ).toThrow(/non-negative integer/)
  })
})

describe('observedRegions', () => {
  it('keeps every region observed when all of them resolve', () => {
    expect(observedRegions(doc())).toEqual(['eu-west-2', 'us-east-1'])
  })

  it('keeps a region observed after a single unresolved sweep (AE6)', () => {
    const d = doc({ 'us-east-1': { lastResolved: '2026-06-29', consecutiveUnresolved: 1 } })
    expect(observedRegions(d)).toContain('us-east-1')
  })

  it('excludes a region at the drop threshold: no score draws on data more than two sweeps old', () => {
    const d = doc({
      'us-east-1': { lastResolved: '2026-06-22', consecutiveUnresolved: DROP_AFTER },
    })
    expect(observedRegions(d)).toEqual(['eu-west-2'])
  })

  it('never trusts a region that has yet to produce a complete result set', () => {
    const d = doc({ 'sa-east-1': { lastResolved: null, consecutiveUnresolved: 0 } })
    expect(observedRegions(d)).toEqual(['eu-west-2', 'us-east-1'])
    expect(isObserved({ lastResolved: null, consecutiveUnresolved: 0 })).toBe(false)
  })

  it('every region dropping at once is loud, not a silently empty set', () => {
    const d = {
      regions: {
        'eu-west-2': { lastResolved: '2026-06-22', consecutiveUnresolved: 2 },
        'us-east-1': { lastResolved: '2026-06-22', consecutiveUnresolved: 3 },
      },
    }
    expect(() => observedRegions(d)).toThrow(/no observed regions/)
    expect(() => observedRegions({ regions: {} })).toThrow(/no observed regions/)
  })
})

describe('recordSweep', () => {
  it('a resolved sweep stamps the date and resets the counter', () => {
    const d = doc({ 'us-east-1': { lastResolved: '2026-06-29', consecutiveUnresolved: 1 } })
    const out = recordSweep(d, { region: 'us-east-1', resolved: true, date: '2026-07-06' })
    expect(out.doc.regions['us-east-1']).toEqual({
      lastResolved: '2026-07-06',
      consecutiveUnresolved: 0,
    })
    expect(out).toMatchObject({ observed: true, dropped: false, page: false })
  })

  it('one miss leaves the region observed and its record otherwise unchanged (AE6)', () => {
    const out = recordSweep(doc(), { region: 'us-east-1', resolved: false })
    expect(out.doc.regions['us-east-1']).toEqual({
      lastResolved: '2026-07-06',
      consecutiveUnresolved: 1,
    })
    expect(out).toMatchObject({ observed: true, dropped: false, page: false })
    expect(observedRegions(out.doc)).toContain('us-east-1')
  })

  it('the second consecutive miss drops and pages in the same return value (AE5)', () => {
    const first = recordSweep(doc(), { region: 'us-east-1', resolved: false })
    const second = recordSweep(first.doc, { region: 'us-east-1', resolved: false })
    expect(second).toMatchObject({ observed: false, dropped: true, page: true })
    expect(observedRegions(second.doc)).toEqual(['eu-west-2'])
  })

  it('misses must be consecutive: a resolved sweep in between resets the count', () => {
    const miss = recordSweep(doc(), { region: 'us-east-1', resolved: false })
    const recover = recordSweep(miss.doc, {
      region: 'us-east-1',
      resolved: true,
      date: '2026-07-13',
    })
    const missAgain = recordSweep(recover.doc, { region: 'us-east-1', resolved: false })
    expect(missAgain.doc.regions['us-east-1'].consecutiveUnresolved).toBe(1)
    expect(missAgain).toMatchObject({ observed: true, dropped: false, page: false })
  })

  it('a dropped region rejoins the observed set on its next successful sweep', () => {
    const d = doc({
      'us-east-1': { lastResolved: '2026-06-22', consecutiveUnresolved: DROP_AFTER },
    })
    const out = recordSweep(d, { region: 'us-east-1', resolved: true, date: '2026-07-13' })
    expect(out).toMatchObject({ observed: true, dropped: false, page: false })
    expect(observedRegions(out.doc)).toContain('us-east-1')
  })

  it('a region already dropped does not re-page on every later miss', () => {
    const d = doc({
      'us-east-1': { lastResolved: '2026-06-22', consecutiveUnresolved: DROP_AFTER },
    })
    const out = recordSweep(d, { region: 'us-east-1', resolved: false })
    expect(out).toMatchObject({ observed: false, dropped: true, page: false })
  })

  it('tracks a region first seen by the sweep, counting it only once it resolves', () => {
    const miss = recordSweep(doc(), { region: 'ap-southeast-2', resolved: false })
    expect(miss.doc.regions['ap-southeast-2']).toEqual({
      lastResolved: null,
      consecutiveUnresolved: 1,
    })
    expect(miss.observed).toBe(false)

    const resolve = recordSweep(doc(), {
      region: 'ap-southeast-2',
      resolved: true,
      date: '2026-07-13',
    })
    expect(resolve.observed).toBe(true)
    expect(observedRegions(resolve.doc)).toContain('ap-southeast-2')
  })

  it('is pure: the input document is never mutated', () => {
    const d = doc()
    const snapshot = JSON.parse(JSON.stringify(d))
    recordSweep(d, { region: 'us-east-1', resolved: false })
    recordSweep(d, { region: 'eu-west-2', resolved: true, date: '2026-07-13' })
    expect(d).toEqual(snapshot)
  })

  it('rejects malformed input loudly', () => {
    expect(() => recordSweep(doc(), { region: 'nowhere', resolved: false })).toThrow(
      /malformed region name/,
    )
    expect(() => recordSweep(doc(), { region: 'us-east-1', resolved: true })).toThrow(
      /needs a YYYY-MM-DD date/,
    )
  })
})

describe('the committed region-health file', () => {
  it('loads, validates, and trusts eu-west-2', () => {
    const d = loadRegionHealth()
    expect(observedRegions(d)).toContain('eu-west-2')
  })
})
