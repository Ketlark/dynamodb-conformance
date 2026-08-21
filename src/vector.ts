// Vector search support: per-plane feature probes and index-aware waiters.
//
// Vector search spans two planes with independent implementation surfaces: a
// target can parse `VectorIndexes` on CreateTable without implementing
// SearchVectors, or vice versa. Each plane therefore gets its own probe, and
// the tests for each plane gate on the probe for what they actually exercise.
// A single shared probe would mis-score a target that implements one side
// only.
//
// The waiters follow the shape of waitUntilActive / waitForGsiConsistency in
// helpers.ts: a ceiling expiring is an IndeterminateError (a failed
// observation), never a divergence.
//
// The readiness contract they implement - poll DescribeTable until IndexStatus
// is ACTIVE and Backfilling is not true, then prove it with a real search in a
// retry loop - is what AWS documents, as of the corrections it made to the
// vector search pages on 2026-08-20. Those followed
// https://martinhicks.dev/articles/dynamodb-vector-search-docs-get-wrong, which
// set out three problems in the previous guidance from this suite's
// measurements. captures/2026-08-21-vector-readiness-docs.json records what the
// pages said before and after, quote by quote.

import {
  CreateTableCommand,
  SearchVectorsCommand,
  DescribeTableCommand,
  DynamoDBServiceException,
  type AttributeValue,
  type VectorIndexDescription,
} from '@aws-sdk/client-dynamodb'
import { ddb } from './client.js'
import { region } from './aws-config.js'
import { uniqueTableName, absentTableName, waitUntilActive, deleteTable } from './helpers.js'
import { IndeterminateError } from './indeterminate.js'
import { isUnsupportedFault } from './unsupported.js'
import { supportsControlPlaneOp } from './infra.js'
import { ceilingsFor } from './regions.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Data-plane probe: SearchVectors ─────────────────────────────────────────

/**
 * Probe input for SearchVectors: a table that cannot exist (this run's own
 * namespace plus a name no test creates). Real AWS answers
 * ResourceNotFoundException — a real error, so the operation counts as
 * implemented. A target without the operation answers an unsupported fault.
 *
 * The namespace matters against real AWS: a name outside it is refused by IAM
 * before DynamoDB can answer that the table is missing, and the probe would
 * read an AccessDeniedException as the operation being unimplemented.
 */
const SEARCH_PROBE_INPUT = {
  TableName: absentTableName('no_such_table_probe'),
  IndexName: 'no-such-index',
  SearchVector: [{ N: '1' }, { N: '0' }, { N: '0' }] as AttributeValue[],
  TopK: 1,
}

let searchVectorsSupport: boolean | undefined

/** Whether the target implements the SearchVectors operation. Memoised. */
export async function supportsSearchVectors(): Promise<boolean> {
  if (searchVectorsSupport === undefined) {
    searchVectorsSupport = await supportsControlPlaneOp(() =>
      ddb.send(new SearchVectorsCommand(SEARCH_PROBE_INPUT)),
    )
  }
  return searchVectorsSupport
}

/**
 * Feature-probe skip for describe blocks exercising the data plane of vector
 * search (SearchVectors itself, writes judged through an index, capacity
 * shapes).
 */
export function skipUnlessSearchVectors(): void {
  let supported = true
  beforeAll(async () => {
    supported = await supportsSearchVectors()
  })
  beforeEach(({ skip }) => {
    if (!supported) skip()
  })
}

// ── Control-plane probe: CreateTable with VectorIndexes ─────────────────────

let vectorIndexesSupport: boolean | undefined

/**
 * Whether the target implements vector indexes on the control plane. Memoised
 * across the run because the probe provisions a real table.
 *
 * Support means CreateTable accepts `VectorIndexes` AND DescribeTable reflects
 * the index back. The reflection check is what separates "implemented" from
 * "parsed and discarded": a target that accepts the parameter but drops it has
 * not implemented the surface, and counting that as implemented would convert
 * absent support into divergence on every lifecycle assertion. Recording it as
 * scope (skip) instead is deliberate lenience, mirroring how an unsupported
 * fault is treated.
 */
