import { describe, it, expect } from 'vitest'
import {
  resolveTablePrefix,
  localSessionPrefix,
  pinTablePrefix,
  CI_TABLE_PREFIX,
  LOCAL_TABLE_NAMESPACE,
  TABLE_PREFIX_ENV,
} from './table-namespace.js'

// The namespaces have to stay disjoint: the sweep deletes every table matching
// its prefix, with no age gate and no ownership record, so a shared prefix means
// one run can delete another's tables mid-suite.
describe('resolveTablePrefix', () => {
  const session = () => '_capture_20260818_abcdef_'

  it('uses an explicit override verbatim, whatever CI says', () => {
    expect(resolveTablePrefix({ [TABLE_PREFIX_ENV]: '_mine_', CI: 'true' }, session)).toBe('_mine_')
    expect(resolveTablePrefix({ [TABLE_PREFIX_ENV]: '_mine_' }, session)).toBe('_mine_')
  })

  // CI's prefix is stable on purpose: its pre-run sweep is what clears tables
  // stranded by a run that died, and a per-session prefix would match none of
  // them. The concurrency group is what stops two CI runs overlapping.
  it('takes the stable CI namespace under CI', () => {
    expect(resolveTablePrefix({ CI: 'true' }, session)).toBe(CI_TABLE_PREFIX)
  })

  it('takes a session-scoped prefix otherwise', () => {
    expect(resolveTablePrefix({}, session)).toBe('_capture_20260818_abcdef_')
  })

  // An empty string is how an unset variable arrives from a shell that exported
  // it blank. Honouring it would leave the run unnamespaced, and its sweep would
  // match every table on the account.
  it('ignores an empty override rather than sweeping everything', () => {
    expect(resolveTablePrefix({ [TABLE_PREFIX_ENV]: '' }, session)).toBe(session())
    expect(resolveTablePrefix({ [TABLE_PREFIX_ENV]: '', CI: 'true' }, session)).toBe(CI_TABLE_PREFIX)
  })

  it('keeps the two namespaces disjoint', () => {
    expect(CI_TABLE_PREFIX.startsWith(LOCAL_TABLE_NAMESPACE)).toBe(false)
    expect(LOCAL_TABLE_NAMESPACE.startsWith(CI_TABLE_PREFIX)).toBe(false)
  })
})

describe('localSessionPrefix', () => {
  const day = new Date('2026-08-18T09:00:00Z')

  it('carries the namespace, the date and a code', () => {
    expect(localSessionPrefix(day, () => 0.5)).toMatch(/^_capture_20260818_[0-9a-z]{6}_$/)
  })

  it('differs between sessions, which is what stops one sweeping another', () => {
    let n = 0
    const seq = () => [0.1, 0.9][n++]
    expect(localSessionPrefix(day, seq)).not.toBe(localSessionPrefix(day, seq))
  })

  it('pads a small code rather than shortening the prefix', () => {
    expect(localSessionPrefix(day, () => 0)).toBe('_capture_20260818_000000_')
  })
})


describe('pinTablePrefix', () => {
  // A session prefix minted independently in the worker and in the main process
  // would differ, and the teardown would sweep a namespace holding nothing.
  it('writes the resolved prefix back so a second reader agrees', () => {
    const env: NodeJS.ProcessEnv = {}
    const pinned = pinTablePrefix(env)
    expect(env[TABLE_PREFIX_ENV]).toBe(pinned)
    expect(resolveTablePrefix(env)).toBe(pinned)
  })

  it('is idempotent, so a second pin does not re-mint the session', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(pinTablePrefix(env)).toBe(pinTablePrefix(env))
  })

  it('leaves an explicit prefix alone', () => {
    const env: NodeJS.ProcessEnv = { [TABLE_PREFIX_ENV]: '_mine_' }
    expect(pinTablePrefix(env)).toBe('_mine_')
  })

  it('pins the stable namespace under CI', () => {
    const env: NodeJS.ProcessEnv = { CI: 'true' }
    expect(pinTablePrefix(env)).toBe(CI_TABLE_PREFIX)
  })
})
