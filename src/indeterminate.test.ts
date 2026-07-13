import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DynamoDBServiceException,
  InternalServerError,
  ProvisionedThroughputExceededException,
  ResourceNotFoundException,
  ThrottlingException,
} from '@aws-sdk/client-dynamodb'
import {
  IndeterminateError,
  indeterminateFrom,
  indeterminateReasonOf,
} from './indeterminate.js'

// The wait helpers talk to the shared client; mock it so these tests are pure
// logic with no AWS access and no network.
vi.mock('./client.js', () => ({
  ddb: { send: vi.fn() },
  ddbStreams: { send: vi.fn() },
}))

import { ddb } from './client.js'
import { waitForGsiConsistency, waitUntilActive } from './helpers.js'
import { waitUntilActiveInRegion } from './infra.js'

const send = vi.mocked(ddb.send)

beforeEach(() => {
  send.mockReset()
})

// Respond after a couple of milliseconds so a 1ms ceiling deterministically
// expires after exactly one poll, keeping the timeout tests fast.
function slowResponse<T>(value: T): () => Promise<T> {
  return async () => {
    await new Promise((r) => setTimeout(r, 5))
    return value
  }
}

describe('IndeterminateError', () => {
  it('carries a reason code and a conventional name', () => {
    const err = new IndeterminateError('transport', 'socket hang up')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('IndeterminateError')
    expect(err.reason).toBe('transport')
    expect(err.message).toBe('socket hang up')
  })

  it('preserves the underlying cause when given one', () => {
    const cause = new Error('boom')
    const err = new IndeterminateError('throttle-exhausted', 'rate exceeded', { cause })
    expect(err.cause).toBe(cause)
  })
})

describe('indeterminateReasonOf', () => {
  it('reads the reason from a live IndeterminateError', () => {
    const err = new IndeterminateError('gsi-consistency-timeout', 'timed out')
    expect(indeterminateReasonOf(err)).toBe('gsi-consistency-timeout')
  })

  it('reads the reason from a serialised copy (name + reason survive, instanceof does not)', () => {
    // Vitest's error processing clones errors into plain objects before hooks
    // see them, so detection must not depend on the prototype chain.
    const serialised = {
      name: 'IndeterminateError',
      reason: 'table-active-timeout',
      message: 'Timeout waiting for table x to become ACTIVE',
    }
    expect(indeterminateReasonOf(serialised)).toBe('table-active-timeout')
  })

  it('rejects a serialised copy carrying an unknown reason', () => {
    expect(
      indeterminateReasonOf({ name: 'IndeterminateError', reason: 'not-a-reason' }),
    ).toBeNull()
  })

  it('is null for anything else', () => {
    expect(indeterminateReasonOf(new Error('plain'))).toBeNull()
    expect(indeterminateReasonOf(undefined)).toBeNull()
    expect(indeterminateReasonOf('IndeterminateError')).toBeNull()
  })
})

