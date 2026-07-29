import { PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  declareTables,
  compositeIndexedTableDef,
  cleanupItems,
  waitForGsiConsistency,
} from '../../../src/helpers.js'

declareTables(compositeIndexedTableDef)

// ReturnConsumedCapacity: 'INDEXES' only has more to say than TOTAL when the read
// is actually served by a secondary index, so these query `gsi1` and assert the
// GlobalSecondaryIndexes arm itself. The base table's own consumption is reported
// separately under Table, and the aggregate is the sum of the two. The
// aggregate-only side of ConsumedCapacity lives in
// tests/tier1/getItem/consumedCapacity.test.ts and
// tests/tier1/putItem/consumedCapacity.test.ts.
describe('ConsumedCapacity — INDEXES on a secondary-index Query', { tags: ['query', 'data-plane', 'gsi', 'lsi'] }, () => {
  const item = {
    pk: { S: 'cc-idx-q-1' },
    sk: { S: 'a' },
    lsi1sk: { S: 'cc-idx-hash-1' },
    data: { S: 'indexed' },
  }

  beforeAll(async () => {
    await ddb.send(
      new PutItemCommand({ TableName: compositeIndexedTableDef.name, Item: item }),
    )
    // A GSI is written asynchronously; wait for the item to reach gsi1 so the
    // query below is genuinely served by the index.
    await waitForGsiConsistency({
      tableName: compositeIndexedTableDef.name,
      indexName: 'gsi1',
      partitionKey: { name: 'lsi1sk', value: item.lsi1sk },
      expectedCount: 1,
    })
  })

  afterAll(async () => {
    await cleanupItems(compositeIndexedTableDef.name, [{ pk: item.pk, sk: item.sk }])
  })

  it('Query with INDEXES returns per-index breakdown', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        KeyConditionExpression: '#h = :h',
        ExpressionAttributeNames: { '#h': 'lsi1sk' },
        ExpressionAttributeValues: { ':h': item.lsi1sk },
        ReturnConsumedCapacity: 'INDEXES',
      }),
    )

    // The item coming back is the evidence that gsi1 served the read.
    expect(result.Count).toBe(1)
    expect(result.ConsumedCapacity).toBeDefined()
    expect(result.ConsumedCapacity!.TableName).toBe(compositeIndexedTableDef.name)
    expect(typeof result.ConsumedCapacity!.CapacityUnits).toBe('number')
    expect(result.ConsumedCapacity!.Table).toBeDefined()
    expect(typeof result.ConsumedCapacity!.Table!.CapacityUnits).toBe('number')

    const gsis = result.ConsumedCapacity!.GlobalSecondaryIndexes
    expect(gsis).toBeDefined()
    expect(Object.keys(gsis!)).toContain('gsi1')
    expect(typeof gsis!.gsi1.CapacityUnits).toBe('number')
    expect(gsis!.gsi1.CapacityUnits).toBeGreaterThan(0)
  })

  it('Query with INDEXES returns per-index capacity breakdown', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        KeyConditionExpression: '#h = :h',
        ExpressionAttributeNames: { '#h': 'lsi1sk' },
        ExpressionAttributeValues: { ':h': item.lsi1sk },
        ReturnConsumedCapacity: 'INDEXES',
      }),
    )

    const cc = result.ConsumedCapacity!
    const indexUnits = cc.GlobalSecondaryIndexes!.gsi1.CapacityUnits!
    const tableUnits = cc.Table!.CapacityUnits!

    // The index carries the read; the aggregate is the table's share plus the
    // index's, which is what makes the breakdown a breakdown rather than a copy
    // of the total.
    expect(indexUnits).toBeGreaterThan(0)
    expect(typeof tableUnits).toBe('number')
    expect(cc.CapacityUnits).toBeCloseTo(tableUnits + indexUnits, 5)
  })
})
