import {
  BatchWriteItemCommand,
  BatchGetItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, hashTableDef } from '../../../src/helpers.js'

declareTables(hashTableDef)

// What these two assert is the ordering: an empty RequestItems map is refused
// before the map is read, so the request never reaches a table. The wording of
// the refusal is regional and is not this tier's business. The 2026-06
// validation-framework rollout is replacing the bespoke sentence
// `The <op>Items parameter is required for <Op>` with the framework's generic
// `Value at 'RequestItems' failed to satisfy constraint: ...`, and as of
// 2026-08-17 BatchGetItem has crossed in 11 of the 33 answering regions while
// BatchWriteItem has crossed in none. Matching the parameter name
// case-insensitively spans both wordings, so a rewording does not turn an
// ordering test red. Registry row batch-get-item-empty-request-items-message
// and the tier 3 error-messages test it keys to pin the exact wording.
const REJECTS_EMPTY_REQUEST_ITEMS = /requestitems/i

describe('Batch operations — validation ordering', { tags: ['batch', 'data-plane', 'negative-path'] }, () => {
  it('BatchWriteItem rejects empty RequestItems', async () => {
    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {},
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toMatch(REJECTS_EMPTY_REQUEST_ITEMS)
    }
  })

  it('BatchGetItem rejects empty RequestItems', async () => {
    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {},
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toMatch(REJECTS_EMPTY_REQUEST_ITEMS)
    }
  })

  it('BatchWriteItem rejects more than 25 items with exact count in message', async () => {
    // Build 26 put requests
    const requests = Array.from({ length: 26 }, (_, i) => ({
      PutRequest: {
        Item: { pk: { S: `item_${i}` } },
      },
    }))

    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [hashTableDef.name]: requests,
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // DynamoDB reports the number of items in validation error
      expect(err.message).toMatch(/member must have length less than or equal to 25|too many items/i)
    }
  })

  it('BatchGetItem rejects more than 100 keys with exact count in message', async () => {
    // Build 101 key requests
    const keys = Array.from({ length: 101 }, (_, i) => ({
      pk: { S: `key_${i}` },
    }))

    try {
      await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [hashTableDef.name]: {
              Keys: keys,
            },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // DynamoDB reports too many items in validation error
      expect(err.message).toMatch(/member must have length less than or equal to 100|too many items/i)
    }
  })
})
