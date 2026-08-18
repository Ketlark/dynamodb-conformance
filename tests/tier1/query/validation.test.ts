import { QueryCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, compositeTableDef, expectDynamoError, absentTableName } from '../../../src/helpers.js'

declareTables(compositeTableDef)

describe('Query — validation', { tags: ['query', 'data-plane', 'negative-path'] }, () => {
  it('rejects query on non-existent table', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: absentTableName('nonexistent_table'),
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': { S: 'test' } },
          }),
        ),
      'ResourceNotFoundException',
    )
  })

  it('rejects query without KeyConditionExpression', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new QueryCommand({
            TableName: compositeTableDef.name,
          }),
        ),
      'ValidationException',
    )
  })
})
