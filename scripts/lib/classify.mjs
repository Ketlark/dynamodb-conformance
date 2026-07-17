// The classification chokepoint: raw results in, four-way verdicts out.
//
// Turns a Vitest JSON document plus its indeterminate sidecar into a per-test
// verdict: pass, fail, skip, or indeterminate. Everything downstream (scoring,
// the results table, the badges, split detection) consumes these verdicts;
// nothing downstream may read `assertionResults[].status` directly, because
// the raw status cannot tell a failed observation from a real failure - an
// indeterminate test still records `status: "failed"`, and only the
// `meta.indeterminate` marker (or the run-level sidecar) tells the two kinds
// of red apart.
//
// The four verdicts are two kinds of answer and two kinds of absence:
//   pass / fail       - the target answered; the answer matched, or didn't.
//   skip              - honest scope: the feature probe declined to run it.
//   indeterminate     - a failed observation: timeout, exhausted throttle,
//                       transport fault. Nobody knows what the answer was.
// A skip and an indeterminate are different absences and the distinction is
// load-bearing: both are excluded from scores, but a skip is a property of
// the target while an indeterminate is a property of the run.
//
// Takes documents, not paths, so the same function serves both namespaces:
// target results (results/<slug>.json) and per-region ground truth. Pure and
// dependency-free, mirroring scripts/lib/drift.mjs.

const SKIP_STATUSES = new Set(['skipped', 'pending', 'todo', 'disabled'])

/**
 * Validate an indeterminate sidecar document. `null`/`undefined` means the
 * run wrote no sidecar (a clean run), which is the normal case. Anything else
 * must be the shape src/indeterminate-sink.ts writes; a malformed sidecar is
 * an error, never a silent "everything passed".
 */
function runLevelEntries(sidecar) {
  if (sidecar == null) return []
  if (typeof sidecar !== 'object' || !Array.isArray(sidecar.runLevel)) {
    throw new Error('malformed indeterminate sidecar: expected { runLevel: [...] }')
  }
  for (const entry of sidecar.runLevel) {
    if (typeof entry?.reason !== 'string' || entry.reason === '') {
      throw new Error('malformed indeterminate sidecar: entry without a reason')
    }
  }
  return sidecar.runLevel
}

/**
 * Validate a test's observed marker (src/observation-sink.ts): the target's
 * actual answer for a split behaviour, in the shape the split registry
 * records per-region answers. Returned as a spreadable fragment so absence
 * adds no key. Malformed is loud: per-region scoring compares the
 * observation against recorded answers, and a mangled one would silently
 * turn matches into misses.
 */
function observedEntry(ar) {
  const observed = ar.meta?.observed
  if (observed === undefined) return {}
  const wellFormed =
    observed?.outcome === 'rejected'
      ? typeof observed.error?.name === 'string' &&
        typeof observed.error?.message === 'string'
      : observed?.outcome === 'accepted' && typeof observed.detail === 'string'
  if (!wellFormed) {
    throw new Error(`malformed observed marker on ${ar.fullName}`)
  }
  return { observed }
}

/**
 * Classify every test in a Vitest JSON document, merging the run's
 * indeterminate sidecar (or null when the run wrote none).
 *
 * Returns [{ file, fullName, title, verdict, observed?, reason? }].
 * `observed` carries the target's recorded answer for a split behaviour, so
 * per-region scoring can compare it against each region's recorded answer.
 * `reason` is set only on indeterminate verdicts, carrying why the
 * observation failed and whether it failed at test or run level.
 */
export function classifyResults(resultsDoc, sidecar = null) {
  if (!Array.isArray(resultsDoc?.testResults)) {
    throw new Error('not a Vitest JSON result: missing testResults')
  }
  const runLevel = runLevelEntries(sidecar)

  const verdicts = []
  for (const tr of resultsDoc.testResults) {
    for (const ar of tr.assertionResults ?? []) {
      verdicts.push({
        file: tr.name,
        fullName: ar.fullName,
        title: ar.title,
        ...observedEntry(ar),
        ...classifyOne(ar, runLevel),
      })
    }
  }
  return verdicts
}

function classifyOne(ar, runLevel) {
  // A run-level failure (provisioning never completed) means no test in the
  // run produced an observation, whatever its individual status.
  if (runLevel.length > 0) {
    return { verdict: 'indeterminate', reason: { ...runLevel[0], at: 'run' } }
  }

  // The test-level marker wins over the raw status in both directions: a
  // failed test with the marker is a failed observation, and a passed test
  // still carrying one (which the per-attempt clearing in src/setup.ts should
  // make impossible) must not be counted as a definite answer either.
  const marker = ar.meta?.indeterminate
  if (marker != null) {
    if (typeof marker.reason !== 'string' || marker.reason === '') {
      throw new Error(`malformed indeterminate marker on ${ar.fullName}`)
    }
    return { verdict: 'indeterminate', reason: marker }
  }

  if (ar.status === 'passed') return { verdict: 'pass' }
  if (ar.status === 'failed') return { verdict: 'fail' }
  if (SKIP_STATUSES.has(ar.status)) return { verdict: 'skip' }
  throw new Error(`unrecognised test status "${ar.status}" on ${ar.fullName}`)
}
