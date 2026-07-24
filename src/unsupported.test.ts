import { describe, expect, it } from 'vitest'
import { isUnsupportedFault } from './unsupported.js'

// The predicate has three positive arms (name, message, status) and must stay
// conservative on anything else, because a false positive turns a real answer
// into a skip and a false negative (in indeterminate.ts) turns a definite
// "not implemented" into a dropped observation. Each arm and the duck-typing
// is pinned here rather than only incidentally through indeterminate.test.ts.

describe('isUnsupportedFault', () => {
  it('matches the UnknownOperationException name (the common 400 shape)', () => {
    expect(isUnsupportedFault({ name: 'UnknownOperationException' })).toBe(true)
  })

  it('matches HTTP 501 whatever the name', () => {
    expect(isUnsupportedFault({ name: 'UnsupportedOperation', $metadata: { httpStatusCode: 501 } })).toBe(
      true,
    )
  })

  it.each([
    'unknown operation',
    'This operation is not implemented',
    "Operation 'Foo' is an unsupported operation",
    "Operation 'Foo' is not supported by the wasm preview engine",
  ])('matches the message arm: %s', (message) => {
    // The message arm alone, with no recognised name and no 501, so it is
    // exercised independently of the other two arms.
    expect(isUnsupportedFault({ name: 'SomeOtherError', message, $metadata: { httpStatusCode: 500 } })).toBe(
      true,
    )
  })

  it('is case-insensitive on the message', () => {
    expect(isUnsupportedFault({ message: 'NOT IMPLEMENTED' })).toBe(true)
  })

  it.each([
    ['a validation error', { name: 'ValidationException', message: 'One or more parameter values were invalid' }],
    ['a not-found', { name: 'ResourceNotFoundException', message: 'Requested resource not found' }],
    ['a conditional-check failure', { name: 'ConditionalCheckFailedException', message: 'The conditional request failed' }],
    ['a plain 500 with no unsupported wording', { name: 'InternalServerError', $metadata: { httpStatusCode: 500 } }],
    ['a 400 with an unrelated message', { name: 'SerializationException', message: 'bad input' }],
  ])('is false for a real answer: %s', (_label, err) => {
    expect(isUnsupportedFault(err)).toBe(false)
  })

  it('is false and never throws on malformed errors (duck-typed, cloned objects)', () => {
    // The runner hands afterEach hooks plain-object clones, so non-string
    // name/message and missing $metadata must be tolerated, not assumed.
    expect(isUnsupportedFault(null)).toBe(false)
    expect(isUnsupportedFault(undefined)).toBe(false)
    expect(isUnsupportedFault('a string')).toBe(false)
    expect(isUnsupportedFault({})).toBe(false)
    expect(isUnsupportedFault({ name: 123, message: {}, $metadata: null })).toBe(false)
    expect(isUnsupportedFault({ $metadata: { httpStatusCode: '501' } })).toBe(false)
  })
})
