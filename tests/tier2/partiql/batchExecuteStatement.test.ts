import {
  BatchExecuteStatementCommand,
  ExecuteStatementCommand,
  PutItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { hashTableDef, cleanupItems, expectDynamoError } from '../../../src/helpers.js'

describe('BatchExecuteStatement — PartiQL', { tags: ['partiql', 'data-plane'] }, () => {
  let supported = true

  const keysToCleanup: Record<string, { S: string }>[] = []

  beforeAll(async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'partiql-canary'`,
      }))
    } catch (e: unknown) {
      if (e instanceof Error && (e.name === 'UnknownOperationException' || e.name === 'UnrecognizedClientException')) {
        supported = false
      }
    }
  })

  beforeEach(({ skip }) => { if (!supported) skip() })

  afterAll(async () => {
    if (keysToCleanup.length > 0) {
      await cleanupItems(hashTableDef.name, keysToCleanup)
    }
  })

  it('batch of multiple SELECT statements', async () => {
    keysToCleanup.push(
      { pk: { S: 'batch-sel-1' } },
      { pk: { S: 'batch-sel-2' } },
    )

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'batch-sel-1' }, data: { S: 'one' } },
    }))
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'batch-sel-2' }, data: { S: 'two' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'batch-sel-1'` },
        { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'batch-sel-2'` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(2)

    const items = result.Responses!.map(r => r.Item)
    const pks = items.map(i => i?.pk.S).sort()
    expect(pks).toEqual(['batch-sel-1', 'batch-sel-2'])
  })

  it('batch of INSERT and UPDATE statements', async () => {
    keysToCleanup.push(
      { pk: { S: 'batch-ins-1' } },
      { pk: { S: 'batch-upd-1' } },
    )

    // Seed an item for the UPDATE
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'batch-upd-1' }, data: { S: 'before' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `INSERT INTO "${hashTableDef.name}" VALUE {'pk': 'batch-ins-1', 'data': 'new'}` },
        { Statement: `UPDATE "${hashTableDef.name}" SET data = 'after' WHERE pk = 'batch-upd-1'` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(2)

    // Verify the INSERT
    const inserted = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'batch-ins-1' } },
      ConsistentRead: true,
    }))
    expect(inserted.Item).toBeDefined()
    expect(inserted.Item!.data.S).toBe('new')

    // Verify the UPDATE
    const updated = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: 'batch-upd-1' } },
      ConsistentRead: true,
    }))
    expect(updated.Item).toBeDefined()
    expect(updated.Item!.data.S).toBe('after')
  })

  it('partial failure — one valid and one invalid statement', async () => {
    keysToCleanup.push({ pk: { S: 'batch-partial-1' } })

    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: 'batch-partial-1' }, data: { S: 'exists' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `SELECT * FROM "${hashTableDef.name}" WHERE pk = 'batch-partial-1'` },
        { Statement: `SELECT * FROM "_conformance_nonexistent_table" WHERE pk = 'x'` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(2)

    // One response should succeed, the other should have an Error
    const errors = result.Responses!.filter(r => r.Error)
    const successes = result.Responses!.filter(r => !r.Error)
    expect(errors.length).toBe(1)
    expect(successes.length).toBe(1)
    expect(errors[0].Error!.Code).toBe('ResourceNotFound')
  })

  it('honours a RETURNING clause on a member statement', async () => {
    const pk = 'batch-ret-allold'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'batchgone' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = '${pk}' RETURNING ALL OLD *` },
      ],
    }))

    // Unlike ExecuteTransaction, BatchExecuteStatement honours RETURNING — the
    // deleted item surfaces on Responses[i].Item. Characterised against real
    // AWS (eu-west-2). See #102.
    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    expect(result.Responses![0].Item).toBeDefined()
    expect(result.Responses![0].Item!.pk.S).toBe(pk)
    expect(result.Responses![0].Item!.data.S).toBe('batchgone')

    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name,
      Key: { pk: { S: pk } },
      ConsistentRead: true,
    }))
    expect(after.Item).toBeUndefined()
  })

  it('honours a RETURNING ALL NEW * clause on a member UPDATE', async () => {
    const pk = 'batch-ret-upd-allnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING ALL NEW *` },
      ],
    }))

    // An UPDATE member projects the same shape as the ExecuteStatement path,
    // onto Responses[i].Item. ALL NEW * returns the full new item incl. the key.
    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    expect(result.Responses![0].Item!.pk.S).toBe(pk)
    expect(result.Responses![0].Item!.data.S).toBe('new')
  })

  it('honours a RETURNING MODIFIED NEW * clause on a member UPDATE (only the changed attr)', async () => {
    const pk = 'batch-ret-upd-modnew'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `UPDATE "${hashTableDef.name}" SET data = 'new' WHERE pk = '${pk}' RETURNING MODIFIED NEW *` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    const item = result.Responses![0].Item
    expect(item).toBeDefined()
    expect(Object.keys(item!)).toEqual(['data'])
    expect(item!.data.S).toBe('new')
  })

  it('omits Item when a member UPDATE produces an empty MODIFIED projection', async () => {
    const pk = 'batch-ret-upd-modempty'
    keysToCleanup.push({ pk: { S: pk } })
    await ddb.send(new PutItemCommand({
      TableName: hashTableDef.name,
      Item: { pk: { S: pk }, data: { S: 'old' } },
    }))

    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `UPDATE "${hashTableDef.name}" REMOVE data WHERE pk = '${pk}' RETURNING MODIFIED NEW *` },
      ],
    }))

    // ExecuteStatement expresses an empty MODIFIED projection as Items: [];
    // the batch path's singular Item field cannot hold an empty row, so the
    // field is omitted entirely (not Item: {}). TableName is still echoed.
    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    expect(result.Responses![0].Item).toBeUndefined()
    expect(result.Responses![0].TableName).toBe(hashTableDef.name)

    // The member statement did apply: the attribute is gone.
    const after = await ddb.send(new GetItemCommand({
      TableName: hashTableDef.name, Key: { pk: { S: pk } }, ConsistentRead: true,
    }))
    expect(after.Item!.data).toBeUndefined()
  })

  it('surfaces an invalid RETURNING variant on a member DELETE as a per-statement error', async () => {
    // The batch call itself succeeds (HTTP 200, no throw); the invalid variant
    // surfaces per-statement with Code 'ValidationError' (not the single-statement
    // path's thrown 'ValidationException' name) and the same verbatim message.
    const result = await ddb.send(new BatchExecuteStatementCommand({
      Statements: [
        { Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = 'batch-ret-badvariant' RETURNING MODIFIED OLD *` },
      ],
    }))

    expect(result.Responses).toBeDefined()
    expect(result.Responses!.length).toBe(1)
    const err = result.Responses![0].Error
    expect(err).toBeDefined()
    expect(err!.Code).toBe('ValidationError')
    expect(err!.Message).toBe(
      'Invalid returning clause: RETURNING MODIFIED OLD *. Only RETURNING ALL OLD * is allowed in DELETE statements.',
    )
  })

  it('rejects an empty Statements array', async () => {
    await expectDynamoError(
      () => ddb.send(new BatchExecuteStatementCommand({
        Statements: [],
      })),
      'ValidationException',
    )
  })
})
