// Decide which ref a conformance run measures.
//
// The board publishes figures measured against a released suite, not against
// whatever is on main, so a run has to say what it read before it reads it.
// This is that decision, in one place: every job in the workflow checks out
// what this resolves rather than re-deriving it, because two jobs disagreeing
// about which suite they ran would produce a board nothing could describe.
//
// The rule:
//
//   an explicit ref input  -> that ref, verbatim
//   a push                 -> the pushed sha (validation, never published)
//   anything else          -> the latest release tag (measurement)
//   no release tags at all -> main
//
// "Latest" is the highest version number, not the most recently created tag and
// not the nearest tag by commit topology. Creation order is already unsound in
// this repo: v2.0.0 and v2.1.0 were both written on 2026-08-13, after v3.0.0
// had been created the same day, because they were backfilled. Topology order
// answers "what is this commit descended from", which is a different question
// from "what is the current release" and diverges the first time a patch is cut
// on an older line.
//
// The comparison is done here rather than handed to `git tag --sort=-v:refname`
// so that what counts as a release tag is stated rather than inherited: exactly
// `vMAJOR.MINOR.PATCH`, compared numerically per component. A tag in any other
// shape cannot win, so an annotation, a moved marker or a hand-written label
// dropped on the repo never silently becomes the thing the board measures.
//
// Pure logic plus a thin CLI, so the rule unit-tests with no git and no network.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** A release tag, and nothing else: `v1.2.3`. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/

/**
 * The release tags in a list, highest version first. Anything that is not
 * exactly `vMAJOR.MINOR.PATCH` is dropped rather than sorted to the bottom,
 * because a tag this cannot read is a tag it must not choose.
 */
export function releaseTagsByVersion(tags = []) {
  return tags
    .map((tag) => ({ tag, m: RELEASE_TAG.exec(String(tag).trim()) }))
    .filter(({ m }) => m !== null)
    .map(({ tag, m }) => ({ tag, parts: [Number(m[1]), Number(m[2]), Number(m[3])] }))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2])
    .map(({ tag }) => tag)
}

/**
 * Resolve what a run measures.
 *
 * Returns `{ ref, kind }`. `kind` is what the ref is, which the publishing side
 * needs: only a `tag` may be published, because only a tag has a changelog
 * entry and a release behind it.
 */
export function resolveMeasuredRef({ event, inputRef = '', sha = '', tags = [] } = {}) {
  const explicit = String(inputRef).trim()
  if (explicit !== '') {
    // A dispatch naming a ref is a deliberate re-measure, including of an old
    // tag after a bad release. It is taken verbatim, and its kind is read from
    // its shape so a re-measure of a tag still publishes.
    return { ref: explicit, kind: RELEASE_TAG.test(explicit) ? 'tag' : 'other' }
  }

  if (event === 'push') {
    if (String(sha).trim() === '') throw new Error('a push must name the sha it pushed')
    return { ref: String(sha).trim(), kind: 'sha' }
  }

  const [latest] = releaseTagsByVersion(tags)
  // No release yet is a real state for a fresh clone or a repo before its first
  // cut. Measuring main is the only useful answer, and it is not publishable,
  // so nothing is claimed that a release has not earned.
  if (latest === undefined) return { ref: 'main', kind: 'other' }
  return { ref: latest, kind: 'tag' }
}

function gitTags() {
  const out = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' })
  return out.split('\n').filter((line) => line.trim() !== '')
}

function main() {
  const event = process.env.EVENT ?? ''
  const resolved = resolveMeasuredRef({
    event,
    inputRef: process.env.INPUT_REF ?? '',
    sha: process.env.SHA ?? '',
    tags: gitTags(),
  })

  const commit = execFileSync('git', ['rev-parse', `${resolved.ref}^{commit}`], {
    encoding: 'utf8',
  }).trim()

  // The suite version is read at the measured ref, never from the working tree.
  // The job that writes the board checks out main because it commits back, so a
  // version read there would describe main and be stamped onto a board measured
  // from a tag.
  const pkg = execFileSync('git', ['show', `${resolved.ref}:package.json`], { encoding: 'utf8' })
  const version = JSON.parse(pkg).version

  const lines = [
    `ref=${resolved.ref}`,
    `kind=${resolved.kind}`,
    `commit=${commit}`,
    `version=${version}`,
  ]
  const out = process.env.GITHUB_OUTPUT
  if (out) appendFileSync(out, lines.join('\n') + '\n')
  for (const line of lines) console.log(line)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
