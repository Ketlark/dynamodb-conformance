import {
  PutItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  compositeIndexedTableDef,
  cleanupItems,
  waitForGsiConsistency,
  declareTables,
} from '../../../src/helpers.js'

declareTables(compositeIndexedTableDef)

describe('Scan — GSI', { tags: ['scan', 'data-plane', 'gsi', 'lsi'] }, () => {
  const items = [
    {
      pk: { S: 'scan-gsi-1' },
      sk: { S: 'a' },
      lsi1sk: { S: 'scan-gsi-hash-A' },
      lsi2sk: { S: 'r1' },
      data: { S: 'val1' },
      extra: { S: 'should-not-appear-in-gsi2' },
    },
    {
      pk: { S: 'scan-gsi-2' },
      sk: { S: 'b' },
      lsi1sk: { S: 'scan-gsi-hash-A' },
      lsi2sk: { S: 'r2' },
      data: { S: 'val2' },
      extra: { S: 'also-not-in-gsi2' },
    },
    {
      pk: { S: 'scan-gsi-3' },
      sk: { S: 'c' },
      lsi1sk: { S: 'scan-gsi-hash-B' },
      lsi2sk: { S: 'r3' },
      data: { S: 'val3' },
      extra: { S: 'nope' },
    },
  ]

  beforeAll(async () => {
    await Promise.all(
      items.map((item) =>
        ddb.send(
          new PutItemCommand({ TableName: compositeIndexedTableDef.name, Item: item }),
        ),
      ),
    )
    await waitForGsiConsistency({
      tableName: compositeIndexedTableDef.name,
      indexName: 'gsi1',
      partitionKey: { name: 'lsi1sk', value: { S: 'scan-gsi-hash-A' } },
      expectedCount: 2,
    })
  })

  afterAll(async () => {
    await cleanupItems(
      compositeIndexedTableDef.name,
      items.map((item) => ({ pk: item.pk, sk: item.sk })),
    )
  })

  it('scans a GSI with ALL projection and returns all attributes', async () => {
    const result = await ddb.send(
      new ScanCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        FilterExpression: 'begins_with(lsi1sk, :prefix)',
        ExpressionAttributeValues: { ':prefix': { S: 'scan-gsi-hash-' } },
      }),
    )

    expect(result.Items!.length).toBe(3)
    // ALL projection on gsi1 should include every attribute
    for (const item of result.Items!) {
      expect(item.pk).toBeDefined()
      expect(item.sk).toBeDefined()
      expect(item.lsi1sk).toBeDefined()
      expect(item.data).toBeDefined()
      expect(item.extra).toBeDefined()
    }
  })

  it('scans a GSI with INCLUDE projection and returns only projected attributes', async () => {
    // gsi2: INCLUDE with nonKeyAttributes ['data']
    // Keys: lsi1sk (HASH), lsi2sk (RANGE)
    const result = await ddb.send(
      new ScanCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi2',
        FilterExpression: 'begins_with(lsi1sk, :prefix)',
        ExpressionAttributeValues: { ':prefix': { S: 'scan-gsi-hash-' } },
      }),
    )

    expect(result.Items!.length).toBe(3)
    for (const item of result.Items!) {
      // GSI key attributes should be present
      expect(item.lsi1sk).toBeDefined()
      expect(item.lsi2sk).toBeDefined()
      // Included attribute
      expect(item.data).toBeDefined()
      // Not included: extra, pk, sk should be absent
      expect(item.extra).toBeUndefined()
    }
  })

  it('scans a GSI with FilterExpression', async () => {
    const result = await ddb.send(
      new ScanCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        FilterExpression: 'lsi1sk = :v AND #d = :data',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: {
          ':v': { S: 'scan-gsi-hash-A' },
          ':data': { S: 'val1' },
        },
      }),
    )

    expect(result.Items).toHaveLength(1)
    expect(result.Items![0].pk?.S).toBe('scan-gsi-1')
    expect(result.ScannedCount!).toBeGreaterThanOrEqual(result.Count!)
  })

  it('sparse composite GSI: an item missing the GSI range key is not scanned', async () => {
    // Written to the base table and present in the hash-only gsi1, but absent
    // from a scan of the composite gsi2 because it has no lsi2sk.
    const noRangeItem = {
      pk: { S: 'scan-gsi-sparse' },
      sk: { S: 'x' },
      lsi1sk: { S: 'scan-gsi-hash-sparse' },
    }
    await ddb.send(
      new PutItemCommand({
        TableName: compositeIndexedTableDef.name,
        Item: noRangeItem,
      }),
    )
    await waitForGsiConsistency({
      tableName: compositeIndexedTableDef.name,
      indexName: 'gsi1',
      partitionKey: { name: 'lsi1sk', value: { S: 'scan-gsi-hash-sparse' } },
      expectedCount: 1,
    })

    // Present in the hash-only GSI...
    const gsi1Scan = await ddb.send(
      new ScanCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        FilterExpression: 'lsi1sk = :v',
        ExpressionAttributeValues: { ':v': { S: 'scan-gsi-hash-sparse' } },
      }),
    )
    expect(gsi1Scan.Items!.map((i) => i.pk?.S)).toContain('scan-gsi-sparse')

    // ...but never scanned from the composite GSI.
    const gsi2Scan = await ddb.send(
      new ScanCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi2',
      }),
    )
    expect(gsi2Scan.Items!.map((i) => i.pk?.S)).not.toContain('scan-gsi-sparse')

    await cleanupItems(compositeIndexedTableDef.name, [
      { pk: noRangeItem.pk, sk: noRangeItem.sk },
    ])
  })
})

