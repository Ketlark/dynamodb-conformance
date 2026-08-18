import { GetItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, compositeTableDef, expectDynamoError, absentTableName } from '../../../src/helpers.js'

declareTables(compositeTableDef)

describe('GetItem — validation', { tags: ['get-item', 'data-plane', 'negative-path'] }, () => {
  it('rejects GetItem on a non-existent table', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new GetItemCommand({
            TableName: absentTableName('nonexistent_table'),
            Key: { pk: { S: 'test' } },
          }),
        ),
      'ResourceNotFoundException',
    )
  })

  it('rejects GetItem with missing range key on composite table', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new GetItemCommand({
            TableName: compositeTableDef.name,
            Key: { pk: { S: 'test' } }, // missing sk
          }),
        ),
      'ValidationException',
    )
  })
})
