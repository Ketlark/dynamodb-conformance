import {
  CreateTableCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  uniqueTableName,
  deleteTable,
} from '../../../src/helpers.js'

describe('CreateTable — exact error messages', { tags: ['create-table', 'control-plane', 'negative-path'] }, () => {
  const tablesToCleanup: string[] = []

  afterAll(async () => {
    await Promise.all(tablesToCleanup.map(deleteTable))
  })

  it('missing TableName: full required-parameter error', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: undefined as unknown as string,
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "The parameter 'TableName' is required but was not present in the request",
      )
    }
  })

  it('short table name (2 chars): minimum length 3 error', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: 'ab',
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value 'ab' at 'tableName' failed to satisfy constraint: Member must have length greater than or equal to 3",
      )
    }
  })

  it('duplicate attribute in KeySchema', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('ct_dup_key'),
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'pk', KeyType: 'RANGE' },
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid KeySchema: Some index key attribute have no definition',
      )
    }
  })

  it('more than 2 KeySchema elements', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('ct_3keys'),
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
            { AttributeName: 'extra', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
            { AttributeName: 'extra', KeyType: 'RANGE' } as any,
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      // AWS's serialiser renders KeySchemaElement two different ways
      // depending on which backend serves the request — sometimes the
      // friendly form `KeySchemaElement(attributeName=…, keyType=…)`, and
      // sometimes the Java default `com.amazonaws.dynamodb.v…@<hash>`.
      // The variance is server-side, not input-driven, so the structural
      // pattern from `conditionalCheck.test.ts` doesn't apply. Anchored
      // regex tolerates both shapes while still pinning the prefix, the
      // element count, and the suffix exactly.
      const elementShape = String.raw`(?:KeySchemaElement\(attributeName=\w+, keyType=(?:HASH|RANGE)\)|com\.amazonaws\.dynamodb\.v\d+\.KeySchemaElement@[0-9a-f]+)`
      expect((err as DynamoDBServiceException).message).toMatch(
        new RegExp(
          `^1 validation error detected: Value '\\[${elementShape}(, ${elementShape}){2}\\]' at 'keySchema' failed to satisfy constraint: Member must have length less than or equal to 2$`,
        ),
      )
    }
  })

  it('invalid KeyType', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('ct_bad_keytype'),
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [
            // @ts-expect-error -- testing invalid KeyType
            { AttributeName: 'pk', KeyType: 'INVALID' },
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value 'INVALID' at 'keySchema.1.member.keyType' failed to satisfy constraint: Member must satisfy enum value set: [HASH, RANGE]",
      )
    }
  })

  it('invalid AttributeType', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('ct_bad_attrtype'),
          // @ts-expect-error -- testing invalid AttributeType
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'INVALID' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        "1 validation error detected: Value 'INVALID' at 'attributeDefinitions.1.member.attributeType' failed to satisfy constraint: Member must satisfy enum value set: [B, N, S]",
      )
    }
  })

  it('LSI without range key on base table', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('ct_lsi_no_range'),
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'lsiSk', AttributeType: 'S' },
          ],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          LocalSecondaryIndexes: [
            {
              IndexName: 'lsi1',
              KeySchema: [
                { AttributeName: 'pk', KeyType: 'HASH' },
                { AttributeName: 'lsiSk', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: Table KeySchema does not have a range key, which is required when specifying a LocalSecondaryIndex',
      )
    }
  })

  it('duplicate index names', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('ct_dup_idx'),
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
            { AttributeName: 'gsiPk1', AttributeType: 'S' },
            { AttributeName: 'gsiPk2', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'sameIndex',
              KeySchema: [{ AttributeName: 'gsiPk1', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            },
            {
              IndexName: 'sameIndex',
              KeySchema: [{ AttributeName: 'gsiPk2', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'ALL' },
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
            },
          ],
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: Duplicate index name: sameIndex',
      )
    }
  })

  it('PAY_PER_REQUEST with ProvisionedThroughput: full conflict message', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('em_ct_ppr_tp'),
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST',
      )
    }
  })

  it('GSI INCLUDE projection without NonKeyAttributes: full missing-attributes message', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('em_ct_include_nonk'),
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'gsipk', AttributeType: 'S' },
          ],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi_inc',
              KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
              Projection: { ProjectionType: 'INCLUDE' },
            },
          ],
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: ProjectionType is INCLUDE, but NonKeyAttributes is not specified',
      )
    }
  })

  it('StreamSpecification StreamEnabled:false with a StreamViewType: full conflict message', async () => {
    try {
      await ddb.send(
        new CreateTableCommand({
          TableName: uniqueTableName('em_ct_stream_false_vt'),
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST',
          StreamSpecification: {
            StreamEnabled: false,
            StreamViewType: 'NEW_AND_OLD_IMAGES',
          },
        }),
      )
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'One or more parameter values were invalid: Table is being created with a stream disabled, UpdateViewType should not be specified',
      )
    }
  })
})
