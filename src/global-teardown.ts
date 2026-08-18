import { cleanupAllTables } from './helpers.js'
import { clearStaleSidecar } from './indeterminate-sink.js'

// Runs once before any worker starts (vitest globalSetup). A sidecar left by a
// previous run's provisioning failure must not qualify this run's results, and
// clearing it here is what lets "no sidecar file" mean "nothing was absent"
// for the run that is about to execute. The sidecar itself is written from the
// worker process at the moment a run-level failure is recorded (see
// src/indeterminate-sink.ts): provisioning happens in a worker while this file
// runs in the main process, so state cannot be carried across in memory.
export async function setup(): Promise<void> {
  clearStaleSidecar()
}

// Runs once after the whole run (vitest globalSetup teardown), removing the
// shared tables that src/setup.ts now provisions once per run. cleanupAllTables
// deletes by this run's own namespace prefix, so it clears the shared tables
// (and any ad-hoc tables a test left behind) regardless of which worker created
// them, and reaches nothing belonging to another run.
export async function teardown(): Promise<void> {
  await cleanupAllTables()
}
