import { cleanupAllTablesOnce, provisionDeclaredTables } from './helpers.js'
import { indeterminateFrom } from './indeterminate.js'
import {
  clearIndeterminateMarker,
  recordRunLevel,
  stampIndeterminateMarker,
} from './indeterminate-sink.js'
import { clearObservedMarker } from './observation-sink.js'

// Provision the shared tables the selected test files asked for.
//
// vitest 4 runs setupFiles' beforeAll for every test file (vitest 3's singleFork
// ran it once), and each file's declarations only register when that file is
// imported, so this hook has to run per file to create what the newest file
// added. Both steps are idempotent across those runs, and each is guarded in
// src/helpers.ts for a different reason: tables are memoised by name, so a def
// forty files declare is created once rather than deleted and recreated ~100
// times a run; the sweep is memoised separately so it stays one pass at run
// start and never deletes tables a later file is still using. Final teardown
// runs once in src/global-teardown.ts.
beforeAll(async () => {
  try {
    await cleanupAllTablesOnce()
    await provisionDeclaredTables()
  } catch (e: unknown) {
    // Vitest does not retry beforeAll, so a provisioning failure takes out the
    // whole run and no test ever executes to annotate itself. When the failure
    // is a failed observation (a slow region, a transport fault) rather than a
    // real answer, record it at run level so the run reads as "this region
    // produced nothing" instead of several hundred behavioural disagreements.
    const indeterminate = indeterminateFrom(e)
    if (indeterminate) {
      recordRunLevel({
        reason: indeterminate.reason,
        phase: 'provisioning',
        message: indeterminate.message,
      })
    }
    throw e
  }
}, 180_000)

// Clear both task.meta markers at the start of every attempt. task.meta lives
// on the task, not the attempt, and the real-AWS job runs with retry enabled: a
// marker stamped on a failing first attempt would otherwise survive into a
// passing retry - an indeterminate marker silently demoting a healthy test out
// of the denominator, a stale observation misreporting what the retry saw.
beforeEach((ctx) => {
  clearIndeterminateMarker(ctx.task)
  clearObservedMarker(ctx.task)
})

// Stamp the marker when the attempt that just finished failed on a failed
// observation (timeout, retry-exhausted throttle, transport fault) rather than
// a real answer. The JSON reporter serialises task.meta into the results file,
// which is how the classifier later tells the two kinds of red apart.
afterEach((ctx) => {
  stampIndeterminateMarker(ctx.task)
})
