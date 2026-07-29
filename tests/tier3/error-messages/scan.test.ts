import {
  PutItemCommand,
  ScanCommand,
  DynamoDBServiceException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  cleanupItems,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('Scan — exact error messages', { tags: ['scan', 'data-plane', 'negative-path'] }, () => {
  it('Segment without TotalSegments: full required-parameter error', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          Segment: 0,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The TotalSegments parameter is required but was not present in the request when Segment parameter is present',
      )
    }
  })

  it('Segment >= TotalSegments: full out-of-range error', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          Segment: 5,
          TotalSegments: 5,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The Segment parameter is zero-based and must be less than parameter TotalSegments: Segment: 5 is not less than TotalSegments: 5',
      )
    }
  })

  it('TotalSegments without Segment: full required-parameter error', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          TotalSegments: 4,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The Segment parameter is required but was not present in the request when parameter TotalSegments is present',
      )
    }
  })

  it('Limit of 0: full minimum-value error', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          Limit: 0,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value '0' at 'limit' failed to satisfy constraint: Member must have value greater than or equal to 1",
      )
    }
  })

  it('non-existent table: full ResourceNotFoundException message', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: '_conformance_does_not_exist_em_scan',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceNotFoundException)
      expect((err as ResourceNotFoundException).name).toBe(
        'ResourceNotFoundException',
      )
      expect((err as ResourceNotFoundException).message).toBe(
        'Requested resource not found',
      )
    }
  })

  it('begins_with with non-string operand: full operand-type error', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          FilterExpression: 'begins_with(#a, :n)',
          ExpressionAttributeNames: { '#a': 'data' },
          ExpressionAttributeValues: { ':n': { N: '1' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid FilterExpression: Incorrect operand type for operator or function; operator or function: begins_with, operand type: N',
      )
    }
  })

  it('redundant parentheses in FilterExpression: full error string', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          FilterExpression: '((#a = :v))',
          ExpressionAttributeNames: { '#a': 'data' },
          ExpressionAttributeValues: { ':v': { S: 'x' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid FilterExpression: The expression has redundant parentheses;',
      )
    }
  })

  // Scan returns the long form of the invalid-starting-key error; Query returns
  // a shorter one (see query.test.ts). Pin each separately.
  it('malformed ExclusiveStartKey: long schema-mismatch error', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          ExclusiveStartKey: { bad: { S: 'p' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The provided starting key is invalid: The provided key element does not match the schema',
      )
    }
  })

  // Parity with Query: SPECIFIC_ATTRIBUTES needs a ProjectionExpression (or legacy
  // AttributesToGet); with neither, real DynamoDB rejects before reading.
  it('Select SPECIFIC_ATTRIBUTES without ProjectionExpression: full required-projection message', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          Select: 'SPECIFIC_ATTRIBUTES',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Must specify the AttributesToGet or ProjectionExpression when choosing to get SPECIFIC_ATTRIBUTES',
      )
    }
  })
})

describe('Scan — ProjectionExpression rejection messages', { tags: ['scan', 'data-plane', 'negative-path'] }, () => {
  // The rejections run under a filter matching nothing. A Scan reads every row
  // and filters afterwards, so an empty-result rejection proves the projection
  // check precedes emission (the Query variant is what proves it precedes row
  // evaluation). The matching-filter control at the end proves the rejection is
  // not an artefact of the empty result.
  const scanWithProjection = (
    pk: string,
    expr: string,
    names?: Record<string, string>,
  ) =>
    ddb.send(
      new ScanCommand({
        TableName: hashTableDef.name,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: pk } },
        ProjectionExpression: expr,
        ...(names ? { ExpressionAttributeNames: names } : {}),
      }),
    )
  const noMatch = 'em-scan-proj-no-such-pk'

  it('duplicate paths (a, a) reject even when the filter matches nothing', async () => {
    try {
      await scanWithProjection(noMatch, 'a, a')
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
      await scanWithProjection(noMatch, '#a, #b', { '#a': 'a', '#b': 'a' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })

  it('overlapping parent and child paths (a, a.b) reject even when the filter matches nothing', async () => {
    try {
      await scanWithProjection(noMatch, 'a, a.b')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a, b]',
      )
    }
  })

  it('rejects an undefined projection name even when the scan matches nothing', async () => {
    // The undefined-name check fires before row evaluation, so a scan that
    // matches no rows still rejects rather than returning an empty result.
    try {
      await scanWithProjection(noMatch, '#undef')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: An expression attribute name used in the document path is not defined; attribute name: #undef',
      )
    }
  })

  it('duplicate paths still reject when the filter matches a row (control)', async () => {
    // The control proving the empty-result rejections above are not an
    // artefact of the empty result: with a row the filter genuinely matches,
    // the same request still rejects rather than returning the row.
    const pk = 'em-scan-proj-ctl'
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, a: { S: 'alpha' } },
      }),
    )
    try {
      await scanWithProjection(pk, 'a, a')
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
