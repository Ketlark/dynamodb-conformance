// Carries a split test's actual answer out of the process and into the
// results artefact, the same channel src/indeterminate-sink.ts uses for
// failed observations: the test stamps `task.meta.observed`, Vitest's JSON
// reporter serialises task.meta verbatim into `assertionResults[].meta`, and
// the classifier (scripts/lib/classify.mjs) lifts it onto the verdict.
//
// Per-region scoring (scripts/lib/score.mjs) awards a region match only on
// evidence: a target that fails a committed split assertion has proven
// nothing beyond "not the pinned answer", and without a recorded observation
// the conservative reading keeps the fail in every region. This marker is
// that evidence. It records what the target actually answered, in the exact
// shape the split registry stores per-region answers
// (registry/splits.json: `{ outcome, error: { name, message } }` for a
// rejection, `{ outcome, detail }` for an acceptance), so
// `sameObservation` can compare the two directly.
//
// Only tests with a registry row benefit - `splitFor` returns null for
// everything else and the verdict stands as classified - so the marker is
// stamped by the handful of split tests, not suite-wide.

import { indeterminateFrom } from './indeterminate.js'

/** One answer, in the shape registry/splits.json records per region. */
export type Observation =
  | { outcome: 'accepted'; detail: string }
  | { outcome: 'rejected'; error: { name: string; message: string } }

// Merged into Vitest's TaskMeta alongside the indeterminate marker, so the
// annotation is not an untyped bag. The interface lives in @vitest/runner.
declare module '@vitest/runner' {
  interface TaskMeta {
    observed?: Observation
  }
}

interface TaskLike {
  meta: { observed?: Observation }
}

/**
 * Clear the marker at the start of every attempt (src/setup.ts), mirroring
 * the indeterminate marker: task.meta lives on the task, not the attempt, so
 * an observation stamped by a failing first attempt would otherwise survive
 * into a retry that never re-stamped it.
 */
export function clearObservedMarker(task: TaskLike): void {
  delete task.meta.observed
}

/**
 * Record the target's answer for the current test. The observation must
 * only claim what the test has verified: a detail string copied from a
 * registry row asserts that row's behaviour, so stamp it after the
 * assertion-relevant reads, not before.
 */
export function recordObserved(task: TaskLike, observation: Observation): void {
  task.meta.observed = observation
}

/**
 * Run one split operation, recording what the target actually answered
 * before the committed assertion gets a chance to throw. Transparent:
 * resolves and rejects exactly as `run` does, so it wraps the operation
 * inside an existing try/catch or expectDynamoError unchanged.
 *
 * A resolved call is recorded as accepted with `acceptedDetail` (default
 * "request accepted", which deliberately matches no registry row - record a
 * row's own detail only once its claim is verified, via recordObserved). A
 * rejection is recorded with the error's name and message. A failed
 * observation (timeout, exhausted throttle, transport fault - see
 * src/indeterminate.ts) is not an answer and records nothing; the
 * indeterminate machinery classifies the test out of the denominator and
 * scoring ignores the region question entirely.
 */
export async function observeSplit<T>(
  task: TaskLike,
  run: () => Promise<T>,
  acceptedDetail = 'request accepted',
): Promise<T> {
  try {
    const result = await run()
    recordObserved(task, { outcome: 'accepted', detail: acceptedDetail })
    return result
  } catch (e: unknown) {
    if (indeterminateFrom(e) === null) {
      const err = e as { name?: unknown; message?: unknown }
      recordObserved(task, {
        outcome: 'rejected',
        error: {
          name: typeof err?.name === 'string' ? err.name : String(err?.name),
          message: typeof err?.message === 'string' ? err.message : '',
        },
      })
    }
    throw e
  }
}
