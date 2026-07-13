import { describe, it, expect } from 'vitest'
import {
  buildIssueBody,
  collectFailures,
  collectIndeterminates,
  verdictFromDrift,
} from './report-failure.mjs'

const report = (assertions) => ({
  testResults: [{ name: 'tests/tier3/error-messages/putItem.test.ts', assertionResults: assertions }],
})

const indeterminate = (fullName, reason = 'gsi-consistency-timeout') => ({
  status: 'failed',
  fullName,
  failureMessages: ['IndeterminateError: timed out\n  at x'],
  meta: { indeterminate: { reason, at: 'test' } },
})

const RUN_LEVEL_SIDECAR = {
  target: 'dynamodb',
  runLevel: [{ reason: 'table-active-timeout', phase: 'provisioning', message: 'timed out' }],
}

describe('collectFailures', () => {
  it('keeps only failed assertions, with the first failure line', () => {
    const r = report([
      { status: 'passed', fullName: 'a > ok' },
      { status: 'failed', fullName: 'a > broke', failureMessages: ['Error: nope\n  at x'] },
    ])
    const fails = collectFailures(r)
    expect(fails).toHaveLength(1)
    expect(fails[0].name).toBe('a > broke')
    expect(fails[0].detail).toBe('Error: nope')
  })

  it('falls back to ancestorTitles + title when fullName is absent', () => {
    const r = report([{ status: 'failed', ancestorTitles: ['Suite', 'Case'], title: 'does X' }])
    expect(collectFailures(r)[0].name).toBe('Suite > Case > does X')
  })

  it('never lists a failed observation as a failure', () => {
    // The raw status is "failed" either way; only the classifier can tell a
    // real behavioural failure from an observation that produced no answer.
    const r = report([
      { status: 'failed', fullName: 'a > broke', failureMessages: ['Error: nope'] },
      indeterminate('a > timed out'),
    ])
    expect(collectFailures(r).map((f) => f.name)).toEqual(['a > broke'])
  })

  it('a run-level sidecar leaves no failures at all', () => {
    const r = report([{ status: 'failed', fullName: 'a > broke' }])
    expect(collectFailures(r, RUN_LEVEL_SIDECAR)).toEqual([])
  })
})

describe('collectIndeterminates', () => {
  it('lists failed observations with their reason', () => {
    const r = report([
      { status: 'passed', fullName: 'a > ok' },
      indeterminate('a > timed out'),
    ])
    const out = collectIndeterminates(r)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('a > timed out')
    expect(out[0].reason).toEqual({ reason: 'gsi-consistency-timeout', at: 'test' })
  })
})

describe('verdictFromDrift', () => {
  it('returns null when there is no usable drift data', () => {
    expect(verdictFromDrift(null)).toBeNull()
    expect(verdictFromDrift({})).toBeNull()
  })

  it('labels a clean diff as a likely flake', () => {
    const v = verdictFromDrift({ clean: true, drift: { probes: [] } })
    expect(v.label).toBe('likely-flake')
    expect(v.probes).toEqual([])
  })

  it('labels a dirty diff as confirmed drift and lists the probe ids', () => {
    const v = verdictFromDrift({ clean: false, drift: { probes: [{ id: 's_put_table_empty' }, { id: 'b_put_dup_ss' }] } })
    expect(v.label).toBe('aws-drift-confirmed')
    expect(v.probes).toEqual(['s_put_table_empty', 'b_put_dup_ss'])
  })

  it('gives no verdict when the diff was not comparable (missing region block)', () => {
    expect(verdictFromDrift({ comparable: false, clean: false, drift: { probes: [] } })).toBeNull()
  })

  it('names a round-trip-only drift so the issue is not left with an empty probe list', () => {
    const v = verdictFromDrift({ clean: false, drift: { probes: [], nullRoundTrip: { changed: ['nullRoundTrip'] } } })
    expect(v.label).toBe('aws-drift-confirmed')
    expect(v.probes).toEqual(['{ NULL: false } round-trip'])
  })
})

describe('buildIssueBody', () => {
  it('reports a could-not-parse body when the report is null', () => {
    expect(buildIssueBody(null, 'https://run')).toContain('could not be read or parsed')
  })

  it('lists failed tests and links the run', () => {
    const body = buildIssueBody(report([{ status: 'failed', fullName: 'a > broke' }]), 'https://run/1')
    expect(body).toContain('1 failed test')
    expect(body).toContain('a > broke')
    expect(body).toContain('https://run/1')
  })

  it('fills the triage slot with a confirmed-drift verdict and probes', () => {
    const verdict = verdictFromDrift({ clean: false, drift: { probes: [{ id: 's_put_table_empty' }] } })
    const body = buildIssueBody(report([{ status: 'failed', fullName: 'x' }]), '', verdict)
    expect(body).toContain('Verdict: AWS drift confirmed')
    expect(body).toContain('`s_put_table_empty`')
  })

  it('fills the triage slot with a flake verdict when the diff is clean', () => {
    const verdict = verdictFromDrift({ clean: true, drift: { probes: [] } })
    const body = buildIssueBody(report([{ status: 'failed', fullName: 'x' }]), '', verdict)
    expect(body).toContain('Verdict: Likely a flake')
  })

  it('falls back to the generic triage note without a verdict', () => {
    const body = buildIssueBody(report([{ status: 'failed', fullName: 'x' }]), '')
    expect(body).toContain('No drift verdict was')
  })

  it('lists failed observations separately from failures, marked as such', () => {
    const body = buildIssueBody(
      report([
        { status: 'failed', fullName: 'a > broke', failureMessages: ['Error: nope'] },
        indeterminate('a > timed out'),
      ]),
      '',
    )
    expect(body).toContain('1 failed test')
    expect(body).toContain('a > broke')
    expect(body).toContain('1 failed observation')
    expect(body).toContain('a > timed out')
    expect(body).toContain('gsi-consistency-timeout')
    expect(body).toContain('counted neither for nor against')
  })

  it('a red that is only failed observations is reported without a failure list', () => {
    const body = buildIssueBody(report([indeterminate('a > timed out')]), '')
    expect(body).not.toContain('failed test')
    expect(body).toContain('1 failed observation')
  })

  it('a run-level indeterminate is one provisioning fault, not hundreds of failures', () => {
    const assertions = Array.from({ length: 40 }, (_, i) => ({
      status: 'failed',
      fullName: `t${i}`,
    }))
    const body = buildIssueBody(report(assertions), '', null, RUN_LEVEL_SIDECAR)
    expect(body).toContain('The run itself was indeterminate')
    expect(body).toContain('table-active-timeout')
    expect(body).toContain('not evidence of drift')
    expect(body).not.toContain('40 failed tests')
    expect(body).not.toContain('- `t0`')
  })

  it('a run-level indeterminate explains the red even when the report is unreadable', () => {
    const body = buildIssueBody(null, '', null, RUN_LEVEL_SIDECAR)
    expect(body).toContain('The run itself was indeterminate')
    expect(body).not.toContain('could not be read')
  })
})
