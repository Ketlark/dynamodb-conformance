import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { releaseTagsByVersion, resolveMeasuredRef } from './resolve-measured-ref.mjs'

const TAGS = ['v2.0.0', 'v2.1.0', 'v3.0.0', 'v3.1.0']

describe('releaseTagsByVersion', () => {
  it('orders by version, highest first', () => {
    expect(releaseTagsByVersion(TAGS)).toEqual(['v3.1.0', 'v3.0.0', 'v2.1.0', 'v2.0.0'])
  })

  it('compares components numerically, so v3.10.0 beats v3.9.0', () => {
    // Lexical ordering puts v3.10.0 before v3.9.0 and would pick the wrong
    // release the first time a minor reaches double digits.
    expect(releaseTagsByVersion(['v3.9.0', 'v3.10.0'])[0]).toBe('v3.10.0')
    expect(releaseTagsByVersion(['v3.1.9', 'v3.1.10'])[0]).toBe('v3.1.10')
  })

  it('ignores anything that is not exactly vMAJOR.MINOR.PATCH', () => {
    // A tag this cannot read is a tag it must not choose.
    expect(releaseTagsByVersion(['v3.1.0', 'latest', 'v4', 'release-5.0.0', 'v9.9.9-rc1'])).toEqual([
      'v3.1.0',
    ])
  })

  it('returns nothing when no tag is a release tag', () => {
    expect(releaseTagsByVersion(['nightly', 'v1.2'])).toEqual([])
    expect(releaseTagsByVersion([])).toEqual([])
  })
})

describe('resolveMeasuredRef', () => {
  it('resolves a schedule to the latest release tag', () => {
    expect(resolveMeasuredRef({ event: 'schedule', tags: TAGS })).toEqual({
      ref: 'v3.1.0',
      kind: 'tag',
    })
  })

  it('resolves a push to the pushed sha, which is never publishable', () => {
    const r = resolveMeasuredRef({ event: 'push', sha: 'abc123', tags: TAGS })
    expect(r.ref).toBe('abc123')
    expect(r.kind).toBe('sha')
  })

  it('takes an explicit ref verbatim, whatever the event', () => {
    expect(resolveMeasuredRef({ event: 'workflow_dispatch', inputRef: 'v3.0.0', tags: TAGS })).toEqual(
      { ref: 'v3.0.0', kind: 'tag' },
    )
    // Even on a push: an explicit ref is a deliberate instruction.
    expect(resolveMeasuredRef({ event: 'push', sha: 'abc123', inputRef: 'v2.1.0', tags: TAGS }).ref).toBe(
      'v2.1.0',
    )
  })

  it('marks an explicit non-tag ref unpublishable, so a re-measure of main cannot publish', () => {
    expect(resolveMeasuredRef({ event: 'workflow_dispatch', inputRef: 'main', tags: TAGS })).toEqual({
      ref: 'main',
      kind: 'other',
    })
  })

  it('prefers version order over the order tags were written', () => {
    // v2.0.0 and v2.1.0 were backfilled after v3.0.0 in this repo, so a
    // creation-ordered rule would answer v2.1.0 here.
    expect(resolveMeasuredRef({ event: 'schedule', tags: ['v3.0.0', 'v2.0.0', 'v2.1.0'] }).ref).toBe(
      'v3.0.0',
    )
  })

  it('falls back to main when there are no release tags, and refuses to call it publishable', () => {
    // A fresh clone, or a repo before its first cut. Failing here would brick
    // the workflow; claiming a tag would publish something no release earned.
    expect(resolveMeasuredRef({ event: 'schedule', tags: [] })).toEqual({
      ref: 'main',
      kind: 'other',
    })
  })

  it('refuses a push that names no sha rather than guessing', () => {
    expect(() => resolveMeasuredRef({ event: 'push', tags: TAGS })).toThrow(/sha/)
  })
})

describe('the committed workflow consumes the resolved ref', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/conformance.yml', 'utf8'))
  const jobs = Object.entries(workflow.jobs)

  // The checkout that reads this repo, as opposed to the second checkouts that
  // clone a target engine from its own repository.
  const suiteCheckouts = (job) =>
    (job.steps ?? []).filter(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout') && !s.with?.repository,
    )

  // `changes` resolves the ref, so it reads the triggering ref by definition.
  // `capture-cross-region` commits back to main and has to stand on main to do
  // it; U2 leaves it there deliberately.
  const RESOLVES_OR_COMMITS = new Set(['changes', 'capture-cross-region'])

  it('every suite checkout outside the resolver and the committer takes the resolved ref', () => {
    const wrong = []
    for (const [id, job] of jobs) {
      if (RESOLVES_OR_COMMITS.has(id)) continue
      for (const step of suiteCheckouts(job)) {
        const ref = step.with?.ref
        if (typeof ref !== 'string' || !ref.includes('needs.changes.outputs.ref')) {
          wrong.push(`${id} (ref: ${ref ?? 'unset'})`)
        }
      }
    }
    expect(wrong, `these check out the triggering ref instead of the measured one: ${wrong.join(', ')}`)
      .toEqual([])
  })

  it('keeps the committing job on main, so it never commits from a detached tag', () => {
    const capture = workflow.jobs['capture-cross-region']
    expect(suiteCheckouts(capture)[0].with.ref).toBe('main')
  })

  it('leaves the target-engine checkouts alone, since they clone another repo', () => {
    const external = jobs.flatMap(([, job]) =>
      (job.steps ?? []).filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout') && s.with?.repository),
    )
    expect(external.length).toBeGreaterThan(0)
    for (const step of external) {
      expect(step.with.ref).not.toContain('needs.changes.outputs.ref')
    }
  })

  it('publishes the resolved ref, its kind, commit and suite version as job outputs', () => {
    const outputs = workflow.jobs.changes.outputs
    for (const key of ['ref', 'kind', 'commit', 'version']) {
      expect(outputs, `changes job does not output ${key}`).toHaveProperty(key)
    }
  })
})
