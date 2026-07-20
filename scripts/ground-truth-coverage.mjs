#!/usr/bin/env node

/**
 * Reconcile what real DynamoDB was actually observed on against what the
 * published table claims for it.
 *
 * The ground-truth row is synthesised, not scored: scripts/summarise.mjs pins
 * it to 100% across the full suite size, because real DynamoDB defines
 * correctness and cannot disagree with itself. That is the design, and this
 * script does not touch it. What the design assumes is that every test in the
 * suite has in fact been run against real AWS somewhere - otherwise the row
 * spans tests nobody ever observed, and the assumption quietly becomes a claim.
 *
 * Real AWS coverage is split across three lanes, for runtime reasons rather
 * than conceptual ones:
 *
 *   - the gating job          (`test:gating`)      -> most of the suite
 *   - the integrations lane   (`test:integrations`) -> S3 export/import, Kinesis
 *   - the GSI lifecycle lane  (`test:gsi`)          -> UpdateTable GSI backfills
 *
 * Union those and you should have the whole suite. This script checks that,
 * against a reference run that did execute everything (any emulator target -
 * they all run the full `npm test`). Anything in the reference with no
 * real-AWS observation behind it is reported, and the exit code is non-zero.
 *
 * Usage:
 *   node scripts/ground-truth-coverage.mjs \
 *     --reference results/dynoxide.json --reference results/dynalite.json \
 *     results/dynamodb.json ground-truth/gsi.json integration-results/dynamodb.json
 *
 * `--reference` may be repeated, and the LARGEST is used - deliberately the
 * same rule as summarise.mjs's `suiteSize = Math.max(...)`, which is what the
 * published row's denominator actually is. Reconciling against anything else
 * would check a number the table does not claim. Passing every emulator's
 * results also means one emulator job failing does not silently shrink the
 * reference and hide a gap.
 *
 * Verdicts are irrelevant here: a test that ran and failed was still observed.
 * The question is only whether real AWS was ever asked.
 */

import { readFileSync } from 'node:fs'

/**
 * Every test identity in a Vitest JSON document, as `<file>::<fullName>`.
 *
 * Keyed on the file path as well as the name because `fullName` is only unique
 * within a file - two files may both have a `basic > rejects a missing key` -
 * and a collision here would silently mark an unobserved test as covered. File
 * paths are absolutised by the runner, so they are reduced to their repo
 * relative form first: the reference and the ground-truth runs come from
 * different checkouts on different machines.
 */
export function testIdentities(doc) {
  if (!Array.isArray(doc?.testResults)) {
    throw new Error('not a Vitest JSON result: missing testResults')
  }
  const ids = new Set()
  for (const tr of doc.testResults) {
    for (const ar of tr.assertionResults ?? []) {
      ids.add(`${relativeTestPath(tr.name)}::${ar.fullName}`)
    }
  }
  return ids
}

/** Reduce a runner-absolutised path to its `tests/...` form. */
export function relativeTestPath(name) {
  const at = name.indexOf('tests/')
  return at === -1 ? name : name.slice(at)
}

/**
 * Tests present in the reference run but absent from every ground-truth run.
 * Sorted so the report is stable and diffable.
 */
export function uncovered(reference, groundTruthDocs) {
  const observed = new Set()
  for (const doc of groundTruthDocs) {
    for (const id of testIdentities(doc)) observed.add(id)
  }
  return [...testIdentities(reference)].filter((id) => !observed.has(id)).sort()
}

export function parseArgs(argv) {
  const files = []
  const references = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reference') {
      references.push(argv[++i])
      continue
    }
    files.push(argv[i])
  }
  return { references, files }
}

/**
 * The largest of the candidate references, mirroring summarise.mjs's
 * `suiteSize = Math.max(...)`. Returns the document, not the path, so callers
 * do not read twice.
 */
export function widestReference(docs) {
  return docs.reduce((widest, doc) =>
    testIdentities(doc).size > testIdentities(widest).size ? doc : widest,
  )
}

function main(argv) {
  const { references, files } = parseArgs(argv)
  if (references.length === 0 || files.length === 0) {
    console.error(
      'usage: ground-truth-coverage.mjs --reference <full-suite.json>... <ground-truth.json>...',
    )
    return 2
  }

  const read = (f) => JSON.parse(readFileSync(f, 'utf8'))
  const referenceDoc = widestReference(references.map(read))
  const gaps = uncovered(referenceDoc, files.map(read))
  const total = testIdentities(referenceDoc).size

  if (gaps.length === 0) {
    console.log(
      `Real AWS was observed on all ${total} tests, across ${files.length} run(s). ` +
        `The synthesised ground-truth row spans nothing unobserved.`,
    )
    return 0
  }

  console.error(
    `${gaps.length} of ${total} tests have no real-AWS observation behind them.\n` +
      `The published ground-truth row spans the full suite, so these are ` +
      `currently claimed rather than evidenced:\n`,
  )
  for (const id of gaps) console.error(`  ${id}`)
  console.error(
    `\nEither a lane did not run (check the run's artefacts) or a test file is ` +
      `excluded from all three. See ground-truth/README.md.`,
  )
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
