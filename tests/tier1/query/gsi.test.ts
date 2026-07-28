import {
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  compositeIndexedTableDef,
  cleanupItems,
  waitForGsiConsistency,
  declareTables,
  expectDynamoError,
} from '../../../src/helpers.js'

declareTables(compositeIndexedTableDef)

describe('Query — GSI', { tags: ['query', 'data-plane', 'gsi'] }, () => {
  const items = [
    {
      pk: { S: 'gsi-q-1' },
      sk: { S: 'a' },
      lsi1sk: { S: 'gsi-hash-A' },
      lsi2sk: { S: 'gsi-range-1' },
      data: { S: 'item1' },
    },
    {
      pk: { S: 'gsi-q-2' },
      sk: { S: 'b' },
      lsi1sk: { S: 'gsi-hash-A' },
      lsi2sk: { S: 'gsi-range-2' },
      data: { S: 'item2' },
    },
    {
      pk: { S: 'gsi-q-3' },
      sk: { S: 'c' },
      lsi1sk: { S: 'gsi-hash-B' },
      lsi2sk: { S: 'gsi-range-3' },
      data: { S: 'item3' },
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
    // GSI propagation can be eventually consistent, wait for items to appear
    await waitForGsiConsistency({
      tableName: compositeIndexedTableDef.name,
      indexName: 'gsi1',
      partitionKey: { name: 'lsi1sk', value: { S: 'gsi-hash-A' } },
      expectedCount: 2,
    })
  })

  afterAll(async () => {
    await cleanupItems(
      compositeIndexedTableDef.name,
      items.map((item) => ({ pk: item.pk, sk: item.sk })),
    )
  })

  it('queries a hash-only GSI (gsi1)', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        KeyConditionExpression: 'lsi1sk = :v',
        ExpressionAttributeValues: { ':v': { S: 'gsi-hash-A' } },
      }),
    )

    expect(result.Items!.length).toBe(2)
  })

  it('queries a composite GSI (gsi2) with hash and range', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi2',
        KeyConditionExpression: 'lsi1sk = :pk AND lsi2sk = :sk',
        ExpressionAttributeValues: {
          ':pk': { S: 'gsi-hash-A' },
          ':sk': { S: 'gsi-range-1' },
        },
      }),
    )

    expect(result.Items!.length).toBe(1)
    expect(result.Items![0].data?.S).toBe('item1')
  })

  it('returns empty results for non-existent GSI key', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        KeyConditionExpression: 'lsi1sk = :v',
        ExpressionAttributeValues: { ':v': { S: 'does-not-exist' } },
      }),
    )

    expect(result.Items).toHaveLength(0)
  })

  it('sparse GSI: items without GSI key attributes are excluded', async () => {
    // Put an item without the GSI key attribute
    const sparseItem = { pk: { S: 'gsi-sparse' }, sk: { S: 'x' } }
    await ddb.send(
      new PutItemCommand({
        TableName: compositeIndexedTableDef.name,
        Item: sparseItem,
      }),
    )

    // Query the GSI — the sparse item should not appear
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi1',
        KeyConditionExpression: 'lsi1sk = :v',
        ExpressionAttributeValues: { ':v': { S: 'gsi-hash-A' } },
      }),
    )

    const pks = result.Items!.map((i) => i.pk.S)
    expect(pks).not.toContain('gsi-sparse')

    await ddb.send(
      new DeleteItemCommand({
        TableName: compositeIndexedTableDef.name,
        Key: { pk: sparseItem.pk, sk: sparseItem.sk },
      }),
    )
  })

  it('sparse composite GSI: an item with the GSI hash key but no range key is excluded', async () => {
    // Has gsi2's hash key (lsi1sk) but not its range key (lsi2sk), so it belongs
    // in the hash-only gsi1 yet must be excluded from the composite gsi2.
    const noRangeItem = {
      pk: { S: 'gsi-sparse-range' },
      sk: { S: 'x' },
      lsi1sk: { S: 'gsi-hash-sparse-range' },
    }
    await ddb.send(
      new PutItemCommand({
        TableName: compositeIndexedTableDef.name,
        Item: noRangeItem,
      }),
    )
    // Confirm it propagated into the hash-only GSI (so it was written and indexed there).
    await waitForGsiConsistency({
      tableName: compositeIndexedTableDef.name,
      indexName: 'gsi1',
      partitionKey: { name: 'lsi1sk', value: { S: 'gsi-hash-sparse-range' } },
      expectedCount: 1,
    })

    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeIndexedTableDef.name,
        IndexName: 'gsi2',
        KeyConditionExpression: 'lsi1sk = :v',
        ExpressionAttributeValues: { ':v': { S: 'gsi-hash-sparse-range' } },
      }),
    )

    expect(result.Items).toHaveLength(0)

    await ddb.send(
      new DeleteItemCommand({
        TableName: compositeIndexedTableDef.name,
        Key: { pk: noRangeItem.pk, sk: noRangeItem.sk },
      }),
    )
  })
})

