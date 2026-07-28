import {
  QueryCommand,
  ScanCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { compositeIndexedTableDef, declareTables } from '../../../src/helpers.js'

// The index-bearing error-message cases, kept out of query.test.ts and
// scan.test.ts so those files declare no indexed table. Each request names a
// real index, so the rejection is the message under test rather than an
// index-not-found error.
declareTables(compositeIndexedTableDef)

describe('Query — index error messages', { tags: ['query', 'data-plane', 'negative-path', 'gsi'] }, () => {
  it('ConsistentRead on GSI', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeIndexedTableDef.name,
          IndexName: 'gsi1',
          KeyConditionExpression: '#hk = :v',
          ExpressionAttributeNames: { '#hk': 'lsi1sk' },
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          ConsistentRead: true,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Consistent reads are not supported on global secondary indexes',
      )
    }
  })
})

describe('Scan — index error messages', { tags: ['scan', 'data-plane', 'negative-path', 'gsi'] }, () => {
  // Parity with Query: a Scan on a GSI cannot ask for a strongly consistent read.
  it('ConsistentRead on a GSI: full consistent-reads-unsupported message', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: compositeIndexedTableDef.name,
          IndexName: 'gsi1',
          ConsistentRead: true,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Consistent reads are not supported on global secondary indexes',
      )
    }
  })
})
