// Which table namespace a run owns, kept free of AWS imports so vitest.config.ts
// can resolve it before any worker spawns. See helpers.ts for how it is used.
//
// Two namespaces, one per identity, matching the split documented in
// scripts/cleanup-orphans.mjs and enforced by the IAM grants either side.
//
// The hazard is `cleanupAllTables`: it runs once per run, before anything is
// created, and deletes every table matching the prefix. There is no age gate and
// no record of which run owns what, so two runs sharing a prefix delete each
// other's tables mid-suite. CI serialises against itself through the
// `conformance-aws` concurrency group, but that group cannot see a laptop.
//
// CI keeps a stable prefix, so its pre-run sweep still clears tables stranded by
// a run that died. Nothing serialises local runs against each other, so a local
// run takes a prefix carrying a per-session segment: its sweep then matches only
// its own tables, whatever else is in flight on the account. The backstop for a
// local session that died before its teardown is cleanup-orphans.mjs, which
// sweeps that namespace by age on its own schedule.
//
// KNOWN_PREFIXES in that script is a hand-maintained allowlist guarding a
// DeleteTable it holds in every region, so it is deliberately not imported here.
// A namespace added below needs a reviewed edit there too.

export const CI_TABLE_PREFIX = '_conformance_'
export const LOCAL_TABLE_NAMESPACE = '_capture_'

/** The variable that pins a prefix explicitly, for CI and for parallel local runs. */
export const TABLE_PREFIX_ENV = 'CONFORMANCE_TABLE_PREFIX'

/**
 * A prefix unique to one local run, `_capture_<yyyymmdd>_<code>_`. The date makes
 * a stranded table readable in a console listing; the code is what keeps two
 * sessions on one account from sweeping each other.
 */
export function localSessionPrefix(
  now: Date = new Date(),
  rand: () => number = Math.random,
): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const code = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0')
  return `${LOCAL_TABLE_NAMESPACE}${day}_${code}_`
}

/**
 * Resolve the namespace this run writes into. An explicit prefix always wins;
 * otherwise CI takes the shared CI namespace and everything else takes a fresh
 * session prefix. The workflows set the variable outright rather than relying on
 * the inference, because CI is the side where guessing wrong costs a run.
 */
export function resolveTablePrefix(
  env: NodeJS.ProcessEnv = process.env,
  session: () => string = localSessionPrefix,
): string {
  const override = env[TABLE_PREFIX_ENV]
  if (override) return override
  return env.CI ? CI_TABLE_PREFIX : session()
}

/**
 * Resolve once and pin the answer into the environment, returning it.
 *
 * The pin is what makes a session prefix usable at all. Tests run in a worker
 * process and the teardown that sweeps them runs in the main one, so each would
 * otherwise mint its own code: the worker would create tables under one prefix
 * and the sweep would look for another, find nothing, and leave every table
 * standing. Resolving in vitest.config.ts, before any worker spawns, is what
 * gives both sides the same answer.
 */
export function pinTablePrefix(env: NodeJS.ProcessEnv = process.env): string {
  const prefix = resolveTablePrefix(env)
  env[TABLE_PREFIX_ENV] = prefix
  return prefix
}