export async function supportsVectorIndexes(): Promise<boolean> {
  if (vectorIndexesSupport !== undefined) return vectorIndexesSupport
  const name = uniqueTableName('vector_probe')
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: name,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        VectorIndexes: [
          {
            IndexName: 'probe-index',
            VectorAttribute: { AttributeName: 'embedding' },
            Dimensions: 3,
            DistanceFunction: 'COSINE',
            Projection: { ProjectionType: 'KEYS_ONLY' },
          },
        ],
      }),
    )
    const described = await ddb.send(new DescribeTableCommand({ TableName: name }))
    vectorIndexesSupport =
      (described.Table?.VectorIndexes ?? []).some((ix) => ix.IndexName === 'probe-index')
  } catch (e) {
    if (isUnsupportedFault(e)) {
      vectorIndexesSupport = false
    } else if (e instanceof DynamoDBServiceException && e.name === 'ValidationException') {
      // The probe's arguments are verified valid against real AWS, so a
      // ValidationException here is a target rejecting a parameter it does
      // not model. Lenience wins: absent support is scope, not divergence.
      vectorIndexesSupport = false
    } else {
      // Anything else (throttle, transport, access) is not an answer about
      // support. Err on "supported" so a transient hiccup cannot silently
      // skip the family; the tests' own classification handles the rest.
      vectorIndexesSupport = true
    }
  } finally {
    // The probe table may still be CREATING, where DeleteTable answers
    // ResourceInUseException and deleteTable's swallow would quietly leave
    // the table behind until the next run's sweep. Wait for ACTIVE first;
    // both steps are best-effort — cleanup must never fail the probe.
    await waitUntilActive(name).catch(() => {})
    await deleteTable(name).catch(() => {})
  }
  return vectorIndexesSupport
}

/**
 * Feature-probe skip for describe blocks exercising the control plane of
 * vector search (CreateTable/UpdateTable index lifecycle, DescribeTable
 * output, create-time validation).
 */
export function skipUnlessVectorIndexes(): void {
  let supported = true
  beforeAll(async () => {
    supported = await supportsVectorIndexes()
  })
  beforeEach(({ skip }) => {
    if (!supported) skip()
  })
}

// ── Combined gate ───────────────────────────────────────────────────────────

/**
 * Whether the target implements both planes. Files whose data-plane tests
 * must first PROVISION a vector-indexed table depend on both: a target with
 * SearchVectors but no CreateTable-with-VectorIndexes would otherwise fail
 * table creation in beforeAll — divergence — when the honest answer is scope.
 */
export async function supportsVectorSearch(): Promise<boolean> {
  return (await supportsSearchVectors()) && (await supportsVectorIndexes())
}

/**
 * Feature-probe skip for describe blocks that provision a vector-indexed
 * table and exercise it through the data plane.
 */
export function skipUnlessVectorSearch(): void {
  let supported = true
  beforeAll(async () => {
    supported = await supportsVectorSearch()
  })
  beforeEach(({ skip }) => {
    if (!supported) skip()
  })
}

// ── Waiters ─────────────────────────────────────────────────────────────────

/** Find one index's description on a table, or undefined. */
export async function describeVectorIndex(
  tableName: string,
  indexName: string,
): Promise<VectorIndexDescription | undefined> {
  const res = await ddb.send(new DescribeTableCommand({ TableName: tableName }))
  return (res.Table?.VectorIndexes ?? []).find((ix) => ix.IndexName === indexName)
}

/**
 * Wait until a vector index is ACTIVE and done backfilling.
 *
 * The predicate is `IndexStatus === 'ACTIVE' && Backfilling !== true`, which is
 * the check AWS documents: "wait until IndexStatus is ACTIVE and Backfilling is
 * not true before you search". The `!== true` carries the whole thing.
 * `Backfilling` is a CREATING-time field that disappears rather than settling
 * to false, and it is never reported at all for an index created with its
 * table, so the same check written as `Backfilling === false` never fires on
 * either path.
 *
 * ACTIVE is necessary and not sufficient. SearchVectors is served by a separate
 * endpoint that can lag behind DescribeTable, so anything that goes on to
 * search wants waitForVectorIndexSearchable instead.
 */
export async function waitForVectorIndexActive(
  tableName: string,
  indexName: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? ceilingsFor(region).tableActiveMs
  const start = Date.now()
  let delay = 0
  while (Date.now() - start < timeoutMs) {
    const ix = await describeVectorIndex(tableName, indexName)
    if (ix?.IndexStatus === 'ACTIVE' && ix.Backfilling !== true) return
    if (delay > 0) await sleep(delay)
    // Grows: `delay || 500` re-evaluated to 500 on every pass, so this polled
    // at a flat 500ms and the 2000ms ceiling was unreachable.
    delay = delay === 0 ? 500 : Math.min(delay * 2, 2000)
  }
  throw new IndeterminateError(
    'vector-index-timeout',
    `Timeout waiting for vector index ${indexName} on ${tableName} to become ACTIVE`,
  )
}

/**
 * The two rejections AWS documents for a vector index that is not yet serving
 * searches: one for the window before the index resolves, one for the backfill
 * itself. The troubleshooting guide names both, says to treat a
 * ValidationException as retryable during index creation, and names the first
 * again for the interval after IndexStatus turns ACTIVE while the dedicated
 * search endpoint is still catching up.
 *
 * Deliberately narrow. A retry loop that absorbed every ValidationException
 * would bury a genuinely malformed request under a readiness timeout, so
 * anything outside these two is rethrown as the answer it is.
 */
