import {
  GetItemCommand,
  DynamoDBServiceException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  hashBTableDef,
  compositeTableDef,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef, hashBTableDef, compositeTableDef)

describe('GetItem — exact error messages', { tags: ['get-item', 'data-plane', 'negative-path'] }, () => {
  it('non-existent table: full ResourceNotFoundException message', async () => {
    try {
      await ddb.send(
        new GetItemCommand({
          TableName: '_conformance_does_not_exist_em_get',
          Key: { pk: { S: 'test' } },
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

  it('malformed Key (missing range key on composite table): full schema-mismatch error', async () => {
    try {
      await ddb.send(
        new GetItemCommand({
          TableName: compositeTableDef.name,
          Key: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'The provided key element does not match the schema',
      )
    }
  })

  it('invalid ProjectionExpression syntax: full parser error', async () => {
    try {
      await ddb.send(
        new GetItemCommand({
          TableName: hashTableDef.name,
          Key: { pk: { S: 'test' } },
          ProjectionExpression: '!!! INVALID !!!',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Syntax error; token: "!", near: "!!"',
      )
    }
  })

  it('empty-binary key value: full ValidationException message', async () => {
    // Real AWS rejects a zero-length binary key value with a top-level
    // ValidationException, the binary analogue of the empty-string key rejection.
    try {
      await ddb.send(
        new GetItemCommand({
          TableName: hashBTableDef.name,
          Key: { pk: { B: new Uint8Array([]) } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty binary value. Key: pk',
      )
    }
  })
})

describe('GetItem — ProjectionExpression rejection messages', { tags: ['get-item', 'data-plane', 'negative-path'] }, () => {
  // Duplicate and overlapping projection paths are rejected before the read, so
  // none of these needs a seeded item. GetItem carries the full syntax
  // permutation set (raw, aliased, mixed, order-reversed, cross-alias,
  // list-parent); the expression machinery is shared, so Query, Scan and
  // BatchGetItem pin the core cases in their own files. Real DynamoDB renders
  // path elements comma-separated inside brackets ([a, b] for a.b, [l, [0]]
  // for l[0]) and returns the same message from all four read operations.
  const getWithProjection = (expr: string, names?: Record<string, string>) =>
    ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'em-get-proj' } },
        ProjectionExpression: expr,
        ...(names ? { ExpressionAttributeNames: names } : {}),
      }),
    )

  it('raw duplicate paths (a, a): full overlap message with the path on both sides', async () => {
    try {
      await getWithProjection('a, a')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })

  it('same alias twice (#a, #a): full overlap message', async () => {
    try {
      await getWithProjection('#a, #a', { '#a': 'a' })
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
    // The message reports the resolved attribute name on both sides, showing
    // the duplicate check runs after alias resolution rather than on the raw
    // tokens. The message assertion is the discriminating half of this test:
    // the error type alone would also pass for a target that rejects the
    // request for an unrelated reason.
    try {
      await getWithProjection('#a, #b', { '#a': 'a', '#b': 'a' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })

  it('raw path plus alias for the same attribute (a, #a): full overlap message', async () => {
    try {
      await getWithProjection('a, #a', { '#a': 'a' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]',
      )
    }
  })

  it('raw parent and child paths (a, a.b): full overlap message', async () => {
    try {
      await getWithProjection('a, a.b')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a, b]',
      )
    }
  })

  it('aliased parent and child paths (#a, #a.#b): full overlap message', async () => {
    try {
      await getWithProjection('#a, #a.#b', { '#a': 'a', '#b': 'b' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a, b]',
      )
    }
  })

  it('child before parent (a.b, a): rejected with the paths in request order', async () => {
    try {
      await getWithProjection('a.b, a')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a, b], path two: [a]',
      )
    }
  })

  it('cross-alias overlap (#x, #y.#b with #x and #y -> a): rejected on the resolved paths', async () => {
    try {
      await getWithProjection('#x, #y.#b', { '#x': 'a', '#y': 'a', '#b': 'b' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a, b]',
      )
    }
  })

  it('deep overlap (a, a.b.c): full overlap message with the three-element path', async () => {
    try {
      await getWithProjection('a, a.b.c')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a, b, c]',
      )
    }
  })

  it('list parent and list index (l, l[0]): rejected as an overlap', async () => {
    // A whole list and one of its elements overlap the same way a map and its
    // child do, even though projected list indices are otherwise reconstruction
    // instructions (distinct indices compact into a fresh list). The index is
    // rendered as its own path element: [l, [0]].
    try {
      await getWithProjection('l, l[0]')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [l], path two: [l, [0]]',
      )
    }
  })

  it('undefined attribute name (#undef): full undefined-name message', async () => {
    try {
      await getWithProjection('#undef')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid ProjectionExpression: An expression attribute name used in the document path is not defined; attribute name: #undef',
      )
    }
  })
})
