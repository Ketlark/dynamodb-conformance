import { PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, hashTableDef, cleanupItems } from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('Scan — legal shared-prefix projections', { tags: ['scan', 'data-plane'] }, () => {
  // Projection paths that share a prefix without one being a prefix of the
  // other are legal: sibling map paths merge under their parent, paths sharing
  // a list index merge into one reconstructed element, and distinct list
  // indices compact into a fresh list. These guard the boundary of the overlap
  // rejections: a target that over-applies the overlap rule fails here. Every
  // scan filters on its own pk — the shared table carries other tests' items,
  // including some large enough to exhaust a page on an unscoped scan.
  const pk = 'proj-accept-scan'

  beforeAll(async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: pk },
          a: { M: { b: { S: 'bb' }, c: { S: 'cc' }, d: { M: { e: { S: 'ee' } } } } },
          l: {
            L: [
              { M: { x: { S: 'x0' }, y: { S: 'y0' } } },
              { M: { x: { S: 'x1' }, y: { S: 'y1' } } },
            ],
          },
        },
      }),
    )
  })

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, [{ pk: { S: pk } }])
  })

  const scan = (expr: string, names: Record<string, string>) =>
    ddb.send(
      new ScanCommand({
        TableName: hashTableDef.name,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': { S: pk } },
        ProjectionExpression: expr,
        ExpressionAttributeNames: names,
        ConsistentRead: true,
      }),
    )

  it('accepts sibling map paths (a.b, a.c) and returns both under the parent', async () => {
    const result = await scan('#a.#b, #a.#c', { '#a': 'a', '#b': 'b', '#c': 'c' })
    expect(result.Items).toHaveLength(1)
    const a = result.Items![0].a.M!
    expect(a.b.S).toBe('bb')
    expect(a.c.S).toBe('cc')
    // The unprojected sibling is dropped.
    expect(a.d).toBeUndefined()
  })

  it('accepts two paths sharing a list index (l[0].x, l[0].y) and merges them into one element', async () => {
    const result = await scan('#l[0].#x, #l[0].#y', { '#l': 'l', '#x': 'x', '#y': 'y' })
    expect(result.Items).toHaveLength(1)
    const l = result.Items![0].l.L!
    expect(l).toHaveLength(1)
    expect(l[0].M!.x.S).toBe('x0')
    expect(l[0].M!.y.S).toBe('y0')
  })

  it('accepts distinct list indices (l[0], l[1]) and returns both elements in order', async () => {
    const result = await scan('#l[0], #l[1]', { '#l': 'l' })
    expect(result.Items).toHaveLength(1)
    const l = result.Items![0].l.L!
    expect(l).toHaveLength(2)
    expect(l[0].M!.x.S).toBe('x0')
    expect(l[0].M!.y.S).toBe('y0')
    expect(l[1].M!.x.S).toBe('x1')
    expect(l[1].M!.y.S).toBe('y1')
  })
})
