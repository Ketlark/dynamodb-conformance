import { describe, expect, it } from 'vitest'
import { classifyResults } from './classify.mjs'

// Build a minimal Vitest-shaped result document.
function doc(assertions) {
  return {
    testResults: [
      {
        name: '/repo/tests/tier1/x.test.ts',
        assertionResults: assertions.map((a, i) => ({
          title: a.title ?? `t${i}`,
          fullName: `suite ${a.title ?? `t${i}`}`,
          status: a.status,
          meta: a.meta ?? {},
        })),
      },
    ],
  }
}

describe('classifyResults', () => {
  it('classifies a passed test as pass and a genuine failure as fail', () => {
    const verdicts = classifyResults(doc([{ status: 'passed' }, { status: 'failed' }]))
    expect(verdicts.map((v) => v.verdict)).toEqual(['pass', 'fail'])
  })

  it('classifies a failed test carrying meta.indeterminate as indeterminate, not fail', () => {
    const verdicts = classifyResults(
      doc([
        {
          status: 'failed',
          meta: { indeterminate: { reason: 'gsi-consistency-timeout', at: 'test' } },
        },
        { status: 'failed' },
      ]),
    )
    expect(verdicts[0].verdict).toBe('indeterminate')
    expect(verdicts[0].reason).toEqual({ reason: 'gsi-consistency-timeout', at: 'test' })
    // The genuine failure next to it stays a fail: the two are distinguishable.
    expect(verdicts[1].verdict).toBe('fail')
  })

  it('demotes even a passed test still carrying a marker: a marked result is never an answer', () => {
    const verdicts = classifyResults(
      doc([
        {
          status: 'passed',
          meta: { indeterminate: { reason: 'transport', at: 'test' } },
        },
      ]),
    )
    expect(verdicts[0].verdict).toBe('indeterminate')
  })

  it('a run-level sidecar entry classifies every test as indeterminate, whatever its status', () => {
    const sidecar = {
      target: 'dynamodb',
      runLevel: [{ reason: 'transport', phase: 'provisioning', message: 'ECONNREFUSED' }],
    }
    const verdicts = classifyResults(
      doc([{ status: 'passed' }, { status: 'failed' }, { status: 'skipped' }]),
      sidecar,
    )
    expect(verdicts.map((v) => v.verdict)).toEqual([
      'indeterminate',
      'indeterminate',
      'indeterminate',
    ])
    expect(verdicts[0].reason.at).toBe('run')
  })

  it('keeps a skipped test a skip: honest scope is not a failed observation', () => {
    const verdicts = classifyResults(
      doc([{ status: 'skipped' }, { status: 'pending' }, { status: 'todo' }]),
    )
    expect(verdicts.map((v) => v.verdict)).toEqual(['skip', 'skip', 'skip'])
  })

  it('an empty run-level array means a clean run, not indeterminacy', () => {
    const verdicts = classifyResults(doc([{ status: 'passed' }]), { runLevel: [] })
    expect(verdicts[0].verdict).toBe('pass')
  })

  it('carries file and name through for downstream joins', () => {
    const [v] = classifyResults(doc([{ status: 'passed', title: 'answers' }]))
    expect(v.file).toBe('/repo/tests/tier1/x.test.ts')
    expect(v.fullName).toBe('suite answers')
    expect(v.title).toBe('answers')
  })

  it('rejects a malformed sidecar loudly rather than classifying everything as pass', () => {
    expect(() => classifyResults(doc([{ status: 'passed' }]), 'garbage')).toThrow(
      /malformed indeterminate sidecar/,
    )
    expect(() =>
      classifyResults(doc([{ status: 'passed' }]), { runLevel: [{ phase: 'provisioning' }] }),
    ).toThrow(/without a reason/)
    expect(() => classifyResults(doc([{ status: 'passed' }]), { runLevel: 'no' })).toThrow(
      /malformed indeterminate sidecar/,
    )
  })

  it('rejects a document that is not a Vitest result', () => {
    expect(() => classifyResults({ schema: 1 })).toThrow(/missing testResults/)
    expect(() => classifyResults(null)).toThrow(/missing testResults/)
  })

  it('rejects an unrecognised status rather than guessing a bucket', () => {
    expect(() => classifyResults(doc([{ status: 'wobbly' }]))).toThrow(
      /unrecognised test status/,
    )
  })
})
