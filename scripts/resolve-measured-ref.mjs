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
//   an explicit ref input      -> that ref, verbatim
//   a schedule or a dispatch   -> the latest release tag (measurement)
//   any other event            -> the sha that triggered it (validation)
//   no release tags at all     -> main
//
// The event list is closed, not open. An earlier version tested for `push` and
// let everything else fall through to the tag, which sent every pull request to
// the released suite instead of the branch under review.
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
 * A release tag's version components, or null when it is not one.
 *
 * The single statement of what a release tag is. scripts/release.mjs reads it
 * too: a version that script accepts has to produce a tag this one can choose,
 * so the two agreeing is a dependency rather than a comment asking them to.
 */
export function releaseTagParts(tag) {
  const m = RELEASE_TAG.exec(String(tag).trim())
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * The release tags in a list, highest version first. Anything that is not
 * exactly `vMAJOR.MINOR.PATCH` is dropped rather than sorted to the bottom,
 * because a tag this cannot read is a tag it must not choose.
 */
export function releaseTagsByVersion(tags = []) {
  return tags
    .map((tag) => ({ tag, parts: releaseTagParts(tag) }))
    .filter(({ parts }) => parts !== null)
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
    // tag after a bad release. It is taken verbatim. Its kind is provisional
    // here - the shape of a string is not proof a tag exists, so the publisher
    // re-derives it from git before trusting it.
    return { ref: explicit, kind: RELEASE_TAG.test(explicit) ? 'tag' : 'other' }
  }

  // Only a schedule or a dispatch measures a release. Everything else measures
  // what triggered it, and the list is closed rather than open: an earlier
  // version tested for `push` and let everything else fall through to the tag,
  // which sent every pull request's jobs to the released suite instead of the
  // branch under review. A PR that added a conformance test would have run the
  // old tests and passed. Anything not named here measures its own sha.
  if (event !== 'schedule' && event !== 'workflow_dispatch') {
    if (String(sha).trim() === '') throw new Error(`${event || 'this event'} must name the sha it triggered on`)
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

/**
 * Whether a ref really is a release tag, asked of git rather than of the
 * string's shape.
 *
 * `resolveMeasuredRef` can only pattern-match what it was handed, so a branch
 * named `v9.9.9` comes back as `kind: 'tag'`. Publishing is gated on that
 * field, so the claim has to be proven: the tag must exist under refs/tags and
 * resolve to the same commit the run measured. This runs where the tags are -
 * the resolver checks out with full depth - so nothing downstream has to fetch
 * to re-check it.
 */
export function confirmTagKind(ref, commit, { git = gitRevParse } = {}) {
  if (!RELEASE_TAG.test(ref)) return 'other'
  try {
    return git(`refs/tags/${ref}^{commit}`) === commit ? 'tag' : 'other'
  } catch {
    return 'other'
  }
}

function gitRevParse(spec) {
  return execFileSync('git', ['rev-parse', '--verify', '--quiet', spec], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
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

  // The provisional kind is a guess about a string; this is the answer from git.
  // Only a claimed tag needs confirming - a sha is already what it says it is.
  const kind = resolved.kind === 'tag' ? confirmTagKind(resolved.ref, commit) : resolved.kind

  // The suite version is read at the measured ref, never from the working tree.
  // The job that writes the board checks out main because it commits back, so a
  // version read there would describe main and be stamped onto a board measured
  // from a tag.
  const pkg = execFileSync('git', ['show', `${resolved.ref}:package.json`], { encoding: 'utf8' })
  const version = JSON.parse(pkg).version

  const lines = [
    `ref=${resolved.ref}`,
    `kind=${kind}`,
    `commit=${commit}`,
    `version=${version}`,
  ]
  const out = process.env.GITHUB_OUTPUT
  if (out) appendFileSync(out, lines.join('\n') + '\n')
  for (const line of lines) console.log(line)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
