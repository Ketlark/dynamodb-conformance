import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ABANDON_PROVISIONING_AFTER,
  clearIndeterminateMarker,
  clearStaleSidecar,
  noteProvisioningFailed,
  noteProvisioningSucceeded,
  provisioningAbandoned,
  recordRunLevel,
  resetSinkForTesting,
  resultSlug,
  resultsDir,
  sidecarPath,
  stampIndeterminateMarker,
} from './indeterminate-sink.js'
import { IndeterminateError } from './indeterminate.js'

let dir: string

beforeEach(() => {
  resetSinkForTesting()
  dir = mkdtempSync(join(tmpdir(), 'indeterminate-sink-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resultSlug', () => {
  it('mirrors the vitest config: CONFORMANCE_TARGET wins', () => {
    expect(resultSlug({ CONFORMANCE_TARGET: 'dynoxide' })).toBe('dynoxide')
  })

  it('falls back to local for an endpoint-only run and dynamodb otherwise', () => {
    expect(resultSlug({ DYNAMODB_ENDPOINT: 'http://localhost:8000' })).toBe('local')
    expect(resultSlug({})).toBe('dynamodb')
  })
})

describe('resultsDir', () => {
  it('defaults to results and honours the override', () => {
    expect(resultsDir({})).toBe('results')
    expect(resultsDir({ CONFORMANCE_RESULTS_DIR: 'ground-truth' })).toBe('ground-truth')
  })
})

describe('sidecarPath', () => {
  it('pairs the sidecar with the results file it qualifies', () => {
    expect(sidecarPath('dynamodb', 'results')).toBe('results/dynamodb.indeterminate.json')
  })
})

describe('recordRunLevel', () => {
  it('writes a sidecar carrying the run-level entry', () => {
    recordRunLevel(
      { reason: 'table-active-timeout', phase: 'provisioning', message: 'timed out' },
      { slug: 'dynamodb', dir },
    )
    const written = JSON.parse(readFileSync(sidecarPath('dynamodb', dir), 'utf8'))
    expect(written).toEqual({
      target: 'dynamodb',
      runLevel: [
        { reason: 'table-active-timeout', phase: 'provisioning', message: 'timed out' },
      ],
    })
  })

  it('keeps one entry when the same failure is recorded once per test file', () => {
    // The guarded beforeAll retries provisioning for every test file after a
    // failure, so the same run-level failure is recorded many times per run.
    for (let i = 0; i < 3; i++) {
      recordRunLevel(
        { reason: 'transport', phase: 'provisioning', message: 'ECONNREFUSED' },
        { slug: 'dynamodb', dir },
      )
    }
    const written = JSON.parse(readFileSync(sidecarPath('dynamodb', dir), 'utf8'))
    expect(written.runLevel).toHaveLength(1)
  })

  it('records nothing at all for a clean run: no file exists', () => {
    // Absence of the sidecar is the signal that nothing was absent.
    expect(existsSync(sidecarPath('dynamodb', dir))).toBe(false)
  })
})

describe('provisioningAbandoned', () => {
  it('holds off until provisioning has failed enough files running', () => {
    for (let i = 0; i < ABANDON_PROVISIONING_AFTER - 1; i++) {
      noteProvisioningFailed()
      expect(provisioningAbandoned()).toBe(false)
    }
    noteProvisioningFailed()
    expect(provisioningAbandoned()).toBe(true)
  })

  it('does not abandon a target over failures a later file recovered from', () => {
    // The per-file retry exists for exactly this: a transient fault during one
    // file's provisioning must not take out the files behind it, however many
    // separate blips a long run accumulates.
    for (let i = 0; i < ABANDON_PROVISIONING_AFTER * 3; i++) {
      noteProvisioningFailed()
      noteProvisioningSucceeded()
    }
    expect(provisioningAbandoned()).toBe(false)
  })

  it('starts counting again from zero after a recovery', () => {
    noteProvisioningFailed()
    noteProvisioningFailed()
    noteProvisioningSucceeded()
    for (let i = 0; i < ABANDON_PROVISIONING_AFTER - 1; i++) noteProvisioningFailed()
    expect(provisioningAbandoned()).toBe(false)
  })

  it('is false for a run that has never failed provisioning', () => {
    expect(provisioningAbandoned()).toBe(false)
  })
})

describe('clearStaleSidecar', () => {
  it('removes a previous run leftover and is a no-op when none exists', () => {
    recordRunLevel(
      { reason: 'transport', phase: 'provisioning', message: 'x' },
      { slug: 'dynamodb', dir },
    )
    clearStaleSidecar({ slug: 'dynamodb', dir })
    expect(existsSync(sidecarPath('dynamodb', dir))).toBe(false)
    expect(() => clearStaleSidecar({ slug: 'dynamodb', dir })).not.toThrow()
  })
})

// The attempt lifecycle the hooks in src/setup.ts must honour. The runner
// accumulates errors across retry attempts on the same task and only the
// marker's absence distinguishes "passed after a flake" from "never answered".
describe('marker hooks across attempts', () => {
  function task(): {
    meta: { indeterminate?: { reason: string; at: string } }
    result?: { state?: string; errors?: unknown[] }
  } {
    return { meta: {} }
  }

  // Errors as afterEach sees them: cloned to plain objects by the runner, so
  // build them the same way.
  const indeterminate = {
    name: 'IndeterminateError',
    reason: 'gsi-consistency-timeout',
    message: 'Timeout waiting for GSI gsi1 consistency (expected 1 items)',
  }
  const assertion = { name: 'AssertionError', message: 'expected 1 to be 2' }

  it('stamps a failing attempt whose error is indeterminate', () => {
    const t = task()
    t.result = { state: 'fail', errors: [indeterminate] }
    stampIndeterminateMarker(t as never)
    expect(t.meta.indeterminate).toEqual({ reason: 'gsi-consistency-timeout', at: 'test' })
  })

  it('stamps a failing attempt whose error is a live IndeterminateError', () => {
    const t = task()
    t.result = {
      state: 'fail',
      errors: [new IndeterminateError('table-active-timeout', 'timed out')],
    }
    stampIndeterminateMarker(t as never)
    expect(t.meta.indeterminate).toEqual({ reason: 'table-active-timeout', at: 'test' })
  })

  it('stamps a failing attempt on a raw retry-exhausted throttle', () => {
    const t = task()
    t.result = {
      state: 'fail',
      errors: [{ name: 'ThrottlingException', message: 'Rate exceeded' }],
    }
    stampIndeterminateMarker(t as never)
    expect(t.meta.indeterminate).toEqual({ reason: 'throttle-exhausted', at: 'test' })
  })

  it('does not stamp a genuine assertion failure', () => {
    const t = task()
    t.result = { state: 'fail', errors: [assertion] }
    stampIndeterminateMarker(t as never)
    expect(t.meta.indeterminate).toBeUndefined()
  })

  it('judges the current attempt only: a real failure after an indeterminate one is a fail', () => {
    // Attempt 1 timed out, attempt 2 failed a real assertion. The runner keeps
    // both errors; only the last (current) one may drive the marker.
    const t = task()
    t.result = { state: 'fail', errors: [indeterminate, assertion] }
    stampIndeterminateMarker(t as never)
    expect(t.meta.indeterminate).toBeUndefined()
  })

  it('a test that times out then passes on retry ends with an empty meta', () => {
    // The sharpest edge in the design: task.meta outlives a retry, and the
    // ground-truth job retries. A stale marker here would silently demote a
    // healthy test out of the denominator.
    const t = task()

    // Attempt 1: fails with an indeterminate error; afterEach stamps it.
    clearIndeterminateMarker(t as never)
    t.result = { state: 'fail', errors: [indeterminate] }
    stampIndeterminateMarker(t as never)
    expect(t.meta.indeterminate).toBeDefined()

    // Attempt 2: beforeEach clears the marker; the test passes (the runner
    // keeps attempt 1's error on the task but flips the state to pass).
    clearIndeterminateMarker(t as never)
    t.result = { state: 'pass', errors: [indeterminate] }
    stampIndeterminateMarker(t as never)
    expect(t.meta).toEqual({})
  })

  it('never stamps a passing attempt', () => {
    const t = task()
    t.result = { state: 'pass' }
    stampIndeterminateMarker(t as never)
    expect(t.meta.indeterminate).toBeUndefined()
  })
})
