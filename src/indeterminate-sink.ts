// Carries indeterminacy out of the process and into the results artefacts.
//
// Two channels, because there are two blast radii:
//
// - Test level: an afterEach hook (src/setup.ts) stamps `task.meta.indeterminate`
//   on a test whose failure was a failed observation rather than a real answer.
//   Vitest's built-in JSON reporter serialises task.meta verbatim into
//   `assertionResults[].meta`, so the marker lands in `results/<slug>.json`
//   without changing the published file's shape at all.
//
// - Run level: the shared tables are provisioned once per run in a global
//   beforeAll, and Vitest does not retry beforeAll. If provisioning fails with
//   an indeterminate error, no test ever executes, so no test can annotate
//   itself - without this channel one slow region would present as several
//   hundred simultaneous behavioural disagreements. The sink records the
//   failure and writes a sidecar, `<results dir>/<slug>.indeterminate.json`,
//   next to the results file it qualifies. The sidecar is a new file, never a
//   modification to `results/<slug>.json`.
//
// The sidecar is written from the worker process as soon as the failure is
// recorded: provisioning happens in a test worker while global teardown runs
// in the main Vitest process, so in-memory state cannot cross that boundary.
// The stale sidecar from a previous run is cleared by the globalSetup phase
// (src/global-teardown.ts) before any worker starts, which is what makes "no
// sidecar file" mean "nothing was absent" for the run that just finished.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { indeterminateFrom, type IndeterminateReason } from './indeterminate.js'

// Typed shape for the test-level marker, merged into Vitest's TaskMeta so the
// annotation is not an untyped bag. The interface lives in @vitest/runner
// (vitest only re-exports it), so that is the module to augment.
declare module '@vitest/runner' {
  interface TaskMeta {
    indeterminate?: { reason: IndeterminateReason; at: 'test' }
  }
}

export interface RunLevelIndeterminate {
  reason: IndeterminateReason
  phase: 'provisioning'
  message: string
}

/**
 * The slug the run's results file is named for, mirroring vitest.config.ts so
 * the sidecar always pairs up with the results file it qualifies.
 */
export function resultSlug(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONFORMANCE_TARGET ?? (env.DYNAMODB_ENDPOINT ? 'local' : 'dynamodb')
}

/**
 * The directory the run's results are written to. Overridable so runs whose
 * output is routed elsewhere (a per-region ground-truth capture, an ad-hoc
 * local run) keep the sidecar next to their results file.
 */
export function resultsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONFORMANCE_RESULTS_DIR ?? 'results'
}

/** The sidecar path for a slug: `<dir>/<slug>.indeterminate.json`. */
export function sidecarPath(slug: string, dir: string): string {
  return join(dir, `${slug}.indeterminate.json`)
}

const recorded: RunLevelIndeterminate[] = []

/**
 * Record a run-level indeterminate failure and write the sidecar immediately.
 * Recording the same reason and phase twice (the guarded beforeAll retries
 * provisioning once per test file) keeps a single entry.
 */
export function recordRunLevel(
  entry: RunLevelIndeterminate,
  opts: { slug?: string; dir?: string } = {},
): void {
  const duplicate = recorded.some(
    (r) => r.reason === entry.reason && r.phase === entry.phase,
  )
  if (!duplicate) recorded.push(entry)

  const slug = opts.slug ?? resultSlug()
  const path = sidecarPath(slug, opts.dir ?? resultsDir())
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({ target: slug, runLevel: recorded }, null, 2) + '\n',
  )
}

/** Entries recorded so far in this process. */
export function recordedRunLevel(): readonly RunLevelIndeterminate[] {
  return recorded
}

/** Remove a previous run's sidecar. A clean run must leave no sidecar behind. */
export function clearStaleSidecar(opts: { slug?: string; dir?: string } = {}): void {
  rmSync(sidecarPath(opts.slug ?? resultSlug(), opts.dir ?? resultsDir()), {
    force: true,
  })
}

/** Test hook: reset the in-memory sink between unit tests. */
export function resetSinkForTesting(): void {
  recorded.length = 0
}

// ── Test-level marker hooks ─────────────────────────────────────────────────
// The bodies of the beforeEach/afterEach hooks installed by src/setup.ts,
// extracted so the attempt/retry semantics can be unit-tested without a
// running Vitest suite around them.

interface TaskLike {
  meta: { indeterminate?: { reason: IndeterminateReason; at: 'test' } }
  result?: { state?: string; errors?: unknown[] }
}

/**
 * Clear the marker at the start of every attempt. CONFORMANCE_RETRY is set on
 * the real-AWS job and task.meta lives on the task, not the attempt, so a
 * marker stamped on a failing first attempt would otherwise survive into a
 * passing retry - silently demoting a healthy test out of the denominator,
 * with nothing ever going red to say so.
 */
export function clearIndeterminateMarker(task: Pick<TaskLike, 'meta'>): void {
  delete task.meta.indeterminate
}

/**
 * Stamp the marker after an attempt whose failure was a failed observation.
 * Only the current attempt's error counts: the runner accumulates errors
 * across retries, so the last entry is this attempt's, and a retry that
 * failed for a real reason must not inherit an earlier attempt's
 * indeterminacy. A passing attempt is never stamped.
 */
export function stampIndeterminateMarker(task: TaskLike): void {
  if (task.result?.state !== 'fail') return
  const errors = task.result.errors ?? []
  const current = errors[errors.length - 1]
  const classified = indeterminateFrom(current)
  if (classified) {
    task.meta.indeterminate = { reason: classified.reason, at: 'test' }
  }
}
