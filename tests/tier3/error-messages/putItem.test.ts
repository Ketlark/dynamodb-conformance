import {
  PutItemCommand,
  GetItemCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  hashBTableDef,
  gsiBTableDef,
  cleanupItems,
} from '../../../src/helpers.js'
import { observeSplit, recordObserved } from '../../../src/observation-sink.js'

const keysToCleanup = [
  { pk: { S: 'em-put-null-false' } },
]

afterAll(async () => {
  await cleanupItems(hashTableDef.name, keysToCleanup)
})

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('PutItem — exact error messages', { tags: ['put-item', 'data-plane'] }, () => {
  it('missing table name: full validation error string', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: undefined as unknown as string,
          Item: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value null at 'tableName' failed to satisfy constraint: Member must not be null",
      )
    }
  })

  it('empty table name: minimum length 1 error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: '',
          Item: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      // Structural assertion: pin the contractual field and constraint, float
      // the envelope prefix, echoed value and field casing that AWS varies by
      // region (2026-06 four-region capture; same idea as createTable's
      // backend-variant handling). See CONTRIBUTING, "error-messages".
      expect((err as DynamoDBServiceException).message.toLowerCase()).toContain(
        "tablename",
      )
      expect((err as DynamoDBServiceException).message).toContain(
        'failed to satisfy constraint: Member must have length greater than or equal to 1',
      )
    }
  })

  it('table name too long (256 chars): maximum length 255 error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: 'a'.repeat(256),
          Item: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        `1 validation error detected: Value '${'a'.repeat(256)}' at 'tableName' failed to satisfy constraint: Member must have length less than or equal to 255`,
      )
    }
  })

  it('table name with invalid chars: regex pattern error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: 'bad table!@#',
          Item: { pk: { S: 'test' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value 'bad table!@#' at 'tableName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_.-]+",
      )
    }
  })

  it('empty string set: full parameter-values-invalid error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: [] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: An string set  may not be empty',
      )
    }
  })

  it('empty number set: full parameter-values-invalid error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { NS: [] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: An number set  may not be empty',
      )
    }
  })

  it('duplicate values in SS: full duplicates error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: ['a', 'a'] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      // Float the collection rendering (["a", "a"] in newer regions, [a, a] in
      // older ones); pin the bespoke message either side of it.
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Input collection',
      )
      expect((err as DynamoDBServiceException).message).toContain('contains duplicates')
    }
  })

  it('empty binary set: full parameter-values-invalid error', async () => {
    // Binary uses entirely different wording from the string/number set
    // messages (no two-space quirk, different verb).
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { BS: [] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Binary sets should not be empty',
      )
    }
  })

  it('empty string member in NS: numeric conversion error', async () => {
    // A set may hold an empty string member (SS) or zero-length binary member
    // (BS); NS rejects '' because it is not a number, not because it is empty.
    // Structural assertion: the core is invariant across the 2026-07 four-region
    // capture; newer-wording regions add the envelope prefix and echo the
    // (empty) offending value after a trailing colon, both floated here.
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { NS: [''] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'The parameter cannot be converted to a numeric value',
      )
    }
  })

  it('duplicate empty string members in SS: full duplicates error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' }, bad: { SS: ['', ''] } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      // Float the collection rendering and any envelope prefix; pin the bespoke
      // message either side of it, as the non-empty duplicate case above does.
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Input collection',
      )
      expect((err as DynamoDBServiceException).message).toContain('contains duplicates')
    }
  })

  it('duplicate zero-length members in BS: full duplicates error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: {
            pk: { S: 'test' },
            bad: { BS: [new Uint8Array(0), new Uint8Array(0)] },
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'One or more parameter values were invalid: Input collection',
      )
      // The binary form names the set type, with AWS's missing space before
      // 'of' ("...]of type BS...") - invariant across the 2026-07 four-region
      // capture, only the collection rendering and envelope vary.
      expect((err as DynamoDBServiceException).message).toContain(
        'of type BS contains duplicates',
      )
    }
  })

  it('NULL attr with false is accepted and normalises to NULL true', async (ctx) => {
    // AWS behaviour change captured 2026-06-08 (eu-west-2): PutItem with a
    // { NULL: false } attribute is no longer rejected. The value is accepted
    // and normalises to { NULL: true } on read. This is a split behaviour
    // (registry row put-item-null-false-attribute-value): most regions still
    // reject it, so the target's actual answer is recorded for per-region
    // scoring.
    await observeSplit(ctx.task, () =>
      ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'em-put-null-false' }, attr1: { NULL: false } },
        }),
      ),
    )
    const got = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: 'em-put-null-false' } },
        ConsistentRead: true,
      }),
    )
    expect(got.Item).toEqual({
      pk: { S: 'em-put-null-false' },
      attr1: { NULL: true },
    })
    // The registry row records the accepting regions' answer with this exact
    // detail, which may only be claimed once the whole committed assertion
    // has held - recording it before the read-back assertion would let a
    // target that normalises attr1 but corrupts the item elsewhere carry a
    // verified-looking observation out of a failing test, and per-region
    // scoring would credit the accepting regions with a pass the suite
    // itself marked red. Any earlier failure leaves the provisional detail
    // from observeSplit, which matches no region.
    recordObserved(ctx.task, {
      outcome: 'accepted',
      detail: 'stored, and normalised to { NULL: true } on read',
    })
  })

  it('mixing expression and non-expression: full conflict error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' } },
          Expected: { pk: { Exists: false } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Can not use both expression and non-expression parameters in the same request: Non-expression parameters: {Expected} Expression parameters: {ConditionExpression}',
      )
    }
  })

  it('ExpressionAttributeValues without expression: full unused-EAV error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'test' } },
          ExpressionAttributeValues: { ':v': { S: 'unused' } },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'ExpressionAttributeValues can only be specified when using expressions',
      )
    }
  })

  it('redundant parentheses in ConditionExpression: full error string', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'em-put-redundant' } },
          ConditionExpression: '((attribute_not_exists(pk)))',
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Invalid ConditionExpression: The expression has redundant parentheses;',
      )
    }
  })

  it('contains() with duplicate path and operand: full distinct-operand error', async () => {
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: 'em-put-contains-dup' } },
          ConditionExpression: 'contains(#a, #a)',
          ExpressionAttributeNames: { '#a': 'data' },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toContain(
        'Invalid ConditionExpression: The first operand must be distinct from the remaining operands for this operator or function; operator: contains, first operand: [data]',
      )
    }
  })

  it('empty-binary item key value: full ValidationException message', async () => {
    // Real AWS rejects a zero-length binary key value with a top-level
    // ValidationException, the binary analogue of the empty-string key rejection.
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: hashBTableDef.name,
          Item: { pk: { B: new Uint8Array([]) } },
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
