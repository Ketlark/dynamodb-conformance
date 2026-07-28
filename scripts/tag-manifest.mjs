// Generate the tag manifest: every test file's top-level describes mapped to
// the tags applied to them, plus the tags applied below that level, parsed
// straight from the test sources — the same inline tags that strictTags and the
// coverage guard enforce, so this is a faithful extraction of the single source
// of truth, not a second taxonomy.
//
// Published to results/tag-manifest.json so paritysuite.org can group results
// by capability. Its results JSON carries file path, top-level describe title
// and test name per test, which is the manifest's join key.
//
// Schema 2 adds `tests`. A tag can sit on an individual `it()`, or on a nested
// describe, and the describe-keyed map cannot express either: a test tagged
// `legacy` inside a describe tagged only `get-item` would be grouped as though
// it were not legacy at all. `tests` carries only what is added *below* the
// top-level describe, so a consumer unions the two. `describes` is unchanged
// from schema 1, so a reader predating this keeps working and simply misses the
// finer-grained tags.
//
// Run: `npm run results:tags` (regenerates the committed manifest). The
// coverage guard fails if the committed file drifts from the sources.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBlocks, resolveTags } from './lib/tag-content.mjs'

const TEST_DIR = 'tests'

/** Every test below a block, with the chain of blocks enclosing each one. */
function* testsUnder(block, chain) {
  for (const child of block.children) {
    const next = [...chain, child]
    if (child.kind === 'test') yield { test: child, chain: next }
    else yield* testsUnder(child, next)
  }
}

export function buildManifest(testDir = TEST_DIR) {
  const files = readdirSync(testDir, { recursive: true })
    .map((f) => f.toString())
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(testDir, f).replace(/\\/g, '/'))
    .sort()

  const describes = {}
  const tests = {}
  for (const file of files) {
    const roots = parseBlocks(readFileSync(file, 'utf8')).filter((b) => b.kind === 'describe')
    const entry = {}
    const perTest = {}
    for (const root of roots) {
      entry[root.title] = root.tags
      const extras = {}
      for (const { test, chain } of testsUnder(root, [root])) {
        // Only what a test adds beyond its top-level describe. The describe's
        // own tags already sit in `describes`, so repeating them per test would
        // multiply the manifest by ~1000 for nothing.
        const added = [...resolveTags(chain)].filter((t) => !root.tags.includes(t))
        if (added.length) extras[test.title] = added
      }
      if (Object.keys(extras).length) perTest[root.title] = extras
    }
    describes[file] = entry
    if (Object.keys(perTest).length) tests[file] = perTest
  }
  return { schema: 2, describes, tests }
}

// CLI: write the committed manifest.
if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = buildManifest()
  writeFileSync('results/tag-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  const fileCount = Object.keys(manifest.describes).length
  const describeCount = Object.values(manifest.describes).reduce((s, d) => s + Object.keys(d).length, 0)
  const testCount = Object.values(manifest.tests).reduce(
    (s, f) => s + Object.values(f).reduce((n, d) => n + Object.keys(d).length, 0),
    0,
  )
  console.log(
    `wrote results/tag-manifest.json: ${fileCount} files, ${describeCount} describes, ${testCount} individually tagged tests`,
  )
}
