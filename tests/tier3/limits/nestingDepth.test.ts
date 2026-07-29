import {
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, hashTableDef, cleanupItems, expectDynamoError } from '../../../src/helpers.js'
import { observeSplit } from '../../../src/observation-sink.js'

declareTables(hashTableDef)

// Wrap a scalar leaf in `depth` single-key maps: depth=1 -> { M: { n: { S: 'leaf' } } }.
// Real DynamoDB caps document nesting at 32 levels, counting the attribute itself as
// level 1, so a value built from 31 wraps (leaf at level 32) is the deepest it accepts
// and 32 wraps (leaf at level 33) is rejected with a ValidationException. The same
// boundary and message apply to stored items (PutItem) and to ExpressionAttributeValues
// in a ConditionExpression. Captured against eu-west-2 real DynamoDB, 2026-06.
function deepMap(depth: number): AttributeValue {
  let v: AttributeValue = { S: 'leaf' }
  for (let i = 0; i < depth; i++) v = { M: { n: v } }
  return v
}

// Region wording varies; pin the invariant. AWS returns (eu-west-2):
//   "Nesting Levels have exceeded supported limits: Attributes in the item have
//    nested levels beyond supported limit"
// Require both the "nest(ing|ed) levels" and "supported limit" phrases together, so an
// unrelated ValidationException that merely mentions nesting cannot pass the assertion.
const NEST_MSG = /nest(?:ing|ed) levels[\s\S]*supported limit/i

// no negative-path: acceptance-mixed (asserts accepted and rejected cases)
describe('Nesting depth — 32-level document limit', { tags: ['put-item', 'update-item', 'data-plane'] }, () => {
  const keys = [{ pk: { S: 'nest-stored-31' } }, { pk: { S: 'nest-cond-eav' } }]

  afterAll(async () => {
    await cleanupItems(hashTableDef.name, keys)
  })

  // --- Stored item (PutItem) ---

  it('accepts a stored attribute nested 31 levels (leaf at level 32)', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'nest-stored-31' }, data: deepMap(31) },
      }),
    )
  })

  it('rejects a stored attribute nested 32 levels (leaf at level 33)', async () => {
    await expectDynamoError(
      () =>
        ddb.send(
          new PutItemCommand({
            TableName: hashTableDef.name,
            // never stored, so no cleanup key needed
            Item: { pk: { S: 'nest-stored-32' }, data: deepMap(32) },
          }),
        ),
      'ValidationException',
      NEST_MSG,
    )
  })

  // --- ExpressionAttributeValue (UpdateItem ConditionExpression) ---
  // Depth is validated up front, before the condition is evaluated. A 31-level value
  // is accepted, so the condition runs: against an item with no `data`, `#d = :deep`
  // is false and surfaces as ConditionalCheckFailedException, which proves the value
  // was accepted rather than rejected on depth. A 32-level value is rejected outright.

  it('accepts a 31-level ExpressionAttributeValue (condition is evaluated)', async () => {
    await ddb.send(
      new PutItemCommand({
        TableName: hashTableDef.name,
        Item: { pk: { S: 'nest-cond-eav' }, marker: { S: 'x' } },
      }),
    )
    await expectDynamoError(
      () =>
        ddb.send(
          new UpdateItemCommand({
            TableName: hashTableDef.name,
            Key: { pk: { S: 'nest-cond-eav' } },
            UpdateExpression: 'SET touched = :t',
            ConditionExpression: '#d = :deep',
            ExpressionAttributeNames: { '#d': 'data' },
            ExpressionAttributeValues: { ':t': { S: 'y' }, ':deep': deepMap(31) },
          }),
        ),
      'ConditionalCheckFailedException',
    )
  })

  it('rejects a 32-level ExpressionAttributeValue with ValidationException', async (ctx) => {
    // Split behaviour (registry row update-item-nesting-depth-expression-value):
    // regions without the stricter validation accept the value and fail the
    // condition instead, so what the target actually returned is recorded for
    // per-region scoring.
    await expectDynamoError(
      () =>
        observeSplit(ctx.task, () =>
          ddb.send(
            new UpdateItemCommand({
              TableName: hashTableDef.name,
              Key: { pk: { S: 'nest-cond-eav' } },
              UpdateExpression: 'SET touched = :t',
              ConditionExpression: '#d = :deep',
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':t': { S: 'y' }, ':deep': deepMap(32) },
            }),
          ),
        ),
      'ValidationException',
      NEST_MSG,
    )
  })
})
