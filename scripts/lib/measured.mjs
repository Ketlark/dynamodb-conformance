// What a published board was measured from, and where its grading inputs come.
//
// The board reports figures measured against a released suite. The jobs that
// write the board check out main, because they commit back, so nothing about
// the measurement can be read from their own tree: a version read there
// describes main, and a manifest read there is a denominator main happens to
// have rather than the one the suite was graded against. Both arrive from the
// measuring run instead, and this module is what reads and checks them.
//
// Three inputs, split by what they are:
//
//   registry/suite-manifest.json  measured ref   it is the denominator
//   registry/splits.json          measured ref   per-region expectations
//   registry/regions.json         main           live operational state
//
// The third is the odd one deliberately. Region health says which regions are
// answering now; a region that stopped yesterday is a fact about today, not
// about the tag, so it is read from the publisher's own checkout and is the
// only grading input allowed to move under a board without a new measurement.
//
// Pure logic plus thin readers, so the rules unit-test with no git and no CI.

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Every field a measurement identity must carry to be usable. */
export const MEASURED_FIELDS = ['ref', 'kind', 'commit', 'version', 'region', 'measuredAt']

/**
 * Check a measurement identity. Returns it when whole, throws otherwise.
 *
 * Partial is refused rather than filled in: a board stamped with half an
 * identity claims a measurement nobody can locate, which is worse than a board
 * that claims nothing.
 */
export function validateMeasured(measured) {
  if (measured === null || typeof measured !== 'object') {
    throw new Error('measured suite identity: expected an object')
  }
  const missing = MEASURED_FIELDS.filter(
    (f) => typeof measured[f] !== 'string' || measured[f].trim() === '',
  )
  if (missing.length > 0) {
    throw new Error(`measured suite identity is incomplete: missing ${missing.join(', ')}`)
  }
  return measured
}

/**
 * The identity a board already carries, or null when it carries none.
 *
 * A board written before this field existed reads as null rather than throwing,
 * so an older summary still loads.
 */
export function measuredOf(summary) {
  const suite = summary?.suite
  if (suite === null || suite === undefined) return null
  return validateMeasured(suite)
}

/**
 * Read a measuring run's artefact directory: the identity plus the two
 * suite-definition files as they stood at the measured ref.
 *
 * An identity with no registry files beside it is refused. The two travel
 * together or the board is graded against one suite and stamped with another,
 * which is the failure this whole mechanism exists to prevent.
 */
export function readMeasuredDir(dir) {
  const identityPath = join(dir, 'suite.json')
  if (!existsSync(identityPath)) {
    throw new Error(`no measured suite identity at ${identityPath}`)
  }
  const measured = validateMeasured(JSON.parse(readFileSync(identityPath, 'utf8')))

  const manifestPath = join(dir, 'suite-manifest.json')
  const splitsPath = join(dir, 'splits.json')
  for (const [what, path] of [
    ['suite manifest', manifestPath],
    ['split registry', splitsPath],
  ]) {
    if (!existsSync(path)) {
      throw new Error(
        `measured suite identity at ${identityPath} has no ${what} beside it (${path}). ` +
          'The identity and the suite definition it describes must travel together.',
      )
    }
  }

  return {
    measured,
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    registry: JSON.parse(readFileSync(splitsPath, 'utf8')),
  }
}

/**
 * The grading inputs for a board that already carries an identity, read out of
 * git at that identity's ref.
 *
 * This is the rebuild path: a run that recomputes an existing measurement
 * because region health moved, with no measuring run behind it and so no
 * artefact to read. It must not fall back to the working tree, and it must not
 * use whatever ref the caller happens to have resolved, which can be newer than
 * the board's. Health is the only input a rebuild is allowed to move.
 */
export function gradingInputsAtRef(ref, { git = gitShow } = {}) {
  const read = (path) => {
    try {
      return JSON.parse(git(`${ref}:${path}`))
    } catch (cause) {
      throw new Error(
        `cannot read ${path} at ${ref}, which the committed board names as its measured ref. ` +
          'Refusing to fall back to the working tree.',
        { cause },
      )
    }
  }
  return {
    manifest: read('registry/suite-manifest.json'),
    registry: read('registry/splits.json'),
  }
}

function gitShow(spec) {
  return execFileSync('git', ['show', spec], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}
