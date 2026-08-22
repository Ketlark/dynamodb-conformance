import { cleanupAllTablesOnce, provisionDeclaredTables } from './helpers.js'
import { IndeterminateError, indeterminateFrom } from './indeterminate.js'
import {
  ABANDON_PROVISIONING_AFTER,
  clearIndeterminateMarker,
  noteProvisioningFailed,
  noteProvisioningSucceeded,
  provisioningAbandoned,
  recordRunLevel,
  stampIndeterminateMarker,
} from './indeterminate-sink.js'
import { clearObservedMarker } from './observation-sink.js'

// Provision the tables this test file declared.
//
// vitest 4 runs this beforeAll per test file, and it does not run at all for a
// file whose tests were all filtered out - which is what keeps an excluded
// axis from creating its tables. Both steps are guarded in src/helpers.ts:
// tables are memoised by name, the sweep separately so it stays one pass at
// run start. Final teardown runs once in src/global-teardown.ts.
beforeAll(async () => {
  try {
    // A target that has failed provisioning this many files running is
    // unreachable for this run, and the sidecar saying so was written by the
    // first of those failures. Attempting again cannot change the run's verdict
    // and costs another full retry budget, so the remaining files give up
    // immediately - see ABANDON_PROVISIONING_AFTER for why the retry is bounded
    // rather than removed.
    if (provisioningAbandoned()) {
      throw new IndeterminateError(
        'transport',
        `provisioning abandoned: ${ABANDON_PROVISIONING_AFTER} consecutive failed observations`,
      )
    }
    await cleanupAllTablesOnce()
    await provisionDeclaredTables()
    noteProvisioningSucceeded()
  } catch (e: unknown) {
    // Vitest does not retry beforeAll, so a provisioning failure takes out the
    // whole run and no test ever executes to annotate itself. When the failure
    // is a failed observation (a slow region, a transport fault) rather than a
    // real answer, record it at run level so the run reads as "this region
    // produced nothing" instead of several hundred behavioural disagreements.
    const indeterminate = indeterminateFrom(e)
    if (indeterminate) {
      noteProvisioningFailed()
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
