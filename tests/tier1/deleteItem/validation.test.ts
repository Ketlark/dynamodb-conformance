import { DeleteItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { expectDynamoError, absentTableName } from '../../../src/helpers.js'

describe('DeleteItem — validation', { tags: ['delete-item', 'data-plane', 'negative-path'] }, () => {
  it('rejects DeleteItem on a non-existent table', async () => {
    await expectDynamoError(
      () => ddb.send(
        new DeleteItemCommand({
          TableName: absentTableName('nonexistent_table'),
          Key: { pk: { S: 'test' } },
        }),
      ),
      'ResourceNotFoundException',
    )
  })
})
