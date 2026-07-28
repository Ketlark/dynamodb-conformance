import {
  PutItemCommand,
  QueryCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  compositeTableDef,
  hashTableDef,
  cleanupItems,
  declareTables,
} from '../../../src/helpers.js'

declareTables(compositeTableDef, hashTableDef)

describe('Query — exact error messages', { tags: ['query', 'data-plane', 'negative-path'] }, () => {
  it('missing hash key in KeyConditionExpression', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: 'sk = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Query condition missed key schema element: pk',
      )
    }
  })

  it('non-key attribute in KeyConditionExpression', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: 'attr1 = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Query condition missed key schema element: pk',
      )
    }
  })

  it('unused ExpressionAttributeNames', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: 'pk = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          ExpressionAttributeNames: { '#unused': 'someattr' },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Value provided in ExpressionAttributeNames unused in expressions: keys: {#unused}',
      )
    }
  })

  it('invalid Select value', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: 'pk = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          // @ts-expect-error -- testing invalid Select
          Select: 'INVALID_VALUE',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value 'INVALID_VALUE' at 'select' failed to satisfy constraint: Member must satisfy enum value set: [SPECIFIC_ATTRIBUTES, COUNT, ALL_ATTRIBUTES, ALL_PROJECTED_ATTRIBUTES]",
      )
    }
  })

  it('Limit of 0', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: 'pk = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          Limit: 0,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value at 'Limit' failed to satisfy constraint: Member must have value greater than or equal to 1",
      )
    }
  })

  it('empty KeyConditionExpression', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: '',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid KeyConditionExpression: The expression can not be empty;',
      )
    }
  })

  it('filter references undefined ExpressionAttributeNames', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: 'pk = :pk',
          FilterExpression: '#missing = :fv',
          ExpressionAttributeValues: { ':pk': { S: 'val' }, ':fv': { S: 'x' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid FilterExpression: An expression attribute name used in the document path is not defined; attribute name: #missing',
      )
    }
  })

  it('redundant parentheses in KeyConditionExpression: full error string', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: hashTableDef.name,
          KeyConditionExpression: '((pk = :v))',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid KeyConditionExpression: The expression has redundant parentheses;',
      )
    }
  })

  // Query and Scan return different messages for the same malformed key: Query
  // gives this short form, Scan gives a longer one (see scan.test.ts).
  it('malformed ExclusiveStartKey: short invalid-starting-key error', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: 'pk = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          ExclusiveStartKey: { bad: { S: 'p' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The provided starting key is invalid',
      )
    }
  })

  // SPECIFIC_ATTRIBUTES needs a ProjectionExpression (or legacy AttributesToGet);
  // with neither, real DynamoDB rejects before reading. Query and Scan apply the
  // same rule but word it differently: Query wraps the phrase in the
  // "1 validation error detected:" envelope, Scan returns it bare (see scan.test.ts).
  it('Select SPECIFIC_ATTRIBUTES without ProjectionExpression: full required-projection message', async () => {
    try {
      await ddb.send(
        new QueryCommand({
          TableName: compositeTableDef.name,
          KeyConditionExpression: 'pk = :v',
          ExpressionAttributeValues: { ':v': { S: 'val' } },
          Select: 'SPECIFIC_ATTRIBUTES',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        '1 validation error detected: Must specify the AttributesToGet or ProjectionExpression when choosing to get SPECIFIC_ATTRIBUTES',
      )
    }
  })
})

describe('Query — ProjectionExpression rejection messages', { tags: ['query', 'data-plane', 'negative-path'] }, () => {
  // The rejections run against a key condition matching no partition: a target
  // that only validates the projection per matched row would return an empty
  // result here instead of throwing, so the zero-match request proves the check
  // precedes row evaluation. The matching-partition control at the end proves
  // the rejection is not an artefact of the empty result. Query returns these
  // messages bare, with no "1 validation error detected:" envelope, unlike
  // some of its other rejections.
  const queryWithProjection = (
    pk: string,
    expr: string,
    names?: Record<string, string>,
  ) =>
    ddb.send(
      new QueryCommand({
        TableName: hashTableDef.name,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: pk } },
        ProjectionExpression: expr,
        ...(names ? { ExpressionAttributeNames: names } : {}),
      }),
    )
  const noMatch = 'em-query-proj-no-such-partition'

  it('duplicate paths (a, a) reject even when the key condition matches no partition', async () => {
    try {
      await queryWithProjection(noMatch, 'a, a')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })

  it('two distinct aliases resolving to one attribute (#a, #b -> a): rejected on the resolved names', async () => {
    try {
      await queryWithProjection(noMatch, '#a, #b', { '#a': 'a', '#b': 'a' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })

  it('overlapping parent and child paths (a, a.b) reject even when the key condition matches no partition', async () => {
    try {
      await queryWithProjection(noMatch, 'a, a.b')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a, b]',
      )
    }
  })

  it('duplicate paths still reject when the key condition matches a partition (control)', async () => {
    // The control proving the zero-match rejections above are not an artefact
    // of the empty result: with a row genuinely in the partition, the same
    // request still rejects rather than returning the row.
    const pk = 'em-query-proj-ctl'
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, a: { S: 'alpha' } },
      }),
    )
    try {
      await queryWithProjection(pk, 'a, a')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    } finally {
      await cleanupItems(hashTableDef.name, [{ pk: { S: pk } }])
    }
  })
})
