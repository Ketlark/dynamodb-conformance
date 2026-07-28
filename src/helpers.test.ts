import { describe, it, expect } from 'vitest'
import { createTableRegistry } from './helpers.js'
import type { TestTableDef } from './types.js'

// The declaration registry behind demand-driven provisioning. Asserted against
// a synthetic creator: what needs proving is how many times a table is created
// and how many times the sweep runs, neither of which the suite can observe
// about itself.

const def = (name: string): TestTableDef => ({
  name,
  hashKey: { name: 'pk', type: 'S' },
})

/** A creator that records what it was asked to create. */
function recordingCreator() {
  const calls: string[] = []
  return {
    calls,
    create: async (d: TestTableDef) => {
      calls.push(d.name)
    },
  }
}

describe('createTableRegistry — declarations', () => {
  it('collects the defs a file declares', () => {
    const r = createTableRegistry()
    r.declare(def('a'), def('b'))
    expect(r.declaredDefs().map((d) => d.name)).toEqual(['a', 'b'])
  })

  it('deduplicates a def declared by several files', () => {
    const r = createTableRegistry()
    const shared = def('shared')
    r.declare(shared)
    r.declare(shared)
    r.declare(shared)
    expect(r.declaredDefs()).toHaveLength(1)
  })

  it('starts empty, so a run that selects nothing creates nothing', () => {
    expect(createTableRegistry().declaredDefs()).toEqual([])
  })
})

describe('createTableRegistry — provisioning', () => {
  it('creates each declared table exactly once across repeated provisions', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    r.declare(def('a'), def('b'))

    // The shared beforeAll runs per test file; forty files declaring the same
    // def must still create it once.
    await r.provision(create)
    await r.provision(create)
    await r.provision(create)

    expect(calls).toEqual(['a', 'b'])
  })

  it('creates only what a later file newly declared', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()

    r.declare(def('first'))
    await r.provision(create)
    r.declare(def('first'), def('second'))
    await r.provision(create)

    expect(calls).toEqual(['first', 'second'])
  })

  it('creates only the declared subset, not every table in the suite', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    r.declare(def('only-this-one'))
    await r.provision(create)
    expect(calls).toEqual(['only-this-one'])
  })

  it('does not create concurrently for a def already in flight', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    r.declare(def('a'))

    await Promise.all([r.provision(create), r.provision(create), r.provision(create)])

    expect(calls).toEqual(['a'])
  })

  it('propagates a creation failure so setup can record it at run level', async () => {
    const r = createTableRegistry()
    r.declare(def('a'))
    await expect(
      r.provision(async () => {
        throw new Error('CreateTable exploded')
      }),
    ).rejects.toThrow('CreateTable exploded')
  })

  it('retries a failed creation on the next attempt rather than replaying the rejection', async () => {
    const r = createTableRegistry()
    r.declare(def('a'))
    let attempts = 0
    const flaky = async () => {
      attempts++
      if (attempts === 1) throw new Error('transient')
    }

    await expect(r.provision(flaky)).rejects.toThrow('transient')
    await expect(r.provision(flaky)).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('does not retry a table that already succeeded when a sibling failed', async () => {
    const r = createTableRegistry()
    r.declare(def('good'), def('bad'))
    const seen: string[] = []
    const create = async (d: TestTableDef) => {
      seen.push(d.name)
      if (d.name === 'bad' && seen.filter((n) => n === 'bad').length === 1) {
        throw new Error('transient')
      }
    }

    await expect(r.provision(create)).rejects.toThrow('transient')
    await r.provision(create)

    expect(seen).toEqual(['good', 'bad', 'bad'])
  })
})

describe('createTableRegistry — the leftover sweep', () => {
  it('sweeps once however many files call it', async () => {
    const r = createTableRegistry()
    let sweeps = 0
    const sweep = async () => {
      sweeps++
    }

    await r.sweepOnce(sweep)
    await r.sweepOnce(sweep)
    await r.sweepOnce(sweep)

    expect(sweeps).toBe(1)
  })

  it('does not sweep again once tables have been provisioned', async () => {
    // A sweep sharing provisioning's guard would delete tables still in use.
    const r = createTableRegistry()
    const { create } = recordingCreator()
    let sweeps = 0
    const sweep = async () => {
      sweeps++
    }

    r.declare(def('a'))
    await r.sweepOnce(sweep)
    await r.provision(create)
    r.declare(def('b'))
    await r.sweepOnce(sweep)
    await r.provision(create)

    expect(sweeps).toBe(1)
  })

  it('sweeps once under concurrent callers', async () => {
    const r = createTableRegistry()
    let sweeps = 0
    const sweep = async () => {
      sweeps++
    }

    await Promise.all([r.sweepOnce(sweep), r.sweepOnce(sweep), r.sweepOnce(sweep)])

    expect(sweeps).toBe(1)
  })

  it('retries a failed sweep, so a transient fault does not skip cleanup for the run', async () => {
    const r = createTableRegistry()
    let attempts = 0
    const flaky = async () => {
      attempts++
      if (attempts === 1) throw new Error('ListTables exploded')
    }

    await expect(r.sweepOnce(flaky)).rejects.toThrow('ListTables exploded')
    await r.sweepOnce(flaky)
    await r.sweepOnce(flaky)

    expect(attempts).toBe(2)
  })

  it('keeps its guard independent of the provisioning memo', async () => {
    const r = createTableRegistry()
    const { calls, create } = recordingCreator()
    let sweeps = 0

    r.declare(def('a'))
    await expect(
      r.sweepOnce(async () => {
        sweeps++
        throw new Error('transient')
      }),
    ).rejects.toThrow('transient')
    await r.provision(create)
    await r.sweepOnce(async () => {
      sweeps++
    })

    expect({ sweeps, calls }).toEqual({ sweeps: 2, calls: ['a'] })
  })
})
