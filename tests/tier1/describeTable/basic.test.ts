import { DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('DescribeTable — basic', { tags: ['describe-table', 'control-plane'] }, () => {
  it('returns table metadata for a hash-only table', async () => {
    const result = await ddb.send(
      new DescribeTableCommand({ TableName: hashTableDef.name }),
    )
    const table = result.Table!

    expect(table.TableName).toBe(hashTableDef.name)
    expect(table.TableStatus).toBe('ACTIVE')
    expect(table.KeySchema).toEqual([
      { AttributeName: 'pk', KeyType: 'HASH' },
    ])
    expect(table.AttributeDefinitions).toEqual([
      { AttributeName: 'pk', AttributeType: 'S' },
    ])
    expect(table.TableArn).toBeDefined()
    expect(table.CreationDateTime).toBeDefined()
    expect(table.ItemCount).toBeDefined()
    expect(table.TableSizeBytes).toBeDefined()
  })
})

describe('DescribeTable — TableId', { tags: ['describe-table', 'control-plane'] }, () => {
  it('returns a stable TableId across repeated DescribeTable calls', async () => {
    const first = await ddb.send(
      new DescribeTableCommand({ TableName: hashTableDef.name }),
    )
    const second = await ddb.send(
      new DescribeTableCommand({ TableName: hashTableDef.name }),
    )

    const id = first.Table!.TableId
    expect(typeof id).toBe('string')
    expect(id!.length).toBeGreaterThan(0)
    // TableId is an identity that does not change between reads of the same table.
    expect(second.Table!.TableId).toBe(id)
  })
})

describe('DescribeTable — validation', { tags: ['describe-table', 'control-plane', 'negative-path'] }, () => {
  it('returns ResourceNotFoundException for non-existent table', async () => {
    await expectDynamoError(
      () => ddb.send(
        new DescribeTableCommand({
          TableName: '_conformance_nonexistent_table',
        }),
      ),
      'ResourceNotFoundException',
    )
  })
})
