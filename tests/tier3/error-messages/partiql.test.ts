import {
  ExecuteStatementCommand,
  ExecuteTransactionCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { hashTableDef } from '../../../src/helpers.js'

// Exact AWS strings for the PartiQL RETURNING rejections, pinned against real
// AWS (eu-west-2). Tier 2 (tests/tier2/partiql/) asserts the error shape; this
// file pins the verbatim messages. Only DELETE's invalid RETURNING variants and
// ExecuteTransaction reject the clause — BatchExecuteStatement honours it, so it
// has no rejection string to pin. See #102.
describe('PartiQL — exact error messages', { tags: ['partiql', 'data-plane', 'negative-path'] }, () => {
  let supported = true

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

  it('DELETE RETURNING MODIFIED OLD * — exact message', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = 'x' RETURNING MODIFIED OLD *`,
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid returning clause: RETURNING MODIFIED OLD *. Only RETURNING ALL OLD * is allowed in DELETE statements.',
      )
    }
  })

  it('DELETE RETURNING ALL NEW * — exact message', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = 'x' RETURNING ALL NEW *`,
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid returning clause: RETURNING ALL NEW *. Only RETURNING ALL OLD * is allowed in DELETE statements.',
      )
    }
  })

  it('DELETE RETURNING MODIFIED NEW * — exact message', async () => {
    try {
      await ddb.send(new ExecuteStatementCommand({
        Statement: `DELETE FROM "${hashTableDef.name}" WHERE pk = 'x' RETURNING MODIFIED NEW *`,
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Invalid returning clause: RETURNING MODIFIED NEW *. Only RETURNING ALL OLD * is allowed in DELETE statements.',
      )
    }
  })

  it('ExecuteTransaction with a RETURNING member — exact message', async () => {
    try {
      await ddb.send(new ExecuteTransactionCommand({
        TransactStatements: [
          { Statement: `UPDATE "${hashTableDef.name}" SET data = 'v' WHERE pk = 'x' RETURNING ALL NEW *` },
        ],
      }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DynamoDBServiceException)
      expect((err as DynamoDBServiceException).name).toBe('ValidationException')
      expect((err as DynamoDBServiceException).message).toBe(
        'Validation failed in TransactStatements[0]: RETURNING clause is not supported in ExecuteTransaction.',
      )
    }
  })
})
