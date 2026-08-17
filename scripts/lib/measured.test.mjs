import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  gradingInputsAtRef,
  measuredOf,
  readMeasuredDir,
  validateMeasured,
} from './measured.mjs'

const WHOLE = {
  ref: 'v3.1.0',
  kind: 'tag',
  commit: '9129f0fbfb6fb5ff01aadf5f9f957fa0bf1871ad',
  version: '3.1.0',
  region: 'eu-west-2',
  measuredAt: '2026-08-17T04:36:04Z',
}

const dir = (files) => {
  const d = mkdtempSync(join(tmpdir(), 'measured-'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(d, name), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return d
}

describe('validateMeasured', () => {
  it('accepts a whole identity', () => {
    expect(validateMeasured(WHOLE)).toBe(WHOLE)
  })

  it('refuses a partial identity rather than filling it in', () => {
    for (const field of Object.keys(WHOLE)) {
      const partial = { ...WHOLE }
      delete partial[field]
      expect(() => validateMeasured(partial), `missing ${field} was accepted`).toThrow(field)
    }
  })

  it('refuses a blank field, which JSON round-trips as present', () => {
    expect(() => validateMeasured({ ...WHOLE, region: '  ' })).toThrow(/region/)
  })

  it('refuses a non-object', () => {
    expect(() => validateMeasured(null)).toThrow(/expected an object/)
  })
})

describe('measuredOf', () => {
  it('reads the identity a board carries', () => {
    expect(measuredOf({ suite: WHOLE })).toEqual(WHOLE)
  })

  it('reads a board written before the field existed as carrying none', () => {
    // An older summary still has to load, or the site breaks between deploys.
    expect(measuredOf({ schemaVersion: 1 })).toBeNull()
  })

  it('refuses a board carrying a half-written identity', () => {
    expect(() => measuredOf({ suite: { ref: 'v3.1.0' } })).toThrow(/incomplete/)
  })
})

describe('readMeasuredDir', () => {
  it('reads the identity and both suite-definition files', () => {
    const d = dir({
      'suite.json': WHOLE,
      'suite-manifest.json': { tests: ['a', 'b'] },
      'splits.json': { splits: [] },
    })
    const out = readMeasuredDir(d)
    expect(out.measured).toEqual(WHOLE)
    expect(out.manifest.tests).toEqual(['a', 'b'])
    expect(out.registry.splits).toEqual([])
  })

  it('refuses an identity with no manifest beside it', () => {
    const d = dir({ 'suite.json': WHOLE, 'splits.json': { splits: [] } })
    expect(() => readMeasuredDir(d)).toThrow(/suite manifest/)
  })

  it('refuses an identity with no split registry beside it', () => {
    const d = dir({ 'suite.json': WHOLE, 'suite-manifest.json': { tests: [] } })
    expect(() => readMeasuredDir(d)).toThrow(/split registry/)
  })

  it('refuses a directory with no identity at all', () => {
    expect(() => readMeasuredDir(dir({}))).toThrow(/no measured suite identity/)
  })
})

describe('gradingInputsAtRef', () => {
  it('reads both suite-definition files at the given ref', () => {
    const seen = []
    const git = (spec) => {
      seen.push(spec)
      return spec.endsWith('suite-manifest.json') ? '{"tests":["x"]}' : '{"splits":[]}'
    }
    const out = gradingInputsAtRef('v3.0.0', { git })
    expect(seen).toEqual(['v3.0.0:registry/suite-manifest.json', 'v3.0.0:registry/splits.json'])
    expect(out.manifest.tests).toEqual(['x'])
  })

  it('reads the ref it is given, not whatever is newer', () => {
    // A rebuild recomputes an existing measurement. The sweep that triggers it
    // may have resolved a newer tag; that tag is not this board's.
    const seen = []
    gradingInputsAtRef('v3.2.0', {
      git: (spec) => {
        seen.push(spec.split(':')[0])
        return '{"tests":[],"splits":[]}'
      },
    })
    expect(new Set(seen)).toEqual(new Set(['v3.2.0']))
  })

  it('refuses rather than falling back when the ref no longer resolves', () => {
    const git = () => {
      throw new Error('fatal: invalid object name')
    }
    expect(() => gradingInputsAtRef('v9.9.9', { git })).toThrow(
      /Refusing to fall back to the working tree/,
    )
  })
})
