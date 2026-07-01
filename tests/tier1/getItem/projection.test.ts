import {
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  BatchGetItemCommand,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { hashTableDef, compositeTableDef, cleanupItems } from '../../../src/helpers.js'

describe('Nested attribute projection', { tags: ['get-item', 'data-plane'] }, () => {
  const hashPk = 'proj-nested'
  const compositePk = 'proj-nested-q'

  beforeAll(async () => {
    await Promise.all([
      ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: {
            pk: { S: hashPk },
            mymap: { M: { nested: { S: 'deep' }, other: { N: '42' } } },
            mylist: { L: [{ S: 'zero' }, { S: 'one' }, { S: 'two' }] },
          },
        }),
      ),
      ddb.send(
        new PutItemCommand({
          TableName: compositeTableDef.name,
          Item: {
            pk: { S: compositePk },
            sk: { S: 'a' },
            mymap: { M: { nested: { S: 'deep' }, other: { N: '42' } } },
            mylist: { L: [{ S: 'zero' }, { S: 'one' }, { S: 'two' }] },
          },
        }),
      ),
    ])
  })

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, [{ pk: { S: hashPk } }])
    await cleanupItems(compositeTableDef.name, [
      { pk: { S: compositePk }, sk: { S: 'a' } },
    ])
  })

  it('GetItem ProjectionExpression with nested map path returns only the nested value', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#m.#n',
        ExpressionAttributeNames: { '#m': 'mymap', '#n': 'nested' },
        ConsistentRead: true,
      }),
    )

    expect(result.Item).toBeDefined()
    expect(result.Item!.mymap).toBeDefined()
    expect(result.Item!.mymap.M!.nested.S).toBe('deep')
    // "other" should not be returned
    expect(result.Item!.mymap.M!.other).toBeUndefined()
  })

  it('GetItem ProjectionExpression with list index returns the element', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#l[0]',
        ExpressionAttributeNames: { '#l': 'mylist' },
        ConsistentRead: true,
      }),
    )

    expect(result.Item).toBeDefined()
    expect(result.Item!.mylist).toBeDefined()
    expect(result.Item!.mylist.L).toHaveLength(1)
    expect(result.Item!.mylist.L![0].S).toBe('zero')
  })

  it('Query ProjectionExpression with nested path and list index', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeTableDef.name,
        KeyConditionExpression: '#pk = :pk',
        ProjectionExpression: '#m.#n, #l[1]',
        ExpressionAttributeNames: {
          '#pk': 'pk',
          '#m': 'mymap',
          '#n': 'nested',
          '#l': 'mylist',
        },
        ExpressionAttributeValues: { ':pk': { S: compositePk } },
        ConsistentRead: true,
      }),
    )

    expect(result.Items).toHaveLength(1)
    const item = result.Items![0]
    expect(item.mymap.M!.nested.S).toBe('deep')
    expect(item.mymap.M!.other).toBeUndefined()
    expect(item.mylist.L).toHaveLength(1)
    expect(item.mylist.L![0].S).toBe('one')
  })

  it('BatchGetItem ProjectionExpression with nested path', async () => {
    const result = await ddb.send(
      new BatchGetItemCommand({
        RequestItems: {
          [hashTableDef.name]: {
            Keys: [{ pk: { S: hashPk } }],
            ProjectionExpression: '#m.#n',
            ExpressionAttributeNames: { '#m': 'mymap', '#n': 'nested' },
            ConsistentRead: true,
          },
        },
      }),
    )

    const items = result.Responses![hashTableDef.name]
    expect(items).toHaveLength(1)
    expect(items[0].mymap.M!.nested.S).toBe('deep')
    expect(items[0].mymap.M!.other).toBeUndefined()
  })

  it('GetItem ProjectionExpression with multiple sibling paths in one map keeps all of them', async () => {
    const k = 'proj-multi'
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: {
          pk: { S: k },
          m: { M: { a: { S: 'A' }, b: { S: 'B' }, c: { S: 'C' } } },
        },
      }),
    )
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: k } },
        ProjectionExpression: '#m.#a, #m.#b',
        ExpressionAttributeNames: { '#m': 'm', '#a': 'a', '#b': 'b' },
        ConsistentRead: true,
      }),
    )
    // Both projected siblings survive (not just the last), and the structure is
    // preserved; the unprojected sibling is dropped.
    expect(result.Item!.m.M!.a.S).toBe('A')
    expect(result.Item!.m.M!.b.S).toBe('B')
    expect(result.Item!.m.M!.c).toBeUndefined()
    await cleanupItems(hashTableDef.name, [{ pk: { S: k } }])
  })
})

