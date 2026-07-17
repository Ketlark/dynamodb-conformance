import { describe, expect, it } from 'vitest'
import {
  clearObservedMarker,
  observeSplit,
  PROVISIONAL_ACCEPTED_DETAIL,
  recordObserved,
  type Observation,
} from './observation-sink.js'
import { IndeterminateError } from './indeterminate.js'

function task(): { meta: { observed?: Observation } } {
  return { meta: {} }
}

// Errors as tests see them from the SDK: plain objects carrying name and
// message, matching the shape the registry records.
const validation = {
  name: 'ValidationException',
  message:
    'One or more parameter values were invalid: Null attribute value types must have the value of true',
}

describe('observeSplit', () => {
  it('records a rejection with the error name and message, then rethrows', async () => {
    const t = task()
    await expect(
      observeSplit(t, () => Promise.reject(validation)),
    ).rejects.toBe(validation)
    expect(t.meta.observed).toEqual({
      outcome: 'rejected',
      error: { name: validation.name, message: validation.message },
    })
  })

  it('records an acceptance with the provisional detail and returns the result', async () => {
    const t = task()
    const result = await observeSplit(t, () => Promise.resolve('sent'))
    expect(result).toBe('sent')
    expect(t.meta.observed).toEqual({
      outcome: 'accepted',
      detail: PROVISIONAL_ACCEPTED_DETAIL,
    })
  })

  it('records nothing for a failed observation: a throttle is not an answer', async () => {
    const t = task()
    await expect(
      observeSplit(t, () =>
        Promise.reject({ name: 'ThrottlingException', message: 'Rate exceeded' }),
      ),
    ).rejects.toMatchObject({ name: 'ThrottlingException' })
    expect(t.meta.observed).toBeUndefined()
  })

  it('records nothing for a live IndeterminateError either', async () => {
    const t = task()
    await expect(
      observeSplit(t, () =>
        Promise.reject(new IndeterminateError('transport', 'ECONNREFUSED')),
      ),
    ).rejects.toBeInstanceOf(IndeterminateError)
    expect(t.meta.observed).toBeUndefined()
  })

  it('records nothing for a rejection the registry shape cannot represent', async () => {
    // A thrown string or a bare object has no name/message pair to record
    // verbatim; fabricating one from coerced fields would publish an answer
    // the target never gave. No evidence beats wrong evidence.
    for (const rejection of ['boom', {}, { name: 'NoMessageError' }, null]) {
      const t = task()
      await expect(observeSplit(t, () => Promise.reject(rejection))).rejects.toBe(rejection)
      expect(t.meta.observed).toBeUndefined()
    }
  })
})

describe('recordObserved', () => {
  it('replaces an earlier observation, so a verified detail can upgrade a provisional one', () => {
    const t = task()
    recordObserved(t, { outcome: 'accepted', detail: PROVISIONAL_ACCEPTED_DETAIL })
    recordObserved(t, {
      outcome: 'accepted',
      detail: 'stored, and normalised to { NULL: true } on read',
    })
    expect(t.meta.observed).toEqual({
      outcome: 'accepted',
      detail: 'stored, and normalised to { NULL: true } on read',
    })
  })
})

describe('clearObservedMarker', () => {
  it('an observation from a failed attempt does not survive into the next one', async () => {
    // The retry edge the beforeEach hook in src/setup.ts exists for: attempt 1
    // observes a rejection and fails; attempt 2 gets throttled, which records
    // nothing. Without the clear, attempt 1's answer would be reported as
    // attempt 2's.
    const t = task()
    await expect(observeSplit(t, () => Promise.reject(validation))).rejects.toBe(validation)
    expect(t.meta.observed).toBeDefined()

    clearObservedMarker(t)
    await expect(
      observeSplit(t, () =>
        Promise.reject({ name: 'ThrottlingException', message: 'Rate exceeded' }),
      ),
    ).rejects.toMatchObject({ name: 'ThrottlingException' })
    expect(t.meta).toEqual({})
  })
})
