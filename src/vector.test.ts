import { DynamoDBServiceException } from '@aws-sdk/client-dynamodb'

// Unit tests for the vector probes' fault classification and the waiters'
// ceiling behaviour, with the client mocked the way the sibling module tests
// do. The probes memoise across a run, so every case reloads the module.

const sendMock = vi.fn()

vi.mock('./client.js', () => ({
  ddb: { send: (cmd: unknown) => sendMock(cmd) },
  ddbStreams: {},
}))

function named(cmd: unknown): string {
  return (cmd as { constructor: { name: string } }).constructor.name
}

function serviceError(name: string, message: string): DynamoDBServiceException {
  return new DynamoDBServiceException({
    name,
    message,
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  })
}

async function loadVector() {
  vi.resetModules()
  return await import('./vector.js')
}

beforeEach(() => {
  sendMock.mockReset()
})

describe('supportsSearchVectors', () => {
  it('classifies an unsupported fault as not implemented, memoised', async () => {
    const vector = await loadVector()
    sendMock.mockRejectedValue(serviceError('UnknownOperationException', 'Unknown operation.'))
    expect(await vector.supportsSearchVectors()).toBe(false)
    expect(await vector.supportsSearchVectors()).toBe(false)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('classifies a real rejection as implemented', async () => {
    const vector = await loadVector()
    sendMock.mockRejectedValue(
      serviceError('ResourceNotFoundException', 'Requested resource not found'),
    )
    expect(await vector.supportsSearchVectors()).toBe(true)
  })
})

describe('supportsVectorIndexes', () => {
  // The probe's cleanup path (DescribeTable wait + DeleteTable) runs in a
  // finally; answering not-found keeps it silent without a created table.
  function answerCleanup(cmd: unknown): Promise<unknown> | null {
    if (named(cmd) === 'DeleteTableCommand') {
      return Promise.reject(serviceError('ResourceNotFoundException', 'not found'))
    }
    return null
  }

  it('classifies an unsupported fault as not implemented', async () => {
    const vector = await loadVector()
    sendMock.mockImplementation((cmd) => {
      const cleanup = answerCleanup(cmd)
      if (cleanup) return cleanup
      if (named(cmd) === 'DescribeTableCommand') {
        return Promise.reject(serviceError('ResourceNotFoundException', 'not found'))
      }
      return Promise.reject(serviceError('UnknownOperationException', 'Unknown operation.'))
    })
    expect(await vector.supportsVectorIndexes()).toBe(false)
  })

  it('classifies a ValidationException as not implemented (scope, not divergence)', async () => {
    const vector = await loadVector()
    sendMock.mockImplementation((cmd) => {
      const cleanup = answerCleanup(cmd)
      if (cleanup) return cleanup
      if (named(cmd) === 'DescribeTableCommand') {
        return Promise.reject(serviceError('ResourceNotFoundException', 'not found'))
      }
      return Promise.reject(serviceError('ValidationException', 'Unknown parameter'))
    })
    expect(await vector.supportsVectorIndexes()).toBe(false)
  })

  it('classifies acceptance without reflection as not implemented', async () => {
    const vector = await loadVector()
    sendMock.mockImplementation((cmd) => {
      const cleanup = answerCleanup(cmd)
      if (cleanup) return cleanup
      if (named(cmd) === 'CreateTableCommand') return Promise.resolve({})
      if (named(cmd) === 'DescribeTableCommand') {
        return Promise.resolve({ Table: { TableStatus: 'ACTIVE' } })
      }
      return Promise.resolve({})
    })
    expect(await vector.supportsVectorIndexes()).toBe(false)
  })

  it('classifies acceptance with reflection as implemented', async () => {
    const vector = await loadVector()
    sendMock.mockImplementation((cmd) => {
      const cleanup = answerCleanup(cmd)
      if (cleanup) return cleanup
      if (named(cmd) === 'CreateTableCommand') return Promise.resolve({})
      if (named(cmd) === 'DescribeTableCommand') {
        return Promise.resolve({
          Table: {
            TableStatus: 'ACTIVE',
            VectorIndexes: [{ IndexName: 'probe-index', IndexStatus: 'ACTIVE' }],
          },
        })
      }
      return Promise.resolve({})
    })
    expect(await vector.supportsVectorIndexes()).toBe(true)
  })

  it('errs on implemented for faults that are not answers about support', async () => {
    const vector = await loadVector()
    sendMock.mockImplementation((cmd) => {
      const cleanup = answerCleanup(cmd)
      if (cleanup) return cleanup
      if (named(cmd) === 'DescribeTableCommand') {
        return Promise.reject(serviceError('ResourceNotFoundException', 'not found'))
      }
      return Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    })
    expect(await vector.supportsVectorIndexes()).toBe(true)
  })
})

/** The documented readiness predicate, exercised cell by cell. */
async function settlesOn(index: Record<string, unknown>): Promise<boolean> {
  const vector = await loadVector()
  sendMock.mockResolvedValue({
    Table: { VectorIndexes: [{ IndexName: 'vix', ...index }] },
  })
  return await vector
    .waitForVectorIndexActive('t', 'vix', { timeoutMs: 30 })
    .then(() => true)
    .catch(() => false)
}

describe('waitForVectorIndexActive', () => {
  it('resolves once the index is ACTIVE and not backfilling', async () => {
    const vector = await loadVector()
    sendMock.mockResolvedValue({
      Table: { VectorIndexes: [{ IndexName: 'vix', IndexStatus: 'ACTIVE' }] },
    })
    await expect(vector.waitForVectorIndexActive('t', 'vix')).resolves.toBeUndefined()
  })

  // AWS documents the wait as "IndexStatus is ACTIVE and Backfilling is not
  // true". An absent field is the terminal state on both creation paths, so
  // reading the check as `Backfilling === false` would wait forever; and ACTIVE
  // on its own would return during a backfill if one were ever reported that
  // way. Each cell is pinned so neither reading can creep back in.
  it('treats an absent Backfilling field as done', async () => {
    expect(await settlesOn({ IndexStatus: 'ACTIVE' })).toBe(true)
  })

  it('treats Backfilling false as done', async () => {
    expect(await settlesOn({ IndexStatus: 'ACTIVE', Backfilling: false })).toBe(true)
  })

  it('keeps waiting while Backfilling is true, whatever the status says', async () => {
    expect(await settlesOn({ IndexStatus: 'ACTIVE', Backfilling: true })).toBe(false)
  })

  it('keeps waiting while the status is CREATING, whatever Backfilling says', async () => {
    expect(await settlesOn({ IndexStatus: 'CREATING', Backfilling: false })).toBe(false)
  })

  it('types a ceiling expiry as indeterminate, never a divergence', async () => {
    const vector = await loadVector()
    sendMock.mockResolvedValue({
      Table: { VectorIndexes: [{ IndexName: 'vix', IndexStatus: 'CREATING' }] },
    })
    const err = (await vector
      .waitForVectorIndexActive('t', 'vix', { timeoutMs: 30 })
      .then(() => null)
      .catch((e: unknown) => e)) as { name?: string; reason?: string } | null
    // Module reloads mint a fresh IndeterminateError class, so the check is
    // structural rather than instanceof.
    expect(err?.name).toBe('IndeterminateError')
    expect(err?.reason).toBe('vector-index-timeout')
  })
})

describe('waitForVectorSearchable', () => {
  it('resolves once the expected count is visible', async () => {
    const vector = await loadVector()
    sendMock.mockResolvedValue({ SearchResults: [{}, {}] })
    await expect(
      vector.waitForVectorSearchable({
        tableName: 't',
        indexName: 'vix',
        searchVector: [{ N: '1' }],
        expectedCount: 2,
      }),
    ).resolves.toBeUndefined()
  })

  it('types a ceiling expiry as indeterminate', async () => {
    const vector = await loadVector()
    sendMock.mockResolvedValue({ SearchResults: [] })
    const err = (await vector
      .waitForVectorSearchable({
        tableName: 't',
        indexName: 'vix',
        searchVector: [{ N: '1' }],
        expectedCount: 1,
        timeoutMs: 30,
      })
      .then(() => null)
      .catch((e: unknown) => e)) as { name?: string; reason?: string } | null
    expect(err?.name).toBe('IndeterminateError')
    expect(err?.reason).toBe('vector-consistency-timeout')
  })

  // The search endpoint can lag DescribeTable, and AWS documents the resulting
  // ValidationException as retryable rather than as an answer. The loop absorbs
  // the two readiness rejections by name and nothing else, so a malformed
  // request still surfaces as itself instead of as a readiness timeout.
  it('retries through a readiness rejection and returns on the first real answer', async () => {
    const vector = await loadVector()
    let calls = 0
    sendMock.mockImplementation(() => {
      calls += 1
      if (calls === 1) {
        return Promise.reject(
          serviceError('ValidationException', 'The table does not have the specified index: vix'),
        )
      }
      if (calls === 2) {
        return Promise.reject(
          serviceError('ValidationException', 'Cannot search backfilling vector index: vix'),
        )
      }
      return Promise.resolve({ SearchResults: [{}] })
    })
    await expect(
      vector.waitForVectorSearchable({
        tableName: 't',
        indexName: 'vix',
        searchVector: [{ N: '1' }],
        expectedCount: 1,
      }),
    ).resolves.toBeUndefined()
    expect(calls).toBe(3)
  })

  it('rethrows a rejection that is not about readiness', async () => {
    const vector = await loadVector()
    sendMock.mockRejectedValue(
      serviceError('ValidationException', 'Provided TopK value is out of valid range'),
    )
    await expect(
      vector.waitForVectorSearchable({
        tableName: 't',
        indexName: 'vix',
        searchVector: [{ N: '1' }],
        expectedCount: 1,
      }),
    ).rejects.toThrow('Provided TopK value is out of valid range')
  })

  it('rethrows a readiness rejection that names a different index', async () => {
    const vector = await loadVector()
    sendMock.mockRejectedValue(
      serviceError('ValidationException', 'The table does not have the specified index: other'),
    )
    await expect(
      vector.waitForVectorSearchable({
        tableName: 't',
        indexName: 'vix',
        searchVector: [{ N: '1' }],
        expectedCount: 1,
      }),
    ).rejects.toThrow('The table does not have the specified index: other')
  })
})

describe('waitForVectorIndexSearchable', () => {
  it('waits for ACTIVE, then for the search endpoint to serve the index', async () => {
    const vector = await loadVector()
    let searches = 0
    sendMock.mockImplementation((cmd) => {
      if (named(cmd) === 'DescribeTableCommand') {
        return Promise.resolve({
          Table: { VectorIndexes: [{ IndexName: 'vix', IndexStatus: 'ACTIVE' }] },
        })
      }
      searches += 1
      if (searches === 1) {
        return Promise.reject(
          serviceError('ValidationException', 'The table does not have the specified index: vix'),
        )
      }
      return Promise.resolve({ SearchResults: [] })
    })
    await expect(
      vector.waitForVectorIndexSearchable({
        tableName: 't',
        indexName: 'vix',
        searchVector: [{ N: '1' }],
      }),
    ).resolves.toBeUndefined()
    // An empty index is ready: the first response that comes back at all ends
    // the wait, whether or not it carries results.
    expect(searches).toBe(2)
  })

  // Nothing here waits on item visibility, so the consistency reason would name
  // the wrong failure. An index that goes ACTIVE and never serves a search is an
  // index timeout.
  it('types a search that never gets served as an index timeout', async () => {
    const vector = await loadVector()
    sendMock.mockImplementation((cmd) => {
      if (named(cmd) === 'DescribeTableCommand') {
        return Promise.resolve({
          Table: { VectorIndexes: [{ IndexName: 'vix', IndexStatus: 'ACTIVE' }] },
        })
      }
      return Promise.reject(
        serviceError('ValidationException', 'The table does not have the specified index: vix'),
      )
    })
    const err = (await vector
      .waitForVectorIndexSearchable({
        tableName: 't',
        indexName: 'vix',
        searchVector: [{ N: '1' }],
        timeoutMs: 30,
      })
      .then(() => null)
      .catch((e: unknown) => e)) as { name?: string; reason?: string } | null
    expect(err?.name).toBe('IndeterminateError')
    expect(err?.reason).toBe('vector-index-timeout')
  })
})