describe('Query — GSI pagination across tied sort keys', { tags: ['query', 'data-plane', 'gsi'] }, () => {
  // All items share both GSI keys (lsi1sk + lsi2sk), so the GSI cursor is
  // ambiguous without the base-table key. Real AWS composes LastEvaluatedKey
  // from the base key (pk, sk) AND the index keys (lsi1sk, lsi2sk) — captured
  // against AWS as {pk, lsi1sk, sk, lsi2sk}. An emulator that returns only the
  // index keys loops forever or drops rows on the tie.
  const tied = [0, 1, 2, 3].map((i) => ({
    pk: { S: `gsi-tie-${i}` },
    sk: { S: `s-${i}` },
    lsi1sk: { S: 'gsi-tie-hash' },
    lsi2sk: { S: 'gsi-tie-range' },
    data: { S: `d${i}` },
  }))

  beforeAll(async () => {
    await Promise.all(
      tied.map((item) =>
        ddb.send(
          new PutItemCommand({ TableName: compositeIndexedTableDef.name, Item: item }),
        ),
      ),
    )
    await waitForGsiConsistency({
      tableName: compositeIndexedTableDef.name,
      indexName: 'gsi2',
      partitionKey: { name: 'lsi1sk', value: { S: 'gsi-tie-hash' } },
      expectedCount: tied.length,
    })
  })

  afterAll(async () => {
    await cleanupItems(
      compositeIndexedTableDef.name,
      tied.map((item) => ({ pk: item.pk, sk: item.sk })),
    )
  })

  it('composes LastEvaluatedKey from base and index keys and walks every tied item once', async () => {
    const seen: string[] = []
    let lastKey: Record<string, AttributeValue> | undefined
    let pages = 0

    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: compositeIndexedTableDef.name,
          IndexName: 'gsi2',
          KeyConditionExpression: 'lsi1sk = :h AND lsi2sk = :r',
          ExpressionAttributeValues: {
            ':h': { S: 'gsi-tie-hash' },
            ':r': { S: 'gsi-tie-range' },
          },
          Limit: 1,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      )
      pages++
      for (const item of page.Items ?? []) seen.push(item.pk!.S!)
      lastKey = page.LastEvaluatedKey
      if (lastKey) {
        // The continuation key must carry the base-table keys, not just the GSI keys.
        expect(Object.keys(lastKey).sort()).toEqual([
          'lsi1sk',
          'lsi2sk',
          'pk',
          'sk',
        ])
      }
      // Guard against the infinite-loop bug: a correct walk needs at most one
      // page per item plus the terminating empty check.
      expect(pages).toBeLessThanOrEqual(tied.length + 1)
    } while (lastKey)

    expect(seen.sort()).toEqual(tied.map((t) => t.pk.S).sort())
    expect(new Set(seen).size).toBe(tied.length) // no repeats
  })
})

// Pagination only ever feeds back a well-formed LastEvaluatedKey. A GSI cursor
// must carry the index key as well as the base key, so a target that does not
// validate ExclusiveStartKey against the index schema is too lenient; real
// DynamoDB rejects a key that does not match. Needs no seeded data: the
// rejection happens before any item is read.
describe('Query — GSI ExclusiveStartKey validation', { tags: ['query', 'data-plane', 'gsi', 'negative-path'] }, () => {
  it('rejects ExclusiveStartKey missing the index key on a GSI query', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: compositeIndexedTableDef.name,
            IndexName: 'gsi1',
            KeyConditionExpression: '#hk = :v',
            ExpressionAttributeNames: { '#hk': 'lsi1sk' },
            ExpressionAttributeValues: { ':v': { S: 'x' } },
            ExclusiveStartKey: { pk: { S: 'x' } },
          }),
        ),
      'ValidationException',
      /provided starting key is invalid/,
    )
  })
})
