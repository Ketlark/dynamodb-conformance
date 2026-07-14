import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_AGE_HOURS,
  exitVerdict,
  parseArgs,
  reapAll,
  selectOrphans,
} from './reap-orphans.mjs'
import { COMMERCIAL_REGIONS } from '../src/regions.ts'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-07-11T12:00:00Z')
const maxAgeMs = DEFAULT_MAX_AGE_HOURS * HOUR

function table(name, ageHours) {
  return { name, creationDateTime: new Date(NOW - ageHours * HOUR).toISOString() }
}

describe('selectOrphans', () => {
  it('selects stray _conformance_ tables older than the threshold', () => {
    const tables = [
      table('_conformance_users_170000_1', 26),
      table('_conformance_orders_170000_2', 4),
    ]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([
      '_conformance_orders_170000_2',
      '_conformance_users_170000_1',
    ])
  })

  it('never selects a table young enough to belong to a run still in flight', () => {
    // A live run's tables cannot outlive its two-hour credential ceiling, so
    // anything under the three-hour default might still be in use.
    const tables = [table('_conformance_live_170000_3', 1.5)]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([])
  })

  it('a table exactly at the threshold is not yet an orphan: selection is strictly older-than', () => {
    const tables = [table('_conformance_edge_170000_4', DEFAULT_MAX_AGE_HOURS)]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([])
    expect(
      selectOrphans([table('_conformance_edge_170000_4', DEFAULT_MAX_AGE_HOURS + 0.001)], {
        now: NOW,
        maxAgeMs,
      }),
    ).toEqual(['_conformance_edge_170000_4'])
  })

  it('never selects a table without the _conformance_ prefix, however old', () => {
    const tables = [
      table('production-users', 24 * 365),
      table('conformance_missing_underscore', 100),
      table('_conformance_stray_170000_5', 100),
    ]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([
      '_conformance_stray_170000_5',
    ])
  })

  it('leaves a table whose age cannot be established alone: no deletion on missing evidence', () => {
    const tables = [
      { name: '_conformance_undated_170000_6' },
      { name: '_conformance_garbled_170000_7', creationDateTime: 'not a date' },
    ]
    expect(selectOrphans(tables, { now: NOW, maxAgeMs })).toEqual([])
  })

  it('a region with no strays is a clean no-op', () => {
    expect(selectOrphans([], { now: NOW, maxAgeMs })).toEqual([])
  })
})

describe('reapAll', () => {
  it('an unreachable region is reported and skipped, never aborting the others', async () => {
    const visited = []
    const { reaped, failures } = await reapAll(['eu-west-2', 'sa-east-1', 'us-east-1'], {
      reap: async (region) => {
        visited.push(region)
        if (region === 'sa-east-1') throw new Error('connect ETIMEDOUT')
        return { deleted: [], failed: [] }
      },
    })
    expect(visited).toEqual(['eu-west-2', 'sa-east-1', 'us-east-1'])
    expect(Object.keys(reaped)).toEqual(['eu-west-2', 'us-east-1'])
    expect(failures).toEqual([{ region: 'sa-east-1', message: 'connect ETIMEDOUT' }])
  })
})

describe('parseArgs', () => {
  it('defaults to every commercial region and the default age threshold', () => {
    const args = parseArgs([])
    expect(args.regions).toEqual([...COMMERCIAL_REGIONS])
    expect(args.maxAgeHours).toBe(DEFAULT_MAX_AGE_HOURS)
    expect(args.dryRun).toBe(false)
  })

  it('accepts a region subset, a threshold override, and dry-run', () => {
    const args = parseArgs(['--dry-run', '--max-age-hours', '6', 'eu-west-2', 'us-east-1'])
    expect(args).toEqual({ regions: ['eu-west-2', 'us-east-1'], maxAgeHours: 6, dryRun: true })
  })

  it('rejects a threshold that is not a positive number', () => {
    expect(() => parseArgs(['--max-age-hours', '0'])).toThrow(/positive number/)
    expect(() => parseArgs(['--max-age-hours', 'soon'])).toThrow(/positive number/)
  })

  it('rejects unknown options rather than ignoring them', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown option/)
  })
})

// The daily-cron alarm contract: red means a human must look. Unreachable
// regions (opt-in enablement pending, a regional wobble) warn instead, so the
// alarm never trains anyone to ignore it - but nothing walked at all stays
// loudly red, and an undeletable orphan always wins.
describe('exitVerdict', () => {
  it('one unreachable region among reachable ones warns rather than fails', () => {
    expect(exitVerdict({ stuck: 0, unreachable: 1, regionCount: 34 })).toEqual({
      code: 0,
      reason: null,
      warn: true,
    })
  })

  it('a majority of regions unreachable is a systemic failure and exits 1', () => {
    const all = exitVerdict({ stuck: 0, unreachable: 34, regionCount: 34 })
    expect(all.code).toBe(1)
    expect(all.reason).toMatch(/systemic, not regional/)
    // The boundary: 17 of 34 warns, 18 of 34 fails.
    expect(exitVerdict({ stuck: 0, unreachable: 17, regionCount: 34 })).toEqual({
      code: 0,
      reason: null,
      warn: true,
    })
    expect(exitVerdict({ stuck: 0, unreachable: 18, regionCount: 34 }).code).toBe(1)
  })

  it('the opt-in enablement window stays on the warning path', () => {
    // Six disabled opt-in regions must not redden the daily run.
    expect(exitVerdict({ stuck: 0, unreachable: 6, regionCount: 34 })).toEqual({
      code: 0,
      reason: null,
      warn: true,
    })
  })

  it('an undeletable orphan fails the run even with unreachable regions present', () => {
    const verdict = exitVerdict({ stuck: 2, unreachable: 1, regionCount: 34 })
    expect(verdict.code).toBe(1)
    expect(verdict.reason).toMatch(/2 undeletable/)
  })

  it('a clean run exits 0 with no warning, an undeletable-only run exits 1: the old contract holds', () => {
    expect(exitVerdict({ stuck: 0, unreachable: 0, regionCount: 34 })).toEqual({
      code: 0,
      reason: null,
      warn: false,
    })
    expect(exitVerdict({ stuck: 1, unreachable: 0, regionCount: 34 }).code).toBe(1)
  })
})