function isVectorIndexNotReady(err: unknown, indexName: string): boolean {
  if (!(err instanceof DynamoDBServiceException)) return false
  if (err.name !== 'ValidationException') return false
  return (
    err.message.includes(`The table does not have the specified index: ${indexName}`) ||
    err.message.includes(`Cannot search backfilling vector index: ${indexName}`)
  )
}

/**
 * The readiness check AWS documents, end to end: poll DescribeTable until the
 * index is ACTIVE and not backfilling, then prove the search endpoint agrees by
 * issuing a real SearchVectors in a retry loop and taking the first successful
 * response as the signal.
 *
 * Both halves are needed. The status fields alone are not enough — DescribeTable
 * and SearchVectors are served by different endpoints, and the search one can
 * begin serving the index a beat after the description says ACTIVE — and a
 * search alone would spend the whole backfill collecting rejections it could
 * have waited out. A fixture that asserts anything about a search wants this
 * rather than waitForVectorIndexActive, or its first assertion races the lag and
 * reads a readiness rejection as the answer to whatever it asked.
 *
 * The probe search must be shaped for the index it probes: a vector of the right
 * dimensions, and the partition key value if the search schema declares one.
 * Neither is guessable from here, and a malformed probe rejects for a reason the
 * loop is right not to swallow.
 */
export async function waitForVectorIndexSearchable(opts: {
  tableName: string
  indexName: string
  searchVector: AttributeValue[]
  searchConditionExpression?: string
  expressionAttributeValues?: Record<string, AttributeValue>
  timeoutMs?: number
}): Promise<void> {
  // Both halves wait on index readiness, so both take the table-active ceiling.
  // The consistency ceiling waitForVectorSearchable defaults to is sized for
  // item visibility on a serving index, which is not what is being waited on.
  const timeoutMs = opts.timeoutMs ?? ceilingsFor(region).tableActiveMs
  await waitForVectorIndexActive(opts.tableName, opts.indexName, { timeoutMs })
  try {
    await waitForVectorSearchable({ ...opts, expectedCount: 0, timeoutMs })
  } catch (err) {
    if (err instanceof IndeterminateError) {
      // Re-typed: nothing here waits on item visibility, so a consistency
      // reason would name the wrong thing. The index reached ACTIVE and then
      // never served a search.
      throw new IndeterminateError(
        'vector-index-timeout',
        `Vector index ${opts.indexName} on ${opts.tableName} became ACTIVE but never served a search`,
        { cause: err },
      )
    }
    throw err
  }
}

/**
 * Wait until a search returns the expected number of results — the vector
 * index is eventually consistent with no documented visibility bound, so a
 * test must hold positive evidence that the index has caught up before it
 * asserts anything about search results (especially an absence).
 *
 * An expectedCount of 0 makes this the documented readiness loop on its own:
 * the first response that comes back at all ends the wait.
 */
export async function waitForVectorSearchable(opts: {
  tableName: string
  indexName: string
  searchVector: AttributeValue[]
  expectedCount: number
  searchConditionExpression?: string
  expressionAttributeValues?: Record<string, AttributeValue>
  timeoutMs?: number
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? ceilingsFor(region).gsiConsistencyMs
  const start = Date.now()
  let delay = 0
  while (Date.now() - start < timeoutMs) {
    let found: number | undefined
    try {
      const res = await ddb.send(
        new SearchVectorsCommand({
          TableName: opts.tableName,
          IndexName: opts.indexName,
          SearchVector: opts.searchVector,
          TopK: Math.max(opts.expectedCount, 1),
          SearchConditionExpression: opts.searchConditionExpression,
          ExpressionAttributeValues: opts.expressionAttributeValues,
        }),
      )
      found = (res.SearchResults ?? []).length
    } catch (err) {
      // Documented: after DescribeTable first reports ACTIVE, the dedicated
      // search endpoint can need longer before it serves the index, and
      // SearchVectors answers ValidationException for that interval. AWS's own
      // advice is to treat it as retryable and let the first successful
      // response be the readiness signal, so the loop absorbs exactly those two
      // rejections and rethrows every other answer.
      if (!isVectorIndexNotReady(err, opts.indexName)) throw err
    }
    if (found !== undefined && found >= opts.expectedCount) return
    if (delay > 0) await sleep(delay)
    // Grows: `delay || 500` re-evaluated to 500 on every pass, so this polled
    // at a flat 500ms and the 2000ms ceiling was unreachable.
    delay = delay === 0 ? 500 : Math.min(delay * 2, 2000)
  }
  throw new IndeterminateError(
    'vector-consistency-timeout',
    `Timeout waiting for vector index ${opts.indexName} on ${opts.tableName} to reflect ${opts.expectedCount} item(s)`,
  )
}