describe('indeterminateFrom', () => {
  it('passes an existing IndeterminateError through unchanged', () => {
    const err = new IndeterminateError('transport', 'socket hang up')
    expect(indeterminateFrom(err)).toBe(err)
  })

  it('rebuilds a typed error from a serialised IndeterminateError', () => {
    const serialised = {
      name: 'IndeterminateError',
      reason: 'gsi-consistency-timeout',
      message: 'timed out',
    }
    const err = indeterminateFrom(serialised)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect(err?.reason).toBe('gsi-consistency-timeout')
  })

  it('classifies a throttle that survived SDK retry as indeterminate', () => {
    const throttle = new ThrottlingException({
      message: 'Rate exceeded',
      $metadata: { httpStatusCode: 400 },
    })
    const err = indeterminateFrom(throttle)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect(err?.reason).toBe('throttle-exhausted')
    expect(err?.cause).toBe(throttle)
  })

  it('classifies a provisioned-throughput throttle as indeterminate', () => {
    const throttle = new ProvisionedThroughputExceededException({
      message: 'The level of configured provisioned throughput for the table was exceeded',
      $metadata: { httpStatusCode: 400 },
    })
    expect(indeterminateFrom(throttle)?.reason).toBe('throttle-exhausted')
  })

  it('classifies a throttle marked by the retry trait, whatever its name', () => {
    const marked = {
      name: 'SomethingBespoke',
      message: 'slow down',
      $retryable: { throttling: true },
    }
    expect(indeterminateFrom(marked)?.reason).toBe('throttle-exhausted')
  })

  it('classifies a 5xx service fault as indeterminate', () => {
    const ise = new InternalServerError({
      message: 'Internal server error',
      $metadata: { httpStatusCode: 500 },
    })
    expect(indeterminateFrom(ise)?.reason).toBe('transport')
  })

  it('classifies a transport-level failure as indeterminate', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), {
      code: 'ECONNREFUSED',
    })
    expect(indeterminateFrom(refused)?.reason).toBe('transport')

    const socketTimeout = Object.assign(new Error('socket timed out'), {
      name: 'TimeoutError',
    })
    expect(indeterminateFrom(socketTimeout)?.reason).toBe('transport')
  })

  it('never classifies a ValidationException: it is a definite answer', () => {
    // The edge case that matters most. A validation error is DynamoDB answering,
    // and it must remain eligible to mint a split.
    const validation = new DynamoDBServiceException({
      name: 'ValidationException',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
      message:
        'One or more parameter values were invalid: Null attribute value types must have the value of true',
    } as ConstructorParameters<typeof DynamoDBServiceException>[0])
    expect(indeterminateFrom(validation)).toBeNull()
  })

  it('never classifies a ResourceNotFoundException: an absent table is a real answer', () => {
    const notFound = new ResourceNotFoundException({
      message: 'Requested resource not found',
      $metadata: { httpStatusCode: 400 },
    })
    expect(indeterminateFrom(notFound)).toBeNull()
  })

  it('is null for a plain error and for an assertion failure', () => {
    expect(indeterminateFrom(new Error('expected 1 to be 2'))).toBeNull()
    expect(
      indeterminateFrom({ name: 'AssertionError', message: 'expected 1 to be 2' }),
    ).toBeNull()
  })
})

describe('waitUntilActive', () => {
  it('returns cleanly when the table and its GSIs reach ACTIVE (no error, no annotation)', async () => {
    send.mockResolvedValue({
      Table: {
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexStatus: 'ACTIVE' }],
      },
    } as never)
    await expect(waitUntilActive('t', 1_000)).resolves.toBeUndefined()
  })

  it('throws IndeterminateError with the table-ACTIVE reason on timeout, not a bare Error', async () => {
    send.mockImplementation(slowResponse({ Table: { TableStatus: 'CREATING' } }) as never)
    const err = await waitUntilActive('t', 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('table-active-timeout')
  })

  it('times out with the typed error while a GSI is still backfilling', async () => {
    send.mockImplementation(
      slowResponse({
        Table: {
          TableStatus: 'ACTIVE',
          GlobalSecondaryIndexes: [{ IndexStatus: 'CREATING' }],
        },
      }) as never,
    )
    const err = await waitUntilActive('t', 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('table-active-timeout')
  })

  it('still throws a plain error when DescribeTable returns no table: that is an answer', async () => {
    send.mockResolvedValue({} as never)
    const err = await waitUntilActive('t', 1_000).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(IndeterminateError)
  })
})

describe('waitForGsiConsistency', () => {
  const opts = {
    tableName: 't',
    indexName: 'gsi1',
    partitionKey: { name: 'pk', value: { S: 'x' } },
    expectedCount: 1,
  }

  it('returns cleanly once the index reflects the expected count', async () => {
    send.mockResolvedValue({ Count: 1 } as never)
    await expect(waitForGsiConsistency({ ...opts, timeoutMs: 1_000 })).resolves.toBeUndefined()
  })

  it('throws IndeterminateError with the GSI-consistency reason on timeout', async () => {
    send.mockImplementation(slowResponse({ Count: 0 }) as never)
    const err = await waitForGsiConsistency({ ...opts, timeoutMs: 1 }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('gsi-consistency-timeout')
  })
})

describe('waitUntilActiveInRegion', () => {
  it('throws IndeterminateError with the table-ACTIVE reason on timeout', async () => {
    const client = {
      send: slowResponse({ Table: { TableStatus: 'CREATING' } }),
    }
    const err = await waitUntilActiveInRegion(client as never, 't', { timeoutMs: 1 }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(IndeterminateError)
    expect((err as IndeterminateError).reason).toBe('table-active-timeout')
  })
})
