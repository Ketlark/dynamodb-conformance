import { BatchWriteItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  compositeIndexedTableDef,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(compositeIndexedTableDef)

describe('BatchWriteItem — index key validation', { tags: ['batch', 'data-plane', 'negative-path', 'lsi'] }, () => {
  // An index key value whose type is wrong, is non-scalar, or is an empty
  // string is rejected. BatchWriteItem validates the item up front, so every
  // variant is a top-level ValidationException for the whole request - there is
  // no cancellation path here, unlike TransactWriteItems. Exact strings are
  // pinned in tests/tier3/error-messages/batchWriteItem.test.ts.
  it('rejects a wrong-typed index key value', async () => {
    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [compositeIndexedTableDef.name]: [
              {
                PutRequest: {
                  Item: { pk: { S: 'bw-idx-type' }, sk: { S: 'a' }, lsi1sk: { N: '5' } },
                },
              },
            ],
          },
        }),
      ),
      'ValidationException',
      /Type mismatch for Index Key/,
    )
  })

  it('rejects a non-scalar index key value', async () => {
    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [compositeIndexedTableDef.name]: [
              {
                PutRequest: {
                  Item: { pk: { S: 'bw-idx-nonscalar' }, sk: { S: 'b' }, lsi1sk: { L: [{ S: 'x' }] } },
                },
              },
            ],
          },
        }),
      ),
      'ValidationException',
      /Type mismatch for Index Key/,
    )
  })

  it('rejects an empty-string index key value', async () => {
    await expectDynamoError(
      () => ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [compositeIndexedTableDef.name]: [
              {
                PutRequest: {
                  Item: { pk: { S: 'bw-idx-empty' }, sk: { S: 'c' }, lsi1sk: { S: '' } },
                },
              },
            ],
          },
        }),
      ),
      'ValidationException',
      /secondary index key/i,
    )
  })
})
