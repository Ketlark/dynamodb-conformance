import { BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('BatchWriteItem — validation', { tags: ['batch', 'data-plane', 'negative-path'] }, () => {
  it('rejects more than 25 items', async () => {
    const items = Array.from({ length: 26 }, (_, i) => ({
      PutRequest: {
        Item: { pk: { S: `bw-limit-${i}` } },
      },
    }))

    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: { [hashTableDef.name]: items },
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects empty RequestItems', async () => {
    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {},
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects writes to a non-existent table', async () => {
    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            _conformance_nonexistent_table: [
              {
                PutRequest: { Item: { pk: { S: 'test' } } },
              },
            ],
          },
        }),
      ),
      'ResourceNotFoundException',
    )
  })

  it('rejects duplicate keys in the same table batch', async () => {
    await expectDynamoError(
      () => ddb.send(new BatchWriteItemCommand({
        RequestItems: {
          [hashTableDef.name]: [
            { PutRequest: { Item: { pk: { S: 'dup-key' }, val: { S: 'first' } } } },
            { PutRequest: { Item: { pk: { S: 'dup-key' }, val: { S: 'second' } } } },
          ],
        },
      })),
      'ValidationException',
    )
  })

  it('rejects a key-less item with a 400 ValidationException, not a 500', async () => {
    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [hashTableDef.name]: [
              { PutRequest: { Item: { notkey: { S: 'x' } } } },
            ],
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e) {
      // A too-lenient target returns 500 InternalError here; AWS rejects with
      // a 400 ValidationException for the schema-mismatched item.
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
      expect(err.name).toBe('ValidationException')
      expect(err.$metadata?.httpStatusCode).toBe(400)
    }
  })

  // A table key attribute whose value has the wrong type, is non-scalar, or is
  // an empty string is rejected. BatchWriteItem validates the item up front, so
  // every variant is a top-level ValidationException for the whole request -
  // there is no cancellation path here, unlike TransactWriteItems. Exact
  // strings are pinned in tests/tier3/error-messages/batchWriteItem.test.ts.
  it('rejects a wrong-typed table key value', async () => {
    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [hashTableDef.name]: [
              { PutRequest: { Item: { pk: { N: '5' } } } },
            ],
          },
        }),
      ),
      'ValidationException',
      /does not match the schema/,
    )
  })

  it('rejects a non-scalar table key value', async () => {
    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [hashTableDef.name]: [
              { PutRequest: { Item: { pk: { L: [{ S: 'x' }] } } } },
            ],
          },
        }),
      ),
      'ValidationException',
      /does not match the schema/,
    )
  })

  it('rejects an empty-string table key value', async () => {
    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [hashTableDef.name]: [
              { PutRequest: { Item: { pk: { S: '' } } } },
            ],
          },
        }),
      ),
      'ValidationException',
      /empty string value/i,
    )
  })
})
