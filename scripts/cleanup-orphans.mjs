#!/usr/bin/env node

/**
 * Delete orphaned test tables, per region, across the commercial region set. A
 * sweep that dies mid-flight strands tables in every region it touched; this
 * cleanup finishes the job the dead run could not.
 *
 * Idempotent and resumable: it selects from a fresh listing every time, so
 * running it twice is harmless and running it after a partial failure finishes
 * the job. Per region, so one unreachable region never blocks the others.
 *
 * Two prefixes exist, one per identity, and each is swept on its own schedule.
 * `_conformance_` is the CI role's namespace, torn down by prefix at the end
 * of every run. `_capture_` is the local capture identity's, named
 * `_capture_<yyyymmdd>_<short-code>_<name>` with the code unique per session
 * and torn down by exact name when the session ends. That split is the whole
 * point: a run's by-prefix cleanup can no longer delete an ad-hoc capture
 * session's tables out from under it. So this script sweeps only the prefixes
 * it is asked for, defaulting to `_conformance_` alone - widening the default
 * would hand back the race the split just removed.
 *
 * The one thing it must never do is delete tables out from under work still in
 * flight, so selection is age-based. On the `_conformance_` side that age is a
 * hard bound: a live run cannot outlive the OIDC credentials it holds, so no
 * legitimate table can be older than its run's credential ceiling. That
 * ceiling is the largest role-duration-seconds across the workflows - six
 * hours, set by the GSI lifecycle lane, whose backfills need it. The
 * seven-hour default adds slack on top; do not lower it below the credential
 * ceiling, and raise it whenever a lane raises role-duration-seconds past six
 * hours.
 *
 * Nothing binds a local capture session that way - it holds no OIDC
 * credentials and can in principle run all day. Seven hours stays the gate for
 * `_capture_` as a convention (no capture session should run that long), not
 * as a derived bound, and the exact-name teardown at session end is the real
 * cleanup. This sweep is only the backstop for a session that died first.
 *
 * A table carrying neither prefix is never touched, in any region, under any
 * condition - the same contract the IAM roles enforce.
 *
 * Usage:
 *   node scripts/cleanup-orphans.mjs [--dry-run] [--max-age-hours N]
 *                                    [--prefix P] [region ...]
 *
 * `--prefix` repeats, or takes a comma-separated list, and accepts only the
 * known prefixes. With no regions named it walks the full commercial set
 * (src/regions.ts).
 */

