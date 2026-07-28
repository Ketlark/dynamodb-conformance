import { PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import {
  hashTableDef,
  compositeNTableDef,
  cleanupItems,
  expectDynamoError,
  declareTables,
} from '../../../src/helpers.js'

declareTables(hashTableDef, compositeNTableDef)

// Number format: which N strings DynamoDB accepts, what it stores them as,
// and which it rejects. Captured against real DynamoDB. A leading '+' on the
// mantissa is accepted and dropped on normalisation; malformed forms and any
// whitespace are rejected. See nubo-db/dynoxide#109.

// input -> stored (the value DynamoDB returns on read-back).
const ACCEPTED: [string, string][] = [
  ['+5', '5'],
  ['+1.5', '1.5'],
  ['+0', '0'],
  ['-0', '0'],
  ['+0.0', '0'],
  ['+1e2', '100'],
  ['1e+2', '100'],
  ['1.5E+3', '1500'],
  ['+.5', '0.5'],
  ['.5', '0.5'],
  ['5.', '5'],
  ['1.', '1'],
  ['1.e5', '100000'],
  ['00042', '42'],
  ['+1e-2', '0.01'],
  ['1.23E10', '12300000000'],
]

// Each of these is rejected by real DynamoDB with a ValidationException.
const REJECTED = [
  '+e2',
  'e2',
  '+1+2',
  '1+2',
  '+1.2.3',
  '1.2.3',
  '++5',
  '+-5',
  '-+5',
  '+',
  '-',
  '1e',
  '1e+',
  '.',
  '1.2e3.4',
  '0x5',
  'NaN',
  'Infinity',
  '1_000',
  ' 5',
  '5 ',
  '1 5',
]

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('PutItem — number format', { tags: ['put-item', 'data-plane'] }, () => {
  afterAll(async () => {
    await cleanupItems(
      hashTableDef.name,
      ACCEPTED.map((_, i) => ({ pk: { S: `numfmt-${i}` } })),
    )
    await cleanupItems(compositeNTableDef.name, [{ pk: { S: 'numfmt-sk' }, sk: { N: '5' } }])
  })

  it.each(ACCEPTED)('accepts %j and stores it as %j', async (input, stored) => {
    const pk = `numfmt-${ACCEPTED.findIndex(([i]) => i === input)}`
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: pk }, val: { N: input } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: hashTableDef.name,
        Key: { pk: { S: pk } },
        ConsistentRead: true,
      }),
    )

    expect(result.Item).toBeDefined()
    expect(result.Item!.val.N).toBe(stored)
  })

  it.each(REJECTED)('rejects %j', async (input) => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            Item: { pk: { S: 'numfmt-bad' }, val: { N: input } },
          }),
        ),
      'ValidationException',
      'numeric value',
    )
  })

  it('accepts a leading + on a numeric sort key and normalises it', async () => {
    // Written with '+5'; the stored and indexed key is the normalised '5',
    // so it reads back via the bare form.
    await ddb.send(
      new PutItemCommand({
        TableName: compositeNTableDef.name,
        Item: { pk: { S: 'numfmt-sk' }, sk: { N: '+5' }, value: { S: 'plus-sort' } },
      }),
    )

    const result = await ddb.send(
      new GetItemCommand({
        TableName: compositeNTableDef.name,
        Key: { pk: { S: 'numfmt-sk' }, sk: { N: '5' } },
        ConsistentRead: true,
      }),
    )

    expect(result.Item).toBeDefined()
    expect(result.Item!.sk.N).toBe('5')
    expect(result.Item!.value.S).toBe('plus-sort')
  })
})