describe('GetItem — projection matching nothing', { tags: ['get-item', 'data-plane'] }, () => {
  const pk = 'get-emptyproj'

  beforeAll(async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, name: { S: 'Alice' } },
      }),
    )
  })

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, [{ pk: { S: pk } }])
  })

  it('returns an empty Item when ProjectionExpression matches no attribute on a present item', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        ProjectionExpression: 'nonexistent',
        ConsistentRead: true,
      }),
    )

    // The item exists but the projection selects nothing. Unlike TransactGetItems
    // (which omits Item entirely), GetItem returns Item as an empty {} object.
    expect(result.Item).toBeDefined()
    expect(Object.keys(result.Item!)).toHaveLength(0)
  })

  it('returns an empty Item when legacy AttributesToGet matches no attribute on a present item', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        AttributesToGet: ['nonexistent'],
        ConsistentRead: true,
      }),
    )

    // Legacy AttributesToGet behaves identically to ProjectionExpression here.
    expect(result.Item).toBeDefined()
    expect(Object.keys(result.Item!)).toHaveLength(0)
  })

  it('still returns Item when projecting an attribute that exists', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        ProjectionExpression: '#n',
        ExpressionAttributeNames: { '#n': 'name' },
        ConsistentRead: true,
      }),
    )

    expect(result.Item).toBeDefined()
    expect(result.Item!.name.S).toBe('Alice')
  })

  it('still returns Item when projecting the key attribute pk explicitly', async () => {
    // GetItem does not auto-include keys, but an explicitly projected key resolves
    // and so Item is returned (it is not the empty-projection case).
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        ProjectionExpression: 'pk',
        ConsistentRead: true,
      }),
    )

    expect(result.Item).toBeDefined()
    expect(result.Item!.pk.S).toBe(pk)
  })
})

