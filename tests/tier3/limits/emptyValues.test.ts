import {
  PutItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  compositeTableDef,
  cleanupItems,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef, compositeTableDef)

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Empty values — strings, binary, and sets', { tags: ['put-item', 'get-item', 'data-plane'] }, () => {
  const hashKeys = [
    { pk: { S: 'ev-empty-str' } },
    { pk: { S: 'ev-empty-str-list' } },
    { pk: { S: 'ev-empty-bin' } },
    { pk: { S: 'ev-ss-empty-member' } },
    { pk: { S: 'ev-ss-empty-member-mixed' } },
    { pk: { S: 'ev-bs-empty-member' } },
    { pk: { S: 'ev-bs-empty-member-mixed' } },
    { pk: { S: 'ev-map-ss-empty-member' } },
    { pk: { S: 'ev-list-ss-empty-member' } },
  ]
  const compositeKeys = [
    { pk: { S: 'ev-composite' }, sk: { S: 'placeholder' } },
  ]

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, hashKeys)
    await cleanupItems(compositeTableDef.name, compositeKeys)
  })

  it('empty string in non-key S attribute is accepted', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'ev-empty-str' }, attr: { S: '' } },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-empty-str' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.attr.S).toBe('')
  })

  it('empty string as hash key value is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: { pk: { S: '' } },
          }),
        ),
      'ValidationException',
    )
  })

  it('empty string as sort key value is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: compositeTableDef.name,
            Item: { pk: { S: 'ev-composite' }, sk: { S: '' } },
          }),
        ),
      'ValidationException',
    )
  })

  it('empty binary (B: empty Uint8Array) in non-key attribute is accepted', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'ev-empty-bin' }, attr: { B: new Uint8Array([]) } },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-empty-bin' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item).toBeDefined()
    // The value must come back zero-length, not merely present: a target that
    // returns a non-empty value here has not round-tripped the empty binary.
    expect(result.Item!.attr.B!.byteLength).toBe(0)
  })

  it('empty string set (SS) is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: { pk: { S: 'ev-empty-ss' }, attr: { SS: [] } },
          }),
        ),
      'ValidationException',
      /An string set {2}may not be empty/,
    )
  })

  it('empty number set (NS) is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: { pk: { S: 'ev-empty-ns' }, attr: { NS: [] } },
          }),
        ),
      'ValidationException',
      /An number set {2}may not be empty/,
    )
  })

  it('empty binary set (BS) is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: { pk: { S: 'ev-empty-bs' }, attr: { BS: [] } },
          }),
        ),
      'ValidationException',
      'Binary sets should not be empty',
    )
  })

  // An empty *set* and an empty *member* are different boundaries: DynamoDB
  // rejects the first and accepts the second ("DynamoDB does not support empty
  // sets, however, empty string and binary values are allowed within a set").
  // Set order is not preserved, so multi-member assertions compare sorted.
  it('string set whose only member is the empty string is accepted and round-trips', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'ev-ss-empty-member' }, attr: { SS: [''] } },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-ss-empty-member' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.attr.SS).toEqual([''])
  })

  it('string set mixing an empty member with a non-empty member round-trips both', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'ev-ss-empty-member-mixed' }, attr: { SS: ['', 'a'] } },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-ss-empty-member-mixed' } },
        ConsistentRead: true,
      }),
    )
    expect([...result.Item!.attr.SS!].sort()).toEqual(['', 'a'])
  })

  it('binary set whose only member is zero-length is accepted and round-trips at zero length', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'ev-bs-empty-member' }, attr: { BS: [new Uint8Array(0)] } },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-bs-empty-member' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.attr.BS).toHaveLength(1)
    expect(result.Item!.attr.BS![0].byteLength).toBe(0)
  })

  it('binary set mixing a zero-length member with a one-byte member round-trips both', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: 'ev-bs-empty-member-mixed' },
          attr: { BS: [new Uint8Array(0), new Uint8Array([1])] },
        },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-bs-empty-member-mixed' } },
        ConsistentRead: true,
      }),
    )
    const members = result.Item!.attr.BS!
    expect(members).toHaveLength(2)
    expect(members.map((b) => b.byteLength).sort()).toEqual([0, 1])
    const oneByte = members.find((b) => b.byteLength === 1)!
    expect(oneByte[0]).toBe(1)
  })

  it('empty string member in NS is rejected (not a number)', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: { pk: { S: 'ev-ns-empty-member' }, attr: { NS: [''] } },
          }),
        ),
      'ValidationException',
      'cannot be converted to a numeric value',
    )
  })

  it('duplicate empty string members in SS are rejected as duplicates', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: { pk: { S: 'ev-ss-dup-empty-member' }, attr: { SS: ['', ''] } },
          }),
        ),
      'ValidationException',
      'duplicates',
    )
  })

  it('duplicate zero-length members in BS are rejected as duplicates', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: {
              pk: { S: 'ev-bs-dup-empty-member' },
              attr: { BS: [new Uint8Array(0), new Uint8Array(0)] },
            },
          }),
        ),
      'ValidationException',
      'duplicates',
    )
  })

  it('empty set nested inside a Map is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: {
              pk: { S: 'ev-map-empty-set' },
              outer: { M: { inner: { SS: [] } } },
            },
          }),
        ),
      'ValidationException',
    )
  })

  it('empty set nested inside a List is rejected', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: {
              pk: { S: 'ev-list-empty-set' },
              items: { L: [{ SS: [] }] },
            },
          }),
        ),
      'ValidationException',
    )
  })

  it('set with an empty member nested inside a Map is accepted', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: 'ev-map-ss-empty-member' },
          outer: { M: { inner: { SS: [''] } } },
        },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-map-ss-empty-member' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.outer.M!.inner.SS).toEqual([''])
  })

  it('set with an empty member nested inside a List is accepted', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: 'ev-list-ss-empty-member' },
          items: { L: [{ SS: [''] }] },
        },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-list-ss-empty-member' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.items.L![0].SS).toEqual([''])
  })

  it('empty string inside a List element is accepted', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: 'ev-empty-str-list' },
          items: { L: [{ S: '' }, { S: 'hello' }] },
        },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'ev-empty-str-list' } },
        ConsistentRead: true,
      }),
    )
    expect(result.Item!.items.L![0].S).toBe('')
    expect(result.Item!.items.L![1].S).toBe('hello')
  })
})
