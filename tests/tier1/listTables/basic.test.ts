import { ListTablesCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { compositeTableDef, declareTables, hashTableDef } from '../../../src/helpers.js'

// Two tables, because the Limit and pagination cases below need a second page
// to exist. Provisioning follows what a file declares, so this file has to ask
// for both rather than lean on whatever other files happened to create.
declareTables(hashTableDef, compositeTableDef)

describe('ListTables — basic', { tags: ['list-tables', 'control-plane'] }, () => {
  it('returns an array of table names', async () => {
    const result = await ddb.send(new ListTablesCommand({}))

    expect(Array.isArray(result.TableNames)).toBe(true)
    expect(result.TableNames!.length).toBeGreaterThan(0)
  })

  it('includes the shared test tables', async () => {
    const result = await ddb.send(new ListTablesCommand({}))
    expect(result.TableNames).toContain(hashTableDef.name)
  })

  it('respects the Limit parameter', async () => {
    const result = await ddb.send(new ListTablesCommand({ Limit: 1 }))

    expect(result.TableNames).toHaveLength(1)
    // When there are more tables, LastEvaluatedTableName should be set
    expect(result.LastEvaluatedTableName).toBeDefined()
  })

  it('paginates with ExclusiveStartTableName', async () => {
    const first = await ddb.send(new ListTablesCommand({ Limit: 1 }))
    const second = await ddb.send(
      new ListTablesCommand({
        Limit: 1,
        ExclusiveStartTableName: first.LastEvaluatedTableName,
      }),
    )

    expect(second.TableNames).toHaveLength(1)
    expect(second.TableNames![0]).not.toBe(first.TableNames![0])
  })

  it('returns table names in alphabetical order', async () => {
    const result = await ddb.send(new ListTablesCommand({}))
    const names = result.TableNames!
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
  })
})
