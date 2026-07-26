import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BINARY_ASSETS, trackedFiles } from './lib/tracked.mjs'

// This repository is public and vendor-neutral. Two classes of string must
// never reach it, and both are the kind of thing that survives review because
// they look unremarkable in a diff:
//
//   - internal scaffolding: planning identifiers, knowledge-base paths, the
//     private link files an agent session leaves behind. A comment reading
//     "U8 scheduled-deploy guard" means nothing to a contributor and quietly
//     advertises a document they cannot read.
//   - private organisation names. The suite scores engines from several
//     vendors and must not read as belonging to any of them. A target's own
//     repository URL is data every target carries and is fine; the same string
//     used as framing is not.
//
// A push here is a one-way door, so this is asserted rather than remembered.

const tracked = trackedFiles()

// This file necessarily contains every pattern it forbids.
const SELF = 'scripts/public-tree.test.mjs'

const textFiles = tracked.filter(
  (path) => path !== SELF && !BINARY_ASSETS.test(path) && existsSync(path),
)

const read = (path) => readFileSync(path, 'utf8')

/** Every line matching `pattern`, as "path:line: text" for a readable failure. */
function hits(pattern, filter = () => true) {
  // Strip /g once, up front, and use the same stateless regex for the
  // whole-file gate and the per-line scan. A /g regex carries lastIndex
  // between .test() calls, so a g-flagged caller would resume mid-string on
  // the next file and drop matches at random - the worst possible failure for
  // a guard, because it stays green.
  const re = new RegExp(pattern.source, pattern.flags.replace('g', ''))
  const found = []
  for (const path of textFiles) {
    const content = read(path)
    if (!re.test(content)) continue
    content.split('\n').forEach((line, i) => {
      if (re.test(line) && filter(line, path)) {
        found.push(`${path}:${i + 1}: ${line.trim().slice(0, 120)}`)
      }
    })
  }
  return found
}

describe('the public tree carries no internal scaffolding', () => {
  it('names no planning unit in a comment', () => {
    // Matches a comment opener followed by a bare unit reference, e.g.
    // "// U8 scheduled-deploy guard" or "# U3: the overlay". Deliberately
    // narrow: a unit id only reads as internal when it opens a comment, and
    // widening this would catch register names, units of measure and CSS.
    expect(hits(/(^|\s)(\/\/|#)\s*U\d{1,2}\b\s*[:.\-]?\s/)).toEqual([])
  })

  it('references no knowledge base or planning document', () => {
    expect(hits(/knowledge-os|~\/kos\/|\bbrainstorms?\/|docs\/plans\//i)).toEqual([])
  })

  it('tracks no local agent or knowledge-base link file', () => {
    // `.kos` and local agent settings are gitignored; this asserts the ignore
    // rules actually held rather than trusting that they did.
    expect(tracked.filter((p) => /(^|\/)\.kos$|\.claude\/settings\.local\.json$/.test(p))).toEqual(
      [],
    )
  })
})

describe('the public tree reads as vendor-neutral', () => {
  it('names no private organisation', () => {
    expect(hits(/\bsi\s?novi\b|\bsinovi\b/i)).toEqual([])
  })

  it('uses a vendor organisation only inside a target project URL', () => {
    // Every target carries a project URL, and for one target that URL sits
    // under a vendor organisation. That is data, as is citing an issue on that
    // target's own tracker. The same name appearing anywhere else is framing,
    // and framing is what makes a neutral board read as somebody's marketing.
    const AS_DATA = new RegExp(
      [
        // a project or raw-content URL: github.com/<org>/<repo>
        '(github\\.com|api\\.github\\.com|raw\\.githubusercontent\\.com)/nubo-db/[a-z0-9._-]+',
        // an issue or PR citation: <org>/<repo>#123
        'nubo-db/[a-z0-9._-]+#\\d+',
      ].join('|'),
      'gi',
    )
    const framing = hits(/nubo-db/i, (line) => /nubo-db/i.test(line.replace(AS_DATA, '')))
    expect(framing).toEqual([])
  })
})
