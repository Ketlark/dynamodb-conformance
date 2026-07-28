import {
  TransactWriteItemsCommand,
  DynamoDBServiceException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { skipUnlessSupported } from '../../../src/infra.js'
import {
  compositeIndexedTableDef,
  gsiBTableDef,
  cleanupItems,
  declareTables,
} from '../../../src/helpers.js'

// The index-bearing transact cases, kept out of transactWriteItems.test.ts so
// that file declares no indexed table. Each request writes a real index key, so
// the rejection is the message under test rather than an unknown-attribute pass.
declareTables(compositeIndexedTableDef, gsiBTableDef)

// Defensive: the invalid-key-value cases below fail validation and write
// nothing; clean up anyway in case a too-lenient target persists them.
const compositeKeysToCleanup = [
  { pk: { S: 'em-twi-idx-type' }, sk: { S: 'a' } },
  { pk: { S: 'em-twi-idx-nonscalar' }, sk: { S: 'b' } },
  { pk: { S: 'em-twi-idx-empty' }, sk: { S: 'c' } },
  { pk: { S: 'em-twi-idx-upd-type' }, sk: { S: 'a' } },
  { pk: { S: 'em-twi-idx-upd-nonscalar' }, sk: { S: 'b' } },
  { pk: { S: 'em-twi-idx-upd-empty' }, sk: { S: 'c' } },
]

afterAll(async () => {
  await cleanupItems(compositeIndexedTableDef.name, compositeKeysToCleanup)
})

describe('TransactWriteItems — index key error messages', { tags: ['transactions', 'data-plane', 'negative-path', 'gsi'] }, () => {
  // An empty TransactItems is rejected by any target that implements the
  // operation, so this separates "not implemented" from "implemented".
  skipUnlessSupported(() => ddb.send(new TransactWriteItemsCommand({ TransactItems: [] })))

  // Invalid index key value inside a transact Put/Update. The error shape splits
  // by fault, captured from real AWS eu-west-2:
  //   - wrong type / non-scalar: TransactionCanceledException, reason code
  //     'ValidationError', reason Message carrying the PutItem-style string;
  //   - empty string: top-level ValidationException (up-front input validation).
  // Index-key messages name gsi1, the alphabetically-first index lsi1sk keys.
  const expectCancelledReason = async (
    command: TransactWriteItemsCommand,
    reasonMessage: string,
  ) => {
    try {
      await ddb.send(command)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransactionCanceledException)
      const txErr = err as TransactionCanceledException
      const expectedReasons = ['ValidationError'] as const
      expect(txErr.message).toBe(
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${expectedReasons.join(', ')}]`,
      )
      expect(txErr.CancellationReasons?.map((r) => r.Code)).toEqual([
        ...expectedReasons,
      ])
      expect(txErr.CancellationReasons?.[0]?.Message).toBe(reasonMessage)
    }
  }

  const expectTopLevelValidation = async (
    command: TransactWriteItemsCommand,
    message: string,
  ) => {
    try {
      await ddb.send(command)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(message)
    }
  }

  it('Put wrong-typed index key: cancelled with full ValidationError reason', async () => {
    await expectCancelledReason(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: compositeIndexedTableDef.name,
              Item: { pk: { S: 'em-twi-idx-type' }, sk: { S: 'a' }, lsi1sk: { N: '5' } },
            },
          },
        ],
      }),
      'One or more parameter values were invalid: Type mismatch for Index Key lsi1sk Expected: S Actual: N IndexName: gsi1',
    )
  })

  it('Put non-scalar index key: cancelled with full ValidationError reason', async () => {
    await expectCancelledReason(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: compositeIndexedTableDef.name,
              Item: { pk: { S: 'em-twi-idx-nonscalar' }, sk: { S: 'b' }, lsi1sk: { L: [{ S: 'x' }] } },
            },
          },
        ],
      }),
      'One or more parameter values were invalid: Type mismatch for Index Key lsi1sk Expected: S Actual: L IndexName: gsi1',
    )
  })

  it('Update wrong-typed index key: cancelled with full ValidationError reason', async () => {
    await expectCancelledReason(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Update: {
              TableName: compositeIndexedTableDef.name,
              Key: { pk: { S: 'em-twi-idx-upd-type' }, sk: { S: 'a' } },
              UpdateExpression: 'SET lsi1sk = :v',
              ExpressionAttributeValues: { ':v': { N: '5' } },
            },
          },
        ],
      }),
      'One or more parameter values were invalid: Type mismatch for Index Key lsi1sk Expected: S Actual: N IndexName: gsi1',
    )
  })

  it('Update non-scalar index key: cancelled with full ValidationError reason', async () => {
    await expectCancelledReason(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Update: {
              TableName: compositeIndexedTableDef.name,
              Key: { pk: { S: 'em-twi-idx-upd-nonscalar' }, sk: { S: 'b' } },
              UpdateExpression: 'SET lsi1sk = :v',
              ExpressionAttributeValues: { ':v': { L: [{ S: 'x' }] } },
            },
          },
        ],
      }),
      'One or more parameter values were invalid: Type mismatch for Index Key lsi1sk Expected: S Actual: L IndexName: gsi1',
    )
  })

  it('Put empty-string index key: top-level ValidationException', async () => {
    await expectTopLevelValidation(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: compositeIndexedTableDef.name,
              Item: { pk: { S: 'em-twi-idx-empty' }, sk: { S: 'c' }, lsi1sk: { S: '' } },
            },
          },
        ],
      }),
      'One or more parameter values are not valid. A value specified for a secondary index key is not supported. The AttributeValue for a key attribute cannot contain an empty string value. IndexName: gsi1, IndexKey: lsi1sk',
    )
  })

  it('Update empty-string index key: top-level ValidationException', async () => {
    await expectTopLevelValidation(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Update: {
              TableName: compositeIndexedTableDef.name,
              Key: { pk: { S: 'em-twi-idx-upd-empty' }, sk: { S: 'c' } },
              UpdateExpression: 'SET lsi1sk = :v',
              ExpressionAttributeValues: { ':v': { S: '' } },
            },
          },
        ],
      }),
      'One or more parameter values are not valid. The update expression attempted to update a secondary index key to a value that is not supported. The AttributeValue for a key attribute cannot contain an empty string value.',
    )
  })

  // Empty-binary index key values mirror the empty-string cases: a top-level
  // ValidationException that hoists out of the transaction, never a cancellation
  // reason. Real AWS names the same message with 'binary' for 'string'. They need
  // a table whose index key attribute is declared type B, hence gsiBTableDef.
  it('Put empty-binary index key: top-level ValidationException', async () => {
    await expectTopLevelValidation(
      new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: gsiBTableDef.name, Item: { pk: { S: 'eb-twi-idx' }, bidx: { B: new Uint8Array([]) } } } },
        ],
      }),
      'One or more parameter values are not valid. A value specified for a secondary index key is not supported. The AttributeValue for a key attribute cannot contain an empty binary value. IndexName: gsib, IndexKey: bidx',
    )
  })

  it('Update empty-binary index key: top-level ValidationException', async () => {
    await expectTopLevelValidation(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Update: {
              TableName: gsiBTableDef.name,
              Key: { pk: { S: 'eb-twi-idx-upd' } },
              UpdateExpression: 'SET bidx = :v',
              ExpressionAttributeValues: { ':v': { B: new Uint8Array([]) } },
            },
          },
        ],
      }),
      'One or more parameter values are not valid. The update expression attempted to update a secondary index key to a value that is not supported. The AttributeValue for a key attribute cannot contain an empty binary value.',
    )
  })
})
