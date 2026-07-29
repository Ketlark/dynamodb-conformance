import {
  BatchWriteItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  compositeIndexedTableDef,
  gsiBTableDef,
  cleanupItems,
  declareTables,
} from '../../../src/helpers.js'

// The write cases that put an invalid value on a secondary index key, kept out
// of batchWriteItem.test.ts, putItem.test.ts and updateItem.test.ts so those
// files declare no indexed table. Every case here needs a real index for the
// index-key validator to run at all, so they group by operation rather than by
// file of origin.
//
// Strings captured from real AWS, invariant across four regions (eu-west-2,
// us-east-1, ap-southeast-2, eu-central-1; 2026-06-23). The composite messages
// name gsi1, the alphabetically-first index lsi1sk keys on
// compositeIndexedTableDef; the binary ones name gsib on gsiBTableDef, whose
// index key attribute is declared type B so an empty binary value reaches the
// secondary-index-key validator rather than a type-mismatch check.
declareTables(compositeIndexedTableDef, gsiBTableDef)

// Defensive: these cases fail validation and write nothing; clean up anyway in
// case a too-lenient target persists them.
const compositeKeysToCleanup = [
  { pk: { S: 'em-bw-idx-type' }, sk: { S: 'a' } },
  { pk: { S: 'em-bw-idx-nonscalar' }, sk: { S: 'b' } },
  { pk: { S: 'em-bw-idx-empty' }, sk: { S: 'c' } },
]

afterAll(async () => {
  await cleanupItems(compositeIndexedTableDef.name, compositeKeysToCleanup)
})

describe('BatchWriteItem — index key error messages', { tags: ['batch', 'data-plane', 'negative-path', 'gsi', 'lsi'] }, () => {
  // BatchWriteItem validates up front, so every variant is a top-level
  // ValidationException (no cancellation path).
  const expectExactValidation = async (
    command: BatchWriteItemCommand,
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

  it('wrong-typed index key: full type-mismatch message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: {
          [compositeIndexedTableDef.name]: [
            { PutRequest: { Item: { pk: { S: 'em-bw-idx-type' }, sk: { S: 'a' }, lsi1sk: { N: '5' } } } },
          ],
        },
      }),
      'One or more parameter values were invalid: Type mismatch for Index Key lsi1sk Expected: S Actual: N IndexName: gsi1',
    )
  })

  it('non-scalar index key: full type-mismatch message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: {
          [compositeIndexedTableDef.name]: [
            { PutRequest: { Item: { pk: { S: 'em-bw-idx-nonscalar' }, sk: { S: 'b' }, lsi1sk: { L: [{ S: 'x' }] } } } },
          ],
        },
      }),
      'One or more parameter values were invalid: Type mismatch for Index Key lsi1sk Expected: S Actual: L IndexName: gsi1',
    )
  })

  it('empty-string index key: full secondary-index-key message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: {
          [compositeIndexedTableDef.name]: [
            { PutRequest: { Item: { pk: { S: 'em-bw-idx-empty' }, sk: { S: 'c' }, lsi1sk: { S: '' } } } },
          ],
        },
      }),
      'One or more parameter values are not valid. A value specified for a secondary index key is not supported. The AttributeValue for a key attribute cannot contain an empty string value. IndexName: gsi1, IndexKey: lsi1sk',
    )
  })

  it('empty-binary index key: full secondary-index-key message', async () => {
    await expectExactValidation(
      new BatchWriteItemCommand({
        RequestItems: {
          [gsiBTableDef.name]: [
            { PutRequest: { Item: { pk: { S: 'eb-bw-idx' }, bidx: { B: new Uint8Array([]) } } } },
          ],
        },
      }),
      'One or more parameter values are not valid. A value specified for a secondary index key is not supported. The AttributeValue for a key attribute cannot contain an empty binary value. IndexName: gsib, IndexKey: bidx',
    )
  })
})

describe('PutItem — index key error messages', { tags: ['put-item', 'data-plane', 'negative-path', 'gsi', 'lsi'] }, () => {
  it('empty-binary index key value: full secondary-index-key message', async () => {
    // Real AWS rejects a zero-length binary value on a secondary index key with
    // the put-form secondary-index message, naming the index and key.
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: gsiBTableDef.name,
          Item: { pk: { S: 'eb-idx' }, bidx: { B: new Uint8Array([]) } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values are not valid. A value specified for a secondary index key is not supported. The AttributeValue for a key attribute cannot contain an empty binary value. IndexName: gsib, IndexKey: bidx',
      )
    }
  })
})

describe('UpdateItem — index key error messages', { tags: ['update-item', 'data-plane', 'negative-path', 'gsi', 'lsi'] }, () => {
  it('empty-binary index key value: full secondary-index-key message', async () => {
    // Real AWS rejects a SET of a zero-length binary value on a secondary index
    // key with the update-form message (no IndexName/IndexKey suffix).
    try {
      await ddb.send(
        new UpdateItemCommand({
          TableName: gsiBTableDef.name,
          Key: { pk: { S: 'eb-idx-upd' } },
          UpdateExpression: 'SET bidx = :v',
          ExpressionAttributeValues: { ':v': { B: new Uint8Array([]) } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values are not valid. The update expression attempted to update a secondary index key to a value that is not supported. The AttributeValue for a key attribute cannot contain an empty binary value.',
      )
    }
  })
})