// Scanning an index runs a different FilterExpression path from scanning the
// base table in some emulators, so the parens forms are re-checked here. Items
// carry a unique `lsi1sk` marker, which is also gsi1's hash key, so the scan
// isolates this describe's data from whatever else is in the shared table.
describe('Scan — GSI FilterExpression parens', { tags: ['scan', 'data-plane', 'gsi', 'lsi'] }, () => {
  const marker = 'fes-parens-marker'
  const items = [
    { pk: { S: 'fes-parens-1' }, sk: { S: 'x' }, lsi1sk: { S: marker }, type: { S: 'alpha' }, status: { S: 'active' } },
    { pk: { S: 'fes-parens-2' }, sk: { S: 'x' }, lsi1sk: { S: marker }, type: { S: 'beta' }, status: { S: 'inactive' } },
    { pk: { S: 'fes-parens-3' }, sk: { S: 'x' }, lsi1sk: { S: marker }, type: { S: 'gamma' }, status: { S: 'active' } },
    { pk: { S: 'fes-parens-4' }, sk: { S: 'x' }, lsi1sk: { S: marker }, type: { S: 'alpha' }, status: { S: 'active' } },
  ]

  beforeAll(async () => {
    await Promise.all(
      items.map((item) =>
        ddb.send(
          new PutItemCommand({ TableName: compositeIndexedTableDef.name, Item: item }),
        ),
      ),
    )
    await waitForGsiConsistency({
      tableName: compositeIndexedTableDef.name,
      indexName: 'gsi1',
      partitionKey: { name: 'lsi1sk', value: { S: marker } },
      expectedCount: items.length,
    })
  }, 30_000)

  afterAll(async () => {
    await cleanupItems(
      compositeIndexedTableDef.name,
      items.map((item) => ({ pk: item.pk, sk: item.sk })),
    )
  })

  it('GSI scan — parens filter returns matching items', async () => {
    const result = await ddb.send(
      new ScanCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        FilterExpression: '(#m = :m) AND ((#t = :a) OR (#t = :b))',
        ExpressionAttributeNames: { '#m': 'lsi1sk', '#t': 'type' },
        ExpressionAttributeValues: {
          ':m': { S: marker },
          ':a': { S: 'alpha' },
          ':b': { S: 'beta' },
        },
      }),
    )

    // Same three items show through the GSI (all four have lsi1sk=marker)
    expect(result.Items).toHaveLength(3)
  })
})
