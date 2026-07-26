// Which results file a run writes, decided from the environment.
//
// Writing a published target file is opt-in: a run lands in results/<slug>.json
// only when CONFORMANCE_TARGET names the slug. With nothing set the run writes
// the reserved scratch slug, which is gitignored and never scored.
//
// This used to default to the ground-truth slug whenever DYNAMODB_ENDPOINT was
// unset, on the assumption that a bare run meant a deliberate real-AWS capture.
// But `npm test` with no environment at all is the most obvious command in the
// project and the first thing anyone types after cloning, and without AWS
// credentials every test errors - so the default quietly overwrote the tracked
// ground-truth baseline with a file full of failures, in a diff large enough
// that the damage was easy to miss. Replacing a published baseline should take
// more than the most obvious command in the project.

import { RESERVED_SLUGS } from './score.mjs'

/** The scratch slug. Reserved, gitignored, never scored or published. */
export const SCRATCH_TARGET = 'local'

if (!RESERVED_SLUGS.has(SCRATCH_TARGET)) {
  // Load-bearing: if the scratch slug ever stopped being reserved, an
  // unconfigured run would start publishing a target row of failures.
  throw new Error(`the scratch target "${SCRATCH_TARGET}" must be a reserved slug`)
}

/**
 * The results slug for a run. `env` is injectable so the rule can be tested
 * without mutating the real process environment.
 */
export function resultTargetFrom(env = process.env) {
  const named = env.CONFORMANCE_TARGET?.trim()
  return named || SCRATCH_TARGET
}
