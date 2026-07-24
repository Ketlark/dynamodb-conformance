// "The target does not implement this operation", as a standalone predicate.
//
// This lives on its own rather than in infra.ts because two modules need it and
// they cannot import each other: infra.ts already imports indeterminate.ts, and
// indeterminate.ts has to consult this to avoid mistaking an unimplemented
// operation for a server fault. Kept dependency-free and duck-typed for the
// same reason indeterminate.ts is - the error objects reaching an afterEach
// hook have been cloned into plain objects, so `instanceof` proves nothing.
//
// The 501 arm is the one that needs care. HTTP 501 means "not implemented",
// which is a definite answer about scope, but it also sits inside the 5xx range
// that ordinarily marks a request as never having been evaluated. A target that
// signals unimplemented operations with 501 (rather than the more common
// `UnknownOperationException`, which is a 400) is telling us something precise,
// and it must not be read as a transport fault.

interface UnsupportedErrorLike {
  name?: unknown
  message?: unknown
  $metadata?: { httpStatusCode?: unknown }
}

/** Fault shapes a target may use to say it does not implement an operation. */
const UNSUPPORTED_MESSAGE =
  /unknown operation|not implemented|unsupported operation|is not supported/i

/**
 * Whether an error says the target does not implement the operation. A real
 * error (validation, not-found, access-denied) means the operation *is*
 * implemented and the caller should assert on it, not skip.
 */
export function isUnsupportedFault(err: unknown): boolean {
  const e = (typeof err === 'object' && err !== null ? err : {}) as UnsupportedErrorLike
  const name = typeof e.name === 'string' ? e.name : ''
  const message = typeof e.message === 'string' ? e.message : ''
  const status = e.$metadata?.httpStatusCode
  return (
    name === 'UnknownOperationException' ||
    UNSUPPORTED_MESSAGE.test(message) ||
    status === 501
  )
}
