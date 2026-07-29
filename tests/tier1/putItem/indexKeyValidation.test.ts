import { PutItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  compositeIndexedTableDef,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(compositeIndexedTableDef)

describe('PutItem — index key validation', { tags: ['put-item', 'data-plane', 'negative-path', 'gsi', 'lsi'] }, () => {
  // An attribute used as a table or index key must match its declared scalar
  // type and may not be empty. lsi1sk is declared S and is an index key on the
  // composite table, so these writes are rejected even though the base-table
  // keys (pk, sk) are valid.
  it('rejects a wrong-typed index key attribute', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: compositeIndexedTableDef.name,
          Item: { pk: { S: 'idxkey-type' }, sk: { S: 'a' }, lsi1sk: { N: '5' } },
        }),
      ),
      'ValidationException',
      /Type mismatch for Index Key/,
    )
  })

  it('rejects a non-scalar index key attribute', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: compositeIndexedTableDef.name,
          Item: {
            pk: { S: 'idxkey-nonscalar' },
            sk: { S: 'b' },
            lsi1sk: { L: [{ S: 'x' }] },
          },
        }),
      ),
      'ValidationException',
    )
  })

  it('rejects an empty-string index key attribute', async () => {
    await expectDynamoError(
      () => ddb.send(
        new PutItemCommand({
          TableName: compositeIndexedTableDef.name,
          Item: { pk: { S: 'idxkey-empty' }, sk: { S: 'c' }, lsi1sk: { S: '' } },
        }),
      ),
      'ValidationException',
      /empty string/i,
    )
  })
})