describe('Same list-index projection merge', { tags: ['get-item', 'data-plane'] }, () => {
  // Two projected paths that share a list index (l[0].a, l[0].b) merge into a
  // single reconstructed element, the same way sibling map paths (m.a, m.b) do.
  // Distinct indices stay separate and compact to ascending order. Item carries
  // scalars, a nested map, and a nested list under index 0 so the merge can be
  // probed at depth.
  const hashPk = 'proj-list-merge'
  const compositePk = 'proj-list-merge-q'
  const listAttr = {
    l: {
      L: [
        {
          M: {
            a: { S: 'a0' },
            b: { S: 'b0' },
            m: { M: { x: { S: 'x0' }, y: { S: 'y0' } } },
            n: {
              L: [
                { M: { p: { S: 'p00' }, q: { S: 'q00' } } },
                { M: { p: { S: 'p01' }, q: { S: 'q01' } } },
              ],
            },
          },
        },
        { M: { a: { S: 'a1' }, b: { S: 'b1' } } },
        { M: { a: { S: 'a2' }, b: { S: 'b2' }, c: { S: 'c2' } } },
      ],
    },
  }

  beforeAll(async () => {
    await Promise.all([
      ddb.send(
        new PutItemCommand({
          TableName: hashTableDef.name,
          Item: { pk: { S: hashPk }, ...listAttr },
        }),
      ),
      ddb.send(
        new PutItemCommand({
          TableName: compositeTableDef.name,
          Item: { pk: { S: compositePk }, sk: { S: 'a' }, ...listAttr },
        }),
      ),
    ])
  })

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, [{ pk: { S: hashPk } }])
    await cleanupItems(compositeTableDef.name, [
      { pk: { S: compositePk }, sk: { S: 'a' } },
    ])
  })

  it('GetItem merges two scalar sub-attributes of one list index into a single element', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#l[0].#a, #l[0].#b',
        ExpressionAttributeNames: { '#l': 'l', '#a': 'a', '#b': 'b' },
        ConsistentRead: true,
      }),
    )
    const l = result.Item!.l.L!
    expect(l).toHaveLength(1)
    expect(l[0].M!.a.S).toBe('a0')
    expect(l[0].M!.b.S).toBe('b0')
    // Sibling that was not projected is dropped.
    expect(l[0].M!.c).toBeUndefined()
  })

  it('GetItem merges two paths sharing a nested map under one list index', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#l[0].#m.#x, #l[0].#m.#y',
        ExpressionAttributeNames: { '#l': 'l', '#m': 'm', '#x': 'x', '#y': 'y' },
        ConsistentRead: true,
      }),
    )
    const l = result.Item!.l.L!
    expect(l).toHaveLength(1)
    expect(l[0].M!.m.M!.x.S).toBe('x0')
    expect(l[0].M!.m.M!.y.S).toBe('y0')
  })

  it('GetItem merges a scalar sibling and a nested-map sibling under one list index', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#l[0].#a, #l[0].#m.#x',
        ExpressionAttributeNames: { '#l': 'l', '#a': 'a', '#m': 'm', '#x': 'x' },
        ConsistentRead: true,
      }),
    )
    const l = result.Item!.l.L!
    expect(l).toHaveLength(1)
    expect(l[0].M!.a.S).toBe('a0')
    expect(l[0].M!.m.M!.x.S).toBe('x0')
    // Only x was projected inside m; y is dropped.
    expect(l[0].M!.m.M!.y).toBeUndefined()
  })

  it('GetItem merges two paths sharing an element of a nested list under one list index', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#l[0].#n[0].#p, #l[0].#n[0].#q',
        ExpressionAttributeNames: { '#l': 'l', '#n': 'n', '#p': 'p', '#q': 'q' },
        ConsistentRead: true,
      }),
    )
    const l = result.Item!.l.L!
    expect(l).toHaveLength(1)
    const n = l[0].M!.n.L!
    expect(n).toHaveLength(1)
    expect(n[0].M!.p.S).toBe('p00')
    expect(n[0].M!.q.S).toBe('q00')
  })

  it('GetItem keeps distinct inner list indices separate under one shared outer index', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#l[0].#n[0].#p, #l[0].#n[1].#q',
        ExpressionAttributeNames: { '#l': 'l', '#n': 'n', '#p': 'p', '#q': 'q' },
        ConsistentRead: true,
      }),
    )
    const l = result.Item!.l.L!
    expect(l).toHaveLength(1)
    const n = l[0].M!.n.L!
    expect(n).toHaveLength(2)
    expect(n[0].M!.p.S).toBe('p00')
    expect(n[0].M!.q).toBeUndefined()
    expect(n[1].M!.q.S).toBe('q01')
    expect(n[1].M!.p).toBeUndefined()
  })

  it('GetItem merges the shared index and keeps a distinct index separate, compacted', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#l[0].#a, #l[0].#b, #l[2].#c',
        ExpressionAttributeNames: { '#l': 'l', '#a': 'a', '#b': 'b', '#c': 'c' },
        ConsistentRead: true,
      }),
    )
    const l = result.Item!.l.L!
    // Index 0 (merged a+b) and index 2 (c) survive; the list compacts to two
    // elements in ascending source-index order.
    expect(l).toHaveLength(2)
    expect(l[0].M!.a.S).toBe('a0')
    expect(l[0].M!.b.S).toBe('b0')
    expect(l[1].M!.c.S).toBe('c2')
    expect(l[1].M!.a).toBeUndefined()
  })

  it('GetItem merges the same index regardless of path request order', async () => {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: hashPk } },
        ProjectionExpression: '#l[0].#b, #l[0].#a',
        ExpressionAttributeNames: { '#l': 'l', '#a': 'a', '#b': 'b' },
        ConsistentRead: true,
      }),
    )
    const l = result.Item!.l.L!
    expect(l).toHaveLength(1)
    expect(l[0].M!.a.S).toBe('a0')
    expect(l[0].M!.b.S).toBe('b0')
  })

  it('Query merges two sub-attributes of one list index into a single element', async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: compositeTableDef.name,
        KeyConditionExpression: '#pk = :pk',
        ProjectionExpression: '#l[0].#a, #l[0].#b',
        ExpressionAttributeNames: { '#pk': 'pk', '#l': 'l', '#a': 'a', '#b': 'b' },
        ExpressionAttributeValues: { ':pk': { S: compositePk } },
        ConsistentRead: true,
      }),
    )
    expect(result.Items).toHaveLength(1)
    const l = result.Items![0].l.L!
    expect(l).toHaveLength(1)
    expect(l[0].M!.a.S).toBe('a0')
    expect(l[0].M!.b.S).toBe('b0')
  })

  it('BatchGetItem merges two sub-attributes of one list index into a single element', async () => {
    const result = await ddb.send(
      new BatchGetItemCommand({
        RequestItems: {
          [hashTableDef.name]: {
            Keys: [{ pk: { S: hashPk } }],
            ProjectionExpression: '#l[0].#a, #l[0].#b',
            ExpressionAttributeNames: { '#l': 'l', '#a': 'a', '#b': 'b' },
            ConsistentRead: true,
          },
        },
      }),
    )
    const items = result.Responses![hashTableDef.name]
    expect(items).toHaveLength(1)
    const l = items[0].l.L!
    expect(l).toHaveLength(1)
    expect(l[0].M!.a.S).toBe('a0')
    expect(l[0].M!.b.S).toBe('b0')
  })
})
