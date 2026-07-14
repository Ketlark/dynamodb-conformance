#!/usr/bin/env node

/**
 * Delete orphaned `_conformance_` tables, per region, across the commercial
 * region set. A sweep that dies mid-flight strands tables in every region it
 * touched; this reaper finishes the cleanup the dead run could not.
 *
 * Idempotent and resumable: it selects from a fresh listing every time, so
 * running it twice is harmless and running it after a partial failure finishes
 * the job. Per region, so one unreachable region never blocks the others.
 *
 * The one thing it must never do is delete tables out from under a run still
 * in flight, so selection is age-based: every live run holds OIDC credentials
 * capped at two hours (role-duration-seconds: 7200 in the workflows), so no
 * legitimate `_conformance_` table can be older than its run's two-hour
 * ceiling. The three-hour default adds slack on top of that hard bound; do
 * not lower it below the credential ceiling.
 *
 * Tables without the `_conformance_` prefix are never touched, in any region,
 * under any condition - the same contract the IAM role enforces.
 *
 * Usage:
 *   node scripts/reap-orphans.mjs [--dry-run] [--max-age-hours N] [region ...]
 *
 * With no regions named it reaps the full commercial set (src/regions.ts).
 */

import {
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb'
import { COMMERCIAL_REGIONS } from '../src/regions.ts'

const TABLE_PREFIX = '_conformance_'

export const DEFAULT_MAX_AGE_HOURS = 3

/**
 * Pure selection: the table names safe to delete. A table qualifies only when
 * it carries the `_conformance_` prefix AND is provably older than the
 * threshold. A table whose age cannot be established is left alone - deleting
 * on missing evidence is how a reaper becomes an outage.
 */
export function selectOrphans(tables, { now = Date.now(), maxAgeMs }) {
  return tables
    .filter((t) => typeof t.name === 'string' && t.name.startsWith(TABLE_PREFIX))
    .filter((t) => {
      const created = t.creationDateTime ? new Date(t.creationDateTime).getTime() : NaN
      return Number.isFinite(created) && now - created > maxAgeMs
    })
    .map((t) => t.name)
    .sort()
}

/**
 * Run one region's reap via `reap`, isolating failures: a region that cannot
 * be reached is reported and skipped, never allowed to abort the others.
 */
export async function reapAll(regions, { reap }) {
  const reaped = {}
  const failures = []
  for (const region of regions) {
    try {
      reaped[region] = await reap(region)
    } catch (e) {
      failures.push({ region, message: e?.message ?? String(e) })
    }
  }
  return { reaped, failures }
}

async function reapRegion(region, { maxAgeMs, dryRun }) {
  const client = new DynamoDBClient({ region })
  try {
    const names = []
    let start
    do {
      const res = await client.send(
        new ListTablesCommand({ ExclusiveStartTableName: start }),
      )
      names.push(...(res.TableNames ?? []).filter((n) => n.startsWith(TABLE_PREFIX)))
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

    const orphans = selectOrphans(tables, { maxAgeMs })
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
  const args = { regions: [], maxAgeHours: DEFAULT_MAX_AGE_HOURS, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--max-age-hours') {
      args.maxAgeHours = Number(argv[++i])
      if (!Number.isFinite(args.maxAgeHours) || args.maxAgeHours <= 0) {
        throw new Error('--max-age-hours needs a positive number')
      }
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else args.regions.push(a)
  }
  if (args.regions.length === 0) args.regions = [...COMMERCIAL_REGIONS]
  return args
}

/**
 * The run's exit verdict from its outcomes. An undeletable orphan always
 * fails the run: that is the reaper's real signal and a human must look.
 * Unreachable regions warn rather than fail - an opt-in region sits
 * unreachable until account enablement, and a daily red run for a region
 * that holds no tables teaches people to ignore the alarm - UNLESS every
 * region was unreachable, which means nothing was walked at all (broken
 * credentials or network) and silence would hide it.
 */
export function exitVerdict({ stuck, unreachable, regionCount }) {
  if (stuck > 0) return { code: 1, reason: `${stuck} undeletable orphan(s)`, warn: false }
  if (unreachable >= regionCount && regionCount > 0) {
    return { code: 1, reason: 'every region was unreachable: nothing was walked', warn: false }
  }
  // The whole alarm policy lives here: warn exactly when the run passes with
  // regions it could not walk, so main prints what the verdict says and
  // decides nothing.
  return { code: 0, reason: null, warn: unreachable > 0 }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const maxAgeMs = args.maxAgeHours * 60 * 60 * 1000
  const { reaped, failures } = await reapAll(args.regions, {
    reap: (region) => reapRegion(region, { maxAgeMs, dryRun: args.dryRun }),
  })

  let strays = 0
  let stuck = 0
  for (const [region, { deleted, failed }] of Object.entries(reaped)) {
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
  console.log(
    `${args.regions.length} region(s): ${strays} orphan(s) ${args.dryRun ? 'found' : 'deleted'}, ` +
      `${stuck} undeletable, ${failures.length} region(s) unreachable`,
  )
  const verdict = exitVerdict({
    stuck,
    unreachable: failures.length,
    regionCount: args.regions.length,
  })
  if (verdict.warn) {
    console.log(
      `::warning title=Reaper::unreachable region(s) skipped: ${failures.map((f) => f.region).join(', ')}`,
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