import {
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { COMMERCIAL_REGIONS } from '../src/regions.ts'

/**
 * Every prefix this cleanup may ever delete under. An allowlist rather than a
 * free-text option: the script holds DeleteTable in every commercial region,
 * so a typo'd or over-broad prefix is the one input that could turn it into an
 * outage. A new prefix is a deliberate edit here, reviewed alongside the IAM
 * grant that makes it deletable.
 */
export const KNOWN_PREFIXES = ['_conformance_', '_capture_']

export const DEFAULT_PREFIXES = ['_conformance_']

export const DEFAULT_MAX_AGE_HOURS = 7

/**
 * Pure selection: the table names safe to delete. A table qualifies only when
 * it carries one of the prefixes being swept AND is provably older than the
 * threshold. A table whose age cannot be established is left alone - deleting
 * on missing evidence is how a cleanup becomes an outage.
 */
export function selectOrphans(tables, { now = Date.now(), maxAgeMs, prefixes = DEFAULT_PREFIXES }) {
  return tables
    .filter((t) => typeof t.name === 'string' && prefixes.some((p) => t.name.startsWith(p)))
    .filter((t) => {
      const created = t.creationDateTime ? new Date(t.creationDateTime).getTime() : NaN
      return Number.isFinite(created) && now - created > maxAgeMs
    })
    .map((t) => t.name)
    .sort()
}

/**
 * Run one region's cleanup via `cleanup`, isolating failures: a region that cannot
 * be reached is reported and skipped, never allowed to abort the others.
 */
export async function cleanupAll(regions, { cleanup }) {
  const cleaned = {}
  const failures = []
  for (const region of regions) {
    try {
      cleaned[region] = await cleanup(region)
    } catch (e) {
      failures.push({ region, message: e?.message ?? String(e) })
    }
  }
  return { cleaned, failures }
}

async function cleanupRegion(region, { maxAgeMs, dryRun, prefixes }) {
  const client = new DynamoDBClient({ region })
  try {
    const names = []
    let start
    do {
      const res = await client.send(
        new ListTablesCommand({ ExclusiveStartTableName: start }),
      )
      names.push(...(res.TableNames ?? []).filter((n) => prefixes.some((p) => n.startsWith(p))))
      start = res.LastEvaluatedTableName
    } while (start)

    const tables = []
    for (const name of names) {
      try {
        const res = await client.send(new DescribeTableCommand({ TableName: name }))
        tables.push({ name, creationDateTime: res.Table?.CreationDateTime })
      } catch (e) {
        // Already gone between the listing and now: someone else's cleanup won.
        if (e?.name !== 'ResourceNotFoundException') throw e
      }
    }

    const orphans = selectOrphans(tables, { maxAgeMs, prefixes })
    const deleted = []
    const failed = []
    for (const name of orphans) {
      if (dryRun) {
        deleted.push(name)
        continue
      }
      try {
        await client.send(new DeleteTableCommand({ TableName: name }))
        deleted.push(name)
      } catch (e) {
        if (e?.name === 'ResourceNotFoundException') deleted.push(name)
        // e.g. deletion protection someone enabled and never removed: record
        // it and keep going, so one stubborn table doesn't shield the rest.
        else failed.push({ name, message: e?.message ?? String(e) })
      }
    }
    return { deleted, failed }
  } finally {
    client.destroy()
  }
}

export function parseArgs(argv) {
  const args = { regions: [], prefixes: [], maxAgeHours: DEFAULT_MAX_AGE_HOURS, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--max-age-hours') {
      args.maxAgeHours = Number(argv[++i])
      if (!Number.isFinite(args.maxAgeHours) || args.maxAgeHours <= 0) {
        throw new Error('--max-age-hours needs a positive number')
      }
    } else if (a === '--prefix') {
      const named = (argv[++i] ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      if (named.length === 0) throw new Error('--prefix needs at least one prefix')
      for (const prefix of named) {
        if (!KNOWN_PREFIXES.includes(prefix)) {
          throw new Error(`unknown prefix ${prefix}; expected one of ${KNOWN_PREFIXES.join(', ')}`)
        }
        if (!args.prefixes.includes(prefix)) args.prefixes.push(prefix)
      }
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else args.regions.push(a)
  }
  if (args.regions.length === 0) args.regions = [...COMMERCIAL_REGIONS]
  if (args.prefixes.length === 0) args.prefixes = [...DEFAULT_PREFIXES]
  return args
}

/**
 * The run's exit verdict from its outcomes. An undeletable orphan always
 * fails the run: that is the cleanup's real signal and a human must look. A
 * minority of unreachable regions warns rather than fails - an opt-in region
 * sits unreachable until account enablement, and a daily red run for a
 * region that holds no tables teaches people to ignore the alarm. A MAJORITY
 * unreachable is not a regional condition; it is broken credentials, a
 * policy change, or a network fault, and silence would hide it. A single
 * region that stays persistently unreachable is not this module's alarm to
 * raise: it also fails its weekly sweeps, and two consecutive misses drop
 * and page it through the sweep's own channel (scripts/lib/observed.mjs).
 */
export function exitVerdict({ stuck, unreachable, regionCount }) {
  if (stuck > 0) return { code: 1, reason: `${stuck} undeletable orphan(s)`, warn: false }
  if (unreachable * 2 > regionCount) {
    return {
      code: 1,
      reason: `${unreachable} of ${regionCount} region(s) unreachable: systemic, not regional`,
      warn: false,
    }
  }
  // The whole alarm policy lives here: warn exactly when the run passes with
  // regions it could not walk, so main prints what the verdict says and
  // decides nothing.
  return { code: 0, reason: null, warn: unreachable > 0 }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const maxAgeMs = args.maxAgeHours * 60 * 60 * 1000
  const { cleaned, failures } = await cleanupAll(args.regions, {
    cleanup: (region) =>
      cleanupRegion(region, { maxAgeMs, dryRun: args.dryRun, prefixes: args.prefixes }),
  })

  let strays = 0
  let stuck = 0
  for (const [region, { deleted, failed }] of Object.entries(cleaned)) {
    strays += deleted.length
    stuck += failed.length
    for (const name of deleted) {
      console.log(`${region}: ${args.dryRun ? 'would delete' : 'deleted'} ${name}`)
    }
    for (const { name, message } of failed) {
      console.error(`${region}: could not delete ${name}: ${message}`)
    }
  }
  for (const { region, message } of failures) {
    console.error(`${region}: unreachable, skipped: ${message}`)
  }
  // The prefixes are named in the summary because two cleanup runs a day now
  // land in the same workflow's history, and the count alone cannot tell you
  // which namespace a given run walked.
  console.log(
    `${args.prefixes.join(', ')} in ${args.regions.length} region(s): ` +
      `${strays} orphan(s) ${args.dryRun ? 'found' : 'deleted'}, ` +
      `${stuck} undeletable, ${failures.length} region(s) unreachable`,
  )
  const verdict = exitVerdict({
    stuck,
    unreachable: failures.length,
    regionCount: args.regions.length,
  })
  if (verdict.warn) {
    console.log(
      `::warning title=Orphan cleanup::unreachable region(s) skipped: ${failures.map((f) => f.region).join(', ')}`,
    )
  }
  if (verdict.code !== 0) {
    console.error(verdict.reason)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
