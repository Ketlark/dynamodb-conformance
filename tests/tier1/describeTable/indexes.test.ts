import { DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  compositeIndexedTableDef,
  declareTables,
} from '../../../src/helpers.js'

declareTables(compositeIndexedTableDef)

describe('DescribeTable — secondary indexes', { tags: ['describe-table', 'control-plane', 'gsi', 'lsi'] }, () => {
  it('returns table metadata for a composite table with indexes', async () => {
    const result = await ddb.send(
      new DescribeTableCommand({ TableName: compositeIndexedTableDef.name }),
    )
    const table = result.Table!

    expect(table.TableName).toBe(compositeIndexedTableDef.name)
    expect(table.KeySchema).toHaveLength(2)

    // LSIs
    expect(table.LocalSecondaryIndexes).toBeDefined()
    expect(table.LocalSecondaryIndexes).toHaveLength(2)

    // GSIs
    expect(table.GlobalSecondaryIndexes).toBeDefined()
    expect(table.GlobalSecondaryIndexes).toHaveLength(2)

    // Each GSI should have IndexStatus
    for (const gsi of table.GlobalSecondaryIndexes!) {
      expect(gsi.IndexName).toBeDefined()
      expect(gsi.IndexStatus).toBe('ACTIVE')
      expect(gsi.KeySchema).toBeDefined()
      expect(gsi.Projection).toBeDefined()
    }
  })
})
