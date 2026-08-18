import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { parseChangelog } from '../site/lib/changelog.mjs'
import {
  assertAhead,
  assertChecksGreen,
  assertLockMatches,
  assertNoOpenDraft,
  assertOnMain,
  assertUntagged,
  assertVersionShape,
  bumpManifests,
  cutRelease,
} from './release.mjs'

const PREAMBLE = `# Conformance suite history

A dated log of how the suite has grown. Newest first.

`

const changelog = (...sections) => PREAMBLE + sections.join('\n')

const UNRELEASED = `## Unreleased

A split row is re-characterised against a 34-region capture.

The matching validation-ordering row is retired.

`

const DATED = `## 2026-08-15 (3.1.0)

ExtendDB's SQLite backend joins the run.
`

describe('cutRelease', () => {
  it('dates the Unreleased section and leaves its body untouched', () => {
    const { changelog: out } = cutRelease(changelog(UNRELEASED, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(out).toContain('## 2026-08-18 (3.2.0)')
    expect(out).toContain('A split row is re-characterised against a 34-region capture.')
    expect(out).toContain('The matching validation-ordering row is retired.')
    // The dated section sits above the previous release, not below it: the file
    // is newest-first and a release that appended would invert it.
    expect(out.indexOf('## 2026-08-18 (3.2.0)')).toBeLessThan(out.indexOf('## 2026-08-15 (3.1.0)'))
    // And the release before it is carried through whole.
    expect(out).toContain(DATED.trim())
  })

  it('leaves exactly one Unreleased heading behind, with no body', () => {
    // site/lib/changelog.mjs documents a bodyless `## Unreleased` as the
    // standing state between releases, and it is where the next branch writes.
    // A second one would be two pending sections; none at all would make the
    // next contributor invent the heading.
    const { changelog: out } = cutRelease(changelog(UNRELEASED, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(out.match(/^## Unreleased$/gm)).toHaveLength(1)
    expect(parseChangelog(out).unreleased).toBeNull()
  })

  it('produces a file the site parser reads as one more dated entry', () => {
    const { changelog: out } = cutRelease(changelog(UNRELEASED, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })
    const parsed = parseChangelog(out)

    expect(parsed.skipped).toEqual([])
    expect(parsed.entries.map((e) => [e.date, e.version])).toEqual([
      ['2026-08-18', '3.2.0'],
      ['2026-08-15', '3.1.0'],
    ])
    expect(parsed.entries[0].bodyHtml).toContain('34-region capture')
  })

  it('returns the notes as the section body, with the heading stripped', () => {
    const { notes } = cutRelease(changelog(UNRELEASED, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(notes).not.toContain('##')
    expect(notes.trim()).toBe(
      'A split row is re-characterised against a 34-region capture.\n\nThe matching validation-ordering row is retired.',
    )
  })

  it('merges two Unreleased sections into one dated entry', () => {
    // The parser tolerates two because a merge landing two is the expected
    // case, so the release has to fold them rather than date the first and
    // strand the second.
    const second = `## Unreleased

A second branch wrote its note ahead of the cut.

`
    const { changelog: out, notes } = cutRelease(changelog(UNRELEASED, second, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(out.match(/^## Unreleased$/gm)).toHaveLength(1)
    expect(out.match(/^## 2026-08-18 \(3\.2\.0\)$/gm)).toHaveLength(1)
    expect(notes).toContain('34-region capture')
    expect(notes).toContain('A second branch wrote its note ahead of the cut.')
    expect(parseChangelog(out).unreleased).toBeNull()
  })

  it('accepts the bracketed Keep a Changelog spelling the parser accepts', () => {
    const bracketed = UNRELEASED.replace('## Unreleased', '## [Unreleased]')
    const { changelog: out } = cutRelease(changelog(bracketed, DATED), {
      version: '3.2.0',
      date: '2026-08-18',
    })

    expect(out).toContain('## 2026-08-18 (3.2.0)')
    expect(parseChangelog(out).unreleased).toBeNull()
  })

  it('refuses a changelog with no Unreleased section', () => {
    expect(() => cutRelease(changelog(DATED), { version: '3.2.0', date: '2026-08-18' })).toThrow(
      /no `## Unreleased` section/,
    )
  })

  it('refuses an empty Unreleased section, because there is nothing to release', () => {
    expect(() =>
      cutRelease(changelog('## Unreleased\n\n', DATED), { version: '3.2.0', date: '2026-08-18' }),
    ).toThrow(/nothing to release/)
  })

  it('refuses a version or date it cannot write into a heading', () => {
    const body = changelog(UNRELEASED, DATED)
    expect(() => cutRelease(body, { version: 'v3.2.0', date: '2026-08-18' })).toThrow(/3\.2\.0/)
    expect(() => cutRelease(body, { version: '3.2.0', date: '18-08-2026' })).toThrow(/YYYY-MM-DD/)
  })
})

describe('bumpManifests', () => {
  const pkg = JSON.stringify({ name: 'dynamodb-conformance', version: '3.1.0' }, null, 2) + '\n'
  const lock =
    JSON.stringify(
      {
        name: 'dynamodb-conformance',
        version: '3.1.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'dynamodb-conformance', version: '3.1.0' },
          'node_modules/junk': { version: '3.1.0', license: 'MIT' },
        },
      },
      null,
      2,
    ) + '\n'

  it('moves both manifests to the new version', () => {
    const out = bumpManifests(pkg, lock, '3.2.0')

    expect(JSON.parse(out.pkg).version).toBe('3.2.0')
    expect(JSON.parse(out.lock).version).toBe('3.2.0')
    expect(JSON.parse(out.lock).packages[''].version).toBe('3.2.0')
  })

  it('does not touch a dependency that happens to share the old version', () => {
    // package-lock.json carries junk@3.1.0 while the suite is at 3.1.0, so a
    // text substitution would rewrite an unrelated dependency's pin and the
    // lockfile would no longer describe what npm resolves.
    const out = bumpManifests(pkg, lock, '3.2.0')

    expect(JSON.parse(out.lock).packages['node_modules/junk'].version).toBe('3.1.0')
  })

  it('keeps the two-space formatting and trailing newline npm writes', () => {
    const out = bumpManifests(pkg, lock, '3.2.0')

    expect(out.pkg.endsWith('\n')).toBe(true)
    expect(out.lock.endsWith('\n')).toBe(true)
    expect(out.pkg).toContain('\n  "version": "3.2.0"')
  })
})

describe('assertLockMatches', () => {
  it('accepts a lockfile that moved with package.json', () => {
    expect(() =>
      assertLockMatches({ version: '3.2.0' }, { version: '3.2.0', packages: { '': { version: '3.2.0' } } }),
    ).not.toThrow()
  })

  it('refuses a lockfile left behind', () => {
    expect(() =>
      assertLockMatches({ version: '3.2.0' }, { version: '3.1.0', packages: { '': { version: '3.1.0' } } }),
    ).toThrow(/package-lock\.json/)
  })

  it('refuses a lockfile whose root package entry was missed', () => {
    expect(() =>
      assertLockMatches({ version: '3.2.0' }, { version: '3.2.0', packages: { '': { version: '3.1.0' } } }),
    ).toThrow(/packages\[""\]/)
  })
})

describe('assertVersionShape', () => {
  it('accepts a bare semver', () => {
    expect(() => assertVersionShape('3.2.0')).not.toThrow()
    expect(() => assertVersionShape('3.10.12')).not.toThrow()
  })

  it('refuses anything the tag and heading conventions cannot carry', () => {
    // The tag is `v` + this, and resolve-measured-ref.mjs only reads exactly
    // vMAJOR.MINOR.PATCH, so a prerelease or a `v`-prefixed input would produce
    // a tag the board can never measure.
    for (const bad of ['v3.2.0', '3.2', '3.2.0-rc1', '3.2.0.1', '']) {
      expect(() => assertVersionShape(bad), bad).toThrow(/MAJOR\.MINOR\.PATCH/)
    }
  })
})

describe('assertAhead', () => {
  it('accepts a version above the current one', () => {
    expect(() => assertAhead('3.2.0', '3.1.0')).not.toThrow()
    expect(() => assertAhead('3.10.0', '3.9.0')).not.toThrow()
    expect(() => assertAhead('4.0.0', '3.9.9')).not.toThrow()
  })

  it('refuses a version equal to or below the current one', () => {
    expect(() => assertAhead('3.1.0', '3.1.0')).toThrow(/3\.1\.0/)
    expect(() => assertAhead('3.0.9', '3.1.0')).toThrow(/3\.1\.0/)
    expect(() => assertAhead('3.9.0', '3.10.0')).toThrow(/3\.10\.0/)
  })
})

describe('assertUntagged', () => {
  it('accepts a version no tag claims', () => {
    expect(() => assertUntagged('3.2.0', ['v3.0.0', 'v3.1.0'])).not.toThrow()
  })

  it('refuses a version already tagged, naming the tag', () => {
    expect(() => assertUntagged('3.1.0', ['v3.0.0', 'v3.1.0'])).toThrow(/v3\.1\.0/)
  })
})

describe('assertOnMain', () => {
  it('accepts main', () => {
    expect(() => assertOnMain('main')).not.toThrow()
  })

  it('refuses any other ref, because a tag cut off a branch measures work no PR gated', () => {
    expect(() => assertOnMain('feat/measured-ref')).toThrow(/main/)
    expect(() => assertOnMain('')).toThrow(/main/)
  })
})

describe('assertChecksGreen', () => {
  it('accepts a commit whose checks all succeeded', () => {
    expect(() =>
      assertChecksGreen([
        { name: 'Cheap gate', status: 'completed', conclusion: 'success' },
        { name: 'Docs', status: 'completed', conclusion: 'skipped' },
      ]),
    ).not.toThrow()
  })

  it('refuses a failing check, naming it', () => {
    expect(() =>
      assertChecksGreen([
        { name: 'Cheap gate', status: 'completed', conclusion: 'success' },
        { name: 'Site tests', status: 'completed', conclusion: 'failure' },
      ]),
    ).toThrow(/Site tests/)
  })

  it('refuses a check still running, so a cut cannot outrun its own gate', () => {
    expect(() =>
      assertChecksGreen([{ name: 'Cheap gate', status: 'in_progress', conclusion: null }]),
    ).toThrow(/Cheap gate/)
  })

  it('refuses a commit with no checks at all', () => {
    expect(() => assertChecksGreen([])).toThrow(/no checks/)
  })
})

describe('assertNoOpenDraft', () => {
  it('accepts a repository whose releases are all published', () => {
    expect(() =>
      assertNoOpenDraft([
        { tag_name: 'v3.1.0', draft: false },
        { tag_name: 'v3.0.0', draft: false },
      ]),
    ).not.toThrow()
  })

  it('refuses a cut while a draft is open, naming it', () => {
    // Every other precondition passes for 3.2.1 while 3.2.0's draft is open and
    // its three-hour measurement is still running, and two measurement runs
    // would then race the board.
    expect(() =>
      assertNoOpenDraft([
        { tag_name: 'v3.2.0', draft: true },
        { tag_name: 'v3.1.0', draft: false },
      ]),
    ).toThrow(/v3\.2\.0/)
  })
})

describe('release.yml', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/release.yml', 'utf8'))

  it('is dispatch-only, so a release is never a side effect of a merge', () => {
    expect(Object.keys(workflow.true ?? workflow.on)).toEqual(['workflow_dispatch'])
  })

  it('takes the version as its only input', () => {
    const inputs = (workflow.true ?? workflow.on).workflow_dispatch.inputs
    expect(Object.keys(inputs)).toEqual(['version'])
    expect(inputs.version.required).toBe(true)
  })

  it('installs against the bumped tree before anything is tagged', () => {
    // The tagged tree is measured for about three hours and no required check
    // has run against it: the checks passed on the commit before the bump, and
    // "both files moved together" is not "the result installs". Without this a
    // bad lockfile yields a tag, a draft and a run that dies at install, whose
    // first visible symptom is a draft that never flips.
    const steps = workflow.jobs.release.steps
    const at = (needle) => {
      const i = steps.findIndex((s) => JSON.stringify(s).includes(needle))
      expect(i, `release.yml has no step containing \`${needle}\``).toBeGreaterThan(-1)
      return i
    }
    // `git tag -a`, not `git tag`: the precondition step runs `git tag --list`
    // and would satisfy a looser needle from above the install.
    expect(at('npm ci')).toBeLessThan(at('git tag -a'))
  })

  it('creates an annotated tag, matching every tag the repo already carries', () => {
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(yamlText).toMatch(/git tag -a/)
  })

  it('creates the release as a draft and dispatches conformance at the new tag', () => {
    const yamlText = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(yamlText).toMatch(/gh release create[\s\S]{0,400}--draft/)
    expect(yamlText).toMatch(/gh workflow run conformance\.yml/)
  })
})

