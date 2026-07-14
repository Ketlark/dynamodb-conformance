import {
  createTable,
  cleanupAllTables,
  hashTableDef,
  hashNTableDef,
  hashBTableDef,
  gsiBTableDef,
  compositeTableDef,
  compositeNTableDef,
  compositeBTableDef,
} from './helpers.js'
import { indeterminateFrom } from './indeterminate.js'
import {
  clearIndeterminateMarker,
  recordRunLevel,
  stampIndeterminateMarker,
} from './indeterminate-sink.js'

// Provision the shared tables once per run.
//
// vitest 4 runs setupFiles' beforeAll for every test file (vitest 3's singleFork
// ran it once), so without this guard the suite deletes and recreates the
// shared tables ~once per file - ~100 times a run. That is slow, and on real AWS
// the churn of just-created tables surfaces as InternalServerException on the
// data operations that hit them. The single fork (maxWorkers: 1) means every
// file shares one process, so a process.env flag set after the first successful
// provision is seen by every later file. Final teardown runs once in
// src/global-teardown.ts.
beforeAll(async () => {
  if (process.env.CONFORMANCE_PROVISIONED === '1') return
  try {
    await cleanupAllTables()
    await Promise.all([
      createTable(hashTableDef),
      createTable(hashNTableDef),
      createTable(hashBTableDef),
      createTable(gsiBTableDef),
      createTable(compositeTableDef),
      createTable(compositeNTableDef),
      createTable(compositeBTableDef),
    ])
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
  // Set only after success, so a failed first attempt is retried by the next file.
  process.env.CONFORMANCE_PROVISIONED = '1'
}, 180_000)

// Clear the indeterminate marker at the start of every attempt. task.meta lives
// on the task, not the attempt, and the real-AWS job runs with retry enabled: a
// marker stamped on a failing first attempt would otherwise survive into a
// passing retry and silently demote a healthy test out of the denominator.
beforeEach((ctx) => {
  clearIndeterminateMarker(ctx.task)
})

// Stamp the marker when the attempt that just finished failed on a failed
// observation (timeout, retry-exhausted throttle, transport fault) rather than
// a real answer. The JSON reporter serialises task.meta into the results file,
// which is how the classifier later tells the two kinds of red apart.
afterEach((ctx) => {
  stampIndeterminateMarker(ctx.task)
})
