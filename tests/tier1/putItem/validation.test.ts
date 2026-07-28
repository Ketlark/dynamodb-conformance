import { PutItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('PutItem — validation', { tags: ['put-item', 'data-plane', 'negative-path'] }, () => {
  it('rejects PutItem to a non-existent table', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: '_conformance_nonexistent_table',
          Item: { pk: { S: 'test' } },
        }),
      ),
      'ResourceNotFoundException',
    )
  })

  it('rejects item missing the hash key', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { notTheKey: { S: 'test' } },
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects empty string set', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: [] } },
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects empty number set', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { NS: [] } },
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects empty binary set', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { BS: [] } },
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects an empty string member in a number set', async () => {
    // Empty members are allowed in SS/BS but an empty string is not a number,
    // so NS rejects it — on the numeric parse, not on emptiness.
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { NS: [''] } },
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects duplicate empty string members in a string set', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: ['', ''] } },
        }),
      ),
      'ValidationException',
      'duplicates',
    )
  })

  it('rejects duplicate zero-length members in a binary set', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: {
            pk: { S: 'test' },
            bad: { BS: [new Uint8Array(0), new Uint8Array(0)] },
          },
        }),
      ),
      'ValidationException',
      'duplicates',
    )
  })

  it('rejects duplicate values in string set', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: ['a', 'a'] } },
        }),
      ),
      'ValidationException',
      'duplicates',
    )
  })

  it('rejects duplicate values in number set', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { NS: ['1', '1', '2'] } },
        }),
      ),
      'ValidationException',
      'duplicates',
    )
  })

  it('rejects duplicate values in binary set', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: {
            pk: { S: 'test' },
            bad: { BS: [new Uint8Array([1]), new Uint8Array([1])] },
          },
        }),
      ),
      'ValidationException',
      'duplicates',
    )
  })

  it('rejects invalid ReturnValues', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' } },
          // @ts-expect-error -- testing invalid ReturnValues
          ReturnValues: 'INVALID',
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects mixing expression and non-expression parameters', { tags: ['legacy'] }, async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' } },
          Expected: { pk: { Exists: false } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      ),
      'ValidationException',
      'Can not use both expression and non-expression',
    )
  })

  it('rejects a number with a leading space', async () => {
    await expectDynamoError(
      () => ddb.send(new PutItemCommand({ TableName: hashTableDef.name, Item: { pk: { S: 'num-lead-ws' }, n: { N: ' 5' } } })),
      'ValidationException',
    )
  })

  it('rejects a number with a trailing space', async () => {
    await expectDynamoError(
      () => ddb.send(new PutItemCommand({ TableName: hashTableDef.name, Item: { pk: { S: 'num-trail-ws' }, n: { N: '5 ' } } })),
      'ValidationException',
    )
  })

})
