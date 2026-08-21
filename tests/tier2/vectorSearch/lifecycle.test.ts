import { CreateTableCommand, SearchVectorsCommand, DynamoDBServiceException, type VectorIndex } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { region } from '../../../src/aws-config.js'
import { uniqueTableName, deleteTable } from '../../../src/helpers.js'
import { ceilingsFor } from '../../../src/regions.js'
import { IndeterminateError, indeterminateFrom } from '../../../src/indeterminate.js'
import {
  skipUnlessVectorIndexes,
  skipUnlessVectorSearch,
  describeVectorIndex,
  waitForVectorIndexActive,
} from '../../../src/vector.js'

// Vector index lifecycle on the CreateTable path, characterised against real
// DynamoDB in eu-west-2 (2026-08-11, issue #125). This path is quick (~15s
// to ACTIVE) and never reports the Backfilling field — that field only
// appears for indexes added via UpdateTable, whose creation runs on GSI-like
// timescales and lives in updateLifecycle.test.ts, in the slow lane.

const tablesToCleanup: string[] = []

function vix(over: Partial<VectorIndex> = {}): VectorIndex {
  return {
    IndexName: 'vix',
    VectorAttribute: { AttributeName: 'embedding' },
    Dimensions: 3,
    DistanceFunction: 'COSINE',
    Projection: { ProjectionType: 'ALL' },
    ...over,
  }
}

afterAll(async () => {
  await Promise.all(tablesToCleanup.map(deleteTable))
})

describe('CreateTable — vector index lifecycle', { tags: ['create-table', 'control-plane', 'vector'] }, () => {
  skipUnlessVectorIndexes()

  it('walks CREATING to ACTIVE and describes the index faithfully', async () => {
    const tableName = uniqueTableName('vec_life')
    tablesToCleanup.push(tableName)
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        VectorIndexes: [vix()],
      }),
    )

    // Collect every status the index reports on its way to ACTIVE: the walk
    // is CREATING -> ACTIVE with no BACKFILLING or UPDATING status value,
    // and the Backfilling field never appears on this creation path.
    const seenStatuses = new Set<string>()
    const deadline = Date.now() + ceilingsFor(region).tableActiveMs
    for (;;) {
      const ix = await describeVectorIndex(tableName, 'vix')
      if (ix?.IndexStatus) seenStatuses.add(ix.IndexStatus)
      expect(ix?.Backfilling).toBeUndefined()
      if (ix?.IndexStatus === 'ACTIVE') break
      if (Date.now() > deadline) {
        // A ceiling expiring is a failed observation, never a divergence.
        throw new IndeterminateError(
          'vector-index-timeout',
          `Vector index vix on ${tableName} never became ACTIVE within its ceiling`,
        )
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect([...seenStatuses].every((s) => s === 'CREATING' || s === 'ACTIVE')).toBe(true)

    const ix = (await describeVectorIndex(tableName, 'vix'))!
    expect(ix.IndexName).toBe('vix')
    expect(ix.Dimensions).toBe(3)
    expect(ix.DistanceFunction).toBe('COSINE')
    expect(ix.VectorAttribute?.AttributeName).toBe('embedding')
    expect(ix.Projection?.ProjectionType).toBe('ALL')
    expect(ix.IndexArn).toContain(`/index/vix`)
    expect(ix.ItemCount).toBe(0)
    expect(ix.IndexSizeBytes).toBe(0)
  }, 150_000)

  it('round-trips a SearchSchema of HASH and INLINE_FILTER elements', async () => {
    const tableName = uniqueTableName('vec_life')
    tablesToCleanup.push(tableName)
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'tenant', AttributeType: 'S' },
          { AttributeName: 'category', AttributeType: 'S' },
        ],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        VectorIndexes: [
          vix({
            SearchSchema: [
              { AttributeName: 'tenant', SearchSchemaElementType: 'HASH' },
              { AttributeName: 'category', SearchSchemaElementType: 'INLINE_FILTER' },
            ],
          }),
        ],
      }),
    )
    await waitForVectorIndexActive(tableName, 'vix')
    const ix = (await describeVectorIndex(tableName, 'vix'))!
    expect(ix.SearchSchema).toEqual([
      { AttributeName: 'tenant', SearchSchemaElementType: 'HASH' },
      { AttributeName: 'category', SearchSchemaElementType: 'INLINE_FILTER' },
    ])
  }, 150_000)

  it('accepts the 4096-dimension boundary', async () => {
    const tableName = uniqueTableName('vec_life')
    tablesToCleanup.push(tableName)
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        VectorIndexes: [vix({ Dimensions: 4096 })],
      }),
    )
    await waitForVectorIndexActive(tableName, 'vix')
    const ix = (await describeVectorIndex(tableName, 'vix'))!
    expect(ix.Dimensions).toBe(4096)
  }, 150_000)
})

