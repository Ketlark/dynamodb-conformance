import { ScanCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { expectDynamoError } from '../../../src/helpers.js'

describe('Scan — validation', { tags: ['scan', 'data-plane', 'negative-path'] }, () => {
  it('rejects scan on non-existent table', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new ScanCommand({
            TableName: '_conformance_nonexistent_table',
          }),
        ),
      'ResourceNotFoundException',
    )
  })
})
