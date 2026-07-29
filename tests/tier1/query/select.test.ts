import {
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, compositeTableDef, cleanupItems, expectDynamoError } from '../../../src/helpers.js'

declareTables(compositeTableDef)

describe('Query — Select COUNT', { tags: ['query', 'data-plane'] }, () => {
  const pk = 'query-select-count'
  const items = [
    { pk: { S: pk }, sk: { S: 'a' }, status: { S: 'active' } },
    { pk: { S: pk }, sk: { S: 'b' }, status: { S: 'inactive' } },
    { pk: { S: pk }, sk: { S: 'c' }, status: { S: 'active' } },
  ]

  beforeAll(async () => {
    await Promise.all(
      items.map((item) =>
        ddb.send(
          new PutItemCommand({ TableName: compositeTableDef.name, Item: item }),
        ),
      ),
    )
  })

  afterAll(async () => {
    await cleanupItems(
      compositeTableDef.name,
      items.map((item) => ({ pk: item.pk, sk: item.sk })),
    )
  })

  it('Select COUNT returns count without items', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeTableDef.name,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: pk } },
        Select: 'COUNT',
        ConsistentRead: true,
      }),
    )

    expect(result.Count).toBeGreaterThan(0)
    expect(result.ScannedCount).toBe(result.Count)
    expect(result.Items).toBeUndefined()
  })

  it('Select COUNT with FilterExpression returns different Count and ScannedCount', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeTableDef.name,
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':pk': { S: pk },
          ':status': { S: 'active' },
        },
        Select: 'COUNT',
        ConsistentRead: true,
      }),
    )

    expect(result.Count).toBe(2)
    expect(result.ScannedCount).toBe(3)
    expect(result.Items).toBeUndefined()
  })
})

describe('Query — Select SPECIFIC_ATTRIBUTES', { tags: ['query', 'data-plane'] }, () => {
  const pk = 'query-select-specific'
  const items = [
    { pk: { S: pk }, sk: { S: 'a' }, data: { S: 'hello' }, extra: { S: 'world' } },
    { pk: { S: pk }, sk: { S: 'b' }, data: { S: 'foo' }, extra: { S: 'bar' } },
  ]

  beforeAll(async () => {
    await Promise.all(
      items.map((item) =>
        ddb.send(
          new PutItemCommand({ TableName: compositeTableDef.name, Item: item }),
        ),
      ),
    )
  })

  afterAll(async () => {
    await cleanupItems(
      compositeTableDef.name,
      items.map((item) => ({ pk: item.pk, sk: item.sk })),
    )
  })

  it('Select SPECIFIC_ATTRIBUTES with ProjectionExpression succeeds', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeTableDef.name,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': { S: pk } },
        ProjectionExpression: '#pk, #sk',
        Select: 'SPECIFIC_ATTRIBUTES',
        ConsistentRead: true,
      }),
    )

    expect(result.Items).toBeDefined()
    expect(result.Items!.length).toBe(2)
    for (const item of result.Items!) {
      expect(item.pk).toBeDefined()
      expect(item.sk).toBeDefined()
      expect(item.data).toBeUndefined()
      expect(item.extra).toBeUndefined()
    }
  })

  it('Select SPECIFIC_ATTRIBUTES without ProjectionExpression is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: compositeTableDef.name,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: pk } },
            Select: 'SPECIFIC_ATTRIBUTES',
            ConsistentRead: true,
          }),
        ),
      'ValidationException',
    )
  })
})

// ProjectionExpression requires SPECIFIC_ATTRIBUTES; ALL_PROJECTED_ATTRIBUTES requires an IndexName.
describe('Query — Select / ProjectionExpression rejections', { tags: ['query', 'data-plane', 'negative-path'] }, () => {
  it('Select ALL_ATTRIBUTES with ProjectionExpression is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: compositeTableDef.name,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: 'x' } },
            Select: 'ALL_ATTRIBUTES',
            ProjectionExpression: 'sk',
          }),
        ),
      'ValidationException',
      'Cannot specify the ProjectionExpression when choosing to get ALL_ATTRIBUTES',
    )
  })

  it('Select ALL_PROJECTED_ATTRIBUTES without an IndexName is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: compositeTableDef.name,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: 'x' } },
            Select: 'ALL_PROJECTED_ATTRIBUTES',
          }),
        ),
      'ValidationException',
      'ALL_PROJECTED_ATTRIBUTES can be used only when Querying using an IndexName',
    )
  })

  it('Select COUNT with ProjectionExpression is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: compositeTableDef.name,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: 'x' } },
            Select: 'COUNT',
            ProjectionExpression: 'sk',
          }),
        ),
      'ValidationException',
      'Cannot specify the ProjectionExpression when choosing to get only the Count',
    )
  })

  // Both rules broken at once; AWS reports the ProjectionExpression one.
  it('Select ALL_PROJECTED_ATTRIBUTES with ProjectionExpression and no IndexName is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: compositeTableDef.name,
            KeyConditionExpression: '#pk = :pk',
            ExpressionAttributeNames: { '#pk': 'pk' },
            ExpressionAttributeValues: { ':pk': { S: 'x' } },
            Select: 'ALL_PROJECTED_ATTRIBUTES',
            ProjectionExpression: 'sk',
          }),
        ),
      'ValidationException',
      'Cannot specify the ProjectionExpression when choosing to get ALL_PROJECTED_ATTRIBUTES',
    )
  })
})
