import { describe, it, expect } from 'vitest'
import { buildManifest } from './tag-manifest.mjs'

// The manifest is a published contract: paritysuite.org joins its results to it
// by (file, top-level describe title, test name). These assertions cover the
// shape that join depends on. Freshness of the committed copy is asserted in
// scripts/tag-coverage.test.mjs.
const manifest = buildManifest()

describe('the tag manifest', () => {
  it('declares schema 2', () => {
    expect(manifest.schema).toBe(2)
  })

  it('maps every test file to its top-level describes', () => {
    const files = Object.keys(manifest.describes)
    expect(files.length).toBeGreaterThan(50)
    expect(files.every((f) => f.startsWith('tests/') && f.endsWith('.test.ts'))).toBe(true)
  })

  it('gives every top-level describe a tag array', () => {
    for (const [file, entry] of Object.entries(manifest.describes)) {
      for (const [title, tags] of Object.entries(entry)) {
        expect(Array.isArray(tags), `${file} « ${title} » is not an array`).toBe(true)
        expect(tags.length, `${file} « ${title} » has no tags`).toBeGreaterThan(0)
      }
    }
  })

  it('records only what a test adds beyond its top-level describe', () => {
    for (const [file, byDescribe] of Object.entries(manifest.tests)) {
      for (const [describeTitle, byTest] of Object.entries(byDescribe)) {
        const inherited = manifest.describes[file][describeTitle]
        expect(inherited, `${file} « ${describeTitle} » is missing from describes`).toBeDefined()
        for (const [testTitle, added] of Object.entries(byTest)) {
          const overlap = added.filter((t) => inherited.includes(t))
          expect(overlap, `${file} « ${testTitle} » repeats inherited tags`).toEqual([])
        }
      }
    }
  })

  it('omits files and describes with nothing tagged below the top level', () => {
    for (const [file, byDescribe] of Object.entries(manifest.tests)) {
      expect(Object.keys(byDescribe).length, `${file} has an empty tests entry`).toBeGreaterThan(0)
      for (const [title, byTest] of Object.entries(byDescribe)) {
        expect(Object.keys(byTest).length, `${file} « ${title} » is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('carries the per-test tags, which are the axes a describe would over-exclude', () => {
    const tagged = Object.entries(manifest.tests).flatMap(([file, byDescribe]) =>
      Object.values(byDescribe).flatMap((byTest) =>
        Object.entries(byTest).map(([title, tags]) => ({ file, title, tags })),
      ),
    )
    expect(tagged.length).toBeGreaterThan(0)
    // Every per-test tag names one of the axes that gets applied per test
    // rather than per describe: a deprecated parameter, or an index dependency
    // sitting among cases that have nothing to do with indexes.
    expect(tagged.every((t) => t.tags.some((x) => ['legacy', 'gsi', 'lsi'].includes(x)))).toBe(true)
    expect(tagged.map((t) => t.file)).toContain('tests/tier1/getItem/projection.test.ts')
    expect(tagged.map((t) => t.file)).toContain('tests/tier3/error-messages/createTable.test.ts')
  })
})
