import { describe, expect, it } from 'vitest'
import { RESERVED_SLUGS, isPublishedTarget } from './score.mjs'
import { SCRATCH_TARGET, resultTargetFrom } from './result-target.mjs'

describe('resultTargetFrom', () => {
  it('writes the scratch slug when nothing is configured', () => {
    // The regression this exists for. `npm test` on a fresh clone, with no
    // credentials and no endpoint, used to resolve to the ground-truth slug and
    // overwrite results/dynamodb.json with a run in which everything errored.
    expect(resultTargetFrom({})).toBe(SCRATCH_TARGET)
    expect(resultTargetFrom({})).not.toBe('dynamodb')
  })

  it('writes the scratch slug for an endpoint run that names no target', () => {
    expect(resultTargetFrom({ DYNAMODB_ENDPOINT: 'http://localhost:8000' })).toBe(
      SCRATCH_TARGET,
    )
  })

  it('writes a published file only when a target is named', () => {
    expect(resultTargetFrom({ CONFORMANCE_TARGET: 'dynoxide' })).toBe('dynoxide')
    expect(
      resultTargetFrom({
        CONFORMANCE_TARGET: 'dynamodb',
        DYNAMODB_ENDPOINT: 'http://localhost:8000',
      }),
    ).toBe('dynamodb')
  })

  it('treats an empty or blank target as unconfigured', () => {
    // A shell that exports CONFORMANCE_TARGET= (or a workflow input left blank)
    // must not resolve to an empty slug and write results/.json.
    expect(resultTargetFrom({ CONFORMANCE_TARGET: '' })).toBe(SCRATCH_TARGET)
    expect(resultTargetFrom({ CONFORMANCE_TARGET: '   ' })).toBe(SCRATCH_TARGET)
  })

  it('keeps the scratch slug unpublishable', () => {
    // The whole guarantee rests on this: an unconfigured run writes a file the
    // results pipeline refuses to score, badge or list.
    expect(RESERVED_SLUGS.has(SCRATCH_TARGET)).toBe(true)
    expect(isPublishedTarget(SCRATCH_TARGET)).toBe(false)
  })
})
