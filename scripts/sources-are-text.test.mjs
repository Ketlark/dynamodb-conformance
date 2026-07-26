import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BINARY_ASSETS, trackedFiles } from './lib/tracked.mjs'

// Every tracked file must be text. A single raw NUL byte is enough to make
// grep classify the file as binary and silently skip it, and
// file(1) report it as data, so searches for symbols defined there return
// importers but never the definition. That failure mode is invisible in a
// diff and in review (the byte renders as nothing), so it is asserted here
// instead. The genuinely binary assets are excluded explicitly, by the shared
// pattern in ./lib/tracked.mjs, rather than by weakening the check.

const tracked = trackedFiles()

describe('tracked files are text', () => {
  it('no tracked file contains a NUL byte', () => {
    // git ls-files reads the index, so a tracked path can be absent from the
    // worktree mid-refactor; skip it rather than crash, since the deletion
    // is git's to report.
    const binary = tracked.filter(
      (path) =>
        !BINARY_ASSETS.test(path) && existsSync(path) && readFileSync(path).includes(0),
    )
    expect(binary).toEqual([])
  })

  it('the binary-asset exclusion stays narrow', () => {
    // Guards the guard, for both consumers of BINARY_ASSETS: if the exclusion
    // ever widens to match a source path, this check and the public-tree
    // checks go quiet together without anyone noticing.
    expect(BINARY_ASSETS.test('scripts/summarise.mjs')).toBe(false)
    expect(BINARY_ASSETS.test('site/lib/scoring.mjs')).toBe(false)
    expect(BINARY_ASSETS.test('results/dynoxide.json')).toBe(false)
    expect(BINARY_ASSETS.test('site/src/images/og.png')).toBe(true)
    expect(BINARY_ASSETS.test('site/src/fonts/inter-latin-variable.woff2')).toBe(true)
    // Not a free pass for nested paths under an asset directory.
    expect(BINARY_ASSETS.test('site/src/images/nested/thing.png')).toBe(false)
  })
})
