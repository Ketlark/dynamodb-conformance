import {
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import {
  compositeIndexedTableDef,
  cleanupItems,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(compositeIndexedTableDef)

// Defensive: the invalid-index-key cases below must all fail validation and
// write nothing. Clean up anyway so a too-lenient target that wrongly persists
// them does not leak rows into later tests.
const compositeKeys = [
  { pk: { S: 'tw-idx-type' }, sk: { S: 'a' } },
  { pk: { S: 'tw-idx-nonscalar' }, sk: { S: 'b' } },
  { pk: { S: 'tw-idx-empty' }, sk: { S: 'c' } },
  { pk: { S: 'tw-idx-upd-type' }, sk: { S: 'a' } },
  { pk: { S: 'tw-idx-upd-nonscalar' }, sk: { S: 'b' } },
  { pk: { S: 'tw-idx-upd-empty' }, sk: { S: 'c' } },
]

afterAll(async () => {
  await cleanupItems(compositeIndexedTableDef.name, compositeKeys)
})

describe('TransactWriteItems — index key validation', { tags: ['transactions', 'data-plane', 'negative-path', 'lsi'] }, () => {
  // An empty TransactItems is rejected by any target that implements the
  // operation, so this separates "not implemented" from "implemented".
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  // An item carrying a malformed secondary-index key value is rejected, but the
  // error SHAPE depends on the fault, and the two halves are opposite traps:
  //
  //   - Wrong type / non-scalar: caught during transaction execution, so AWS
  //     cancels with a TransactionCanceledException whose reason Code is
  //     'ValidationError'. An engine that "validates up front" and returns a
  //     top-level ValidationException here diverges from real DynamoDB.
  //   - Empty string: caught by up-front input validation, so AWS returns a
  //     top-level ValidationException even inside a transaction. An engine that
  //     wraps this as a TransactionCanceledException diverges.
  //
  // Both directions are asserted below. The equivalent table-key cases live in
  // tests/tier2/transactions/transactWrite.test.ts; exact strings live in
  // tests/tier3/error-messages/transactIndexKeys.test.ts.

  const expectCancelledForValidation = async (transactItems: unknown[]) => {
    try {
      await ddb.send(
        new TransactWriteItemsCommand({ TransactItems: transactItems as never }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionCanceledException)
      const txErr = err as TransactionCanceledException
      // name is TransactionCanceledException, NOT a top-level ValidationException.
      expect(txErr.name).toBe('TransactionCanceledException')
      expect(txErr.CancellationReasons?.[0]?.Code).toBe('ValidationError')
    }
  }

  it('Put with a wrong-typed index key cancels with a ValidationError reason', async () => {
    await expectCancelledForValidation([
      {
        Put: {
          TableName: compositeIndexedTableDef.name,
          Item: { pk: { S: 'tw-idx-type' }, sk: { S: 'a' }, lsi1sk: { N: '5' } },
        },
      },
    ])
  })

  it('Put with a non-scalar index key cancels with a ValidationError reason', async () => {
    await expectCancelledForValidation([
      {
        Put: {
          TableName: compositeIndexedTableDef.name,
          Item: { pk: { S: 'tw-idx-nonscalar' }, sk: { S: 'b' }, lsi1sk: { L: [{ S: 'x' }] } },
        },
      },
    ])
  })

  it('Update setting a wrong-typed index key cancels with a ValidationError reason', async () => {
    await expectCancelledForValidation([
      {
        Update: {
          TableName: compositeIndexedTableDef.name,
          Key: { pk: { S: 'tw-idx-upd-type' }, sk: { S: 'a' } },
          UpdateExpression: 'SET lsi1sk = :v',
          ExpressionAttributeValues: { ':v': { N: '5' } },
        },
      },
    ])
  })

  it('Update setting a non-scalar index key cancels with a ValidationError reason', async () => {
    await expectCancelledForValidation([
      {
        Update: {
          TableName: compositeIndexedTableDef.name,
          Key: { pk: { S: 'tw-idx-upd-nonscalar' }, sk: { S: 'b' } },
          UpdateExpression: 'SET lsi1sk = :v',
          ExpressionAttributeValues: { ':v': { L: [{ S: 'x' }] } },
        },
      },
    ])
  })

  it('Put with an empty-string index key is a top-level ValidationException', async () => {
    await expectDynamoError(
      () => ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: compositeIndexedTableDef.name,
                Item: { pk: { S: 'tw-idx-empty' }, sk: { S: 'c' }, lsi1sk: { S: '' } },
              },
            },
          ],
        }),
      ),
      'ValidationException',
      /secondary index key/i,
    )
  })

  it('Update setting an empty-string index key is a top-level ValidationException', async () => {
    await expectDynamoError(
      () => ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Update: {
                TableName: compositeIndexedTableDef.name,
                Key: { pk: { S: 'tw-idx-upd-empty' }, sk: { S: 'c' } },
                UpdateExpression: 'SET lsi1sk = :v',
                ExpressionAttributeValues: { ':v': { S: '' } },
              },
            },
          ],
        }),
      ),
      'ValidationException',
      /secondary index key/i,
    )
  })
})