describe('SearchVectors — index readiness after CreateTable', { tags: ['search-vectors', 'create-table', 'data-plane', 'vector'] }, () => {
  skipUnlessVectorSearch()

  // The readiness check AWS documents, run the way an application would run
  // it. DescribeTable reporting ACTIVE is where the guidance used to stop. It
  // now says SearchVectors is served by a separate endpoint that can begin
  // serving the index later, that the ValidationException answered in the
  // meantime is retryable rather than a failure, and that the check which
  // depends on neither status field is a real search in a retry loop whose
  // first successful response is the signal.
  //
  // The lag is documented as brief and variable, so nothing here asserts that
  // it happened: an index that serves its first search is ready and passes.
  // What is pinned is the shape of every rejection collected on the way,
  // because that is what decides whether "treat it as retryable" is safe
  // advice. A target answering ResourceNotFoundException instead - which is
  // what the API reference's error list implies for a resource whose status
  // is not ACTIVE - strands a caller following the documented loop, since a
  // not-found is the same answer it would get for a name that never existed.
  it('rejects retryably between ACTIVE and the first served search', async () => {
    const tableName = uniqueTableName('vec_ready')
    tablesToCleanup.push(tableName)
    await ddb.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        VectorIndexes: [vix()],
      }),
    )

    // Step one: poll the index's own status, not the table's. On this path
    // Backfilling is never reported, so IndexStatus alone carries the signal.
    await waitForVectorIndexActive(tableName, 'vix')
    const described = (await describeVectorIndex(tableName, 'vix'))!
    expect(described.IndexStatus).toBe('ACTIVE')
    expect(described.Backfilling).toBeUndefined()

    // Step two: prove it with a real search.
    const deadline = Date.now() + ceilingsFor(region).tableActiveMs
    for (;;) {
      let results: unknown[] | undefined
      try {
        const res = await ddb.send(
          new SearchVectorsCommand({
            TableName: tableName,
            IndexName: 'vix',
            SearchVector: [{ N: '1' }, { N: '0' }, { N: '0' }],
            TopK: 1,
          }),
        )
        results = res.SearchResults ?? []
      } catch (err) {
        // A throttle or transport fault mid-poll is a failed observation, not
        // an answer about readiness.
        const indeterminate = indeterminateFrom(err)
        if (indeterminate) throw indeterminate
        expect(err).toBeInstanceOf(DynamoDBServiceException)
        expect((err as DynamoDBServiceException).name).toBe('ValidationException')
        expect((err as DynamoDBServiceException).message).toMatch(
          /The table does not have the specified index: vix|Cannot search backfilling vector index: vix/,
        )
      }
      // Asserted outside the try, or a surprising answer would fall into the
      // catch and be reported as a rejection that failed to look like one.
      if (results !== undefined) {
        // A served index with nothing in it answers with no results, rather
        // than with the rejection an unserved one gives.
        expect(results).toEqual([])
        break
      }
      if (Date.now() > deadline) {
        throw new IndeterminateError(
          'vector-index-timeout',
          `Vector index vix on ${tableName} reported ACTIVE but never served a search`,
        )
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }, 300_000)
})
