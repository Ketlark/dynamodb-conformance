// The tracked-file namespace, shared by the guards that assert properties of
// everything this repository publishes. Both of them enumerate the same set and
// both decode it as UTF-8, so the binary-asset exclusion has to be one
// definition: two copies drifting apart would leave one guard quietly decoding
// a woff2 as text, or the other quietly skipping a source file.

import { execFileSync } from 'node:child_process'

/**
 * Every path git tracks, repo-relative. Reads the index rather than walking the
 * worktree, so a file staged for deletion still appears and an untracked scratch
 * file never does - the guards are about what gets published, not what is lying
 * around locally.
 */
export function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

/**
 * The one class of genuinely binary asset this repository tracks: the site's
 * vendored fonts and its images. Scoped to those two directories on purpose, so
 * the guards still fire on a binary anywhere it has no business being - a stray
 * archive in scripts/, a corrupted results file, a source file that picked up a
 * NUL byte. Adding an image or a font weight needs no edit here; adding a binary
 * somewhere else is meant to be a conversation.
 */
export const BINARY_ASSETS =
  /^site\/src\/(fonts|images)\/[^/]+\.(woff2?|png|jpe?g|gif|ico|webp|avif|svgz)$/
