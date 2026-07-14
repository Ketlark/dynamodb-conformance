// The region health gate: when is a region's whole result set unobserved?
//
// A sick region must contribute nothing rather than contribute noise. Salvaging
// partial results from a throttled or broken region means drawing on a
// region that could not produce a complete observation, so the gate is all or
// nothing: a region is either resolved (its verdicts may feed split detection
// and, later, scoring) or unresolved for this sweep (it contributes nothing,
// and scripts/lib/observed.mjs decides what that does to its standing).
//
// This module is the single source of the unresolved signal. One classifier,
// two consumers: the gate decides a region is unobserved, the observed-set module
// decides what to do about it. Nothing else may invent its own notion of a
// sick region.
//
// The distinction the gate draws: one clean disagreement on one test is a
// split candidate; forty failures scattered across unrelated operations is a
// sick region. The thresholds below are that boundary, made explicit so a
// later change to them is a visible decision rather than an accident.
//
// Pure and dependency-free: it consumes classified verdicts
// (scripts/lib/classify.mjs) and touches no filesystem, AWS or network.

/**
 * The widest a genuine regional split plausibly spreads. The committed
 * assertions pin one region's answers, so a region that truly answers
 * differently on one behaviour fails the handful of tests asserting that
 * behaviour - typically clustered in one or two files. Unexplained definite
 * failures (those without an admitted split-registry row) spread across more
 * distinct files than this are not one behaviour disagreeing; they are a
 * region that does not resolve this sweep.
 */
export const MAX_DISAGREEING_FILES = 3

/**
 * The most unexplained definite failures a resolved region may carry,
 * however clustered. A behaviour split worth admitting shows up in a few
 * tests; dozens of failures - even inside few files - reads as a broken
 * operation or a sick region, and a human should see an unresolved region,
 * not forty candidates. Failures already explained by an admitted registry
 * row do not spend this budget (see assessRegion).
 */
export const MAX_DISAGREEING_TESTS = 15

/**
 * The largest share of failed observations (test-level indeterminates) a
 * resolved region may carry. A slow index or one throttled call is normal;
 * indeterminacy across a meaningful slice of the suite means the region was
 * not observable this sweep, whatever the rest of its results say.
 */
export const MAX_INDETERMINATE_SHARE = 0.03

/**
 * Assess one region's sweep from its classified verdicts.
 *
 * `opts.isExplained`, when provided, marks a definite failure as explained by
 * an admitted split-registry row. Explained failures are counted (so reports
 * stay honest) but excluded from the sick-region ceilings: an admitted row
 * records that regions legitimately answer this test differently, so a
 * failure on it carries no sickness signal - in either direction. A named
 * region changing sides on an admitted row is drift, and drift detection
 * owns that; the gate's job is sick-versus-different, and an admitted
 * difference must never push a region towards untrustworthy. The predicate
 * is injected so this module stays free of filesystem and registry imports.
 *
 * Returns { resolved, reasons, counts }. `reasons` is empty exactly when the
 * region resolved; otherwise each entry is { kind, detail } naming why the
 * region's results do not count this sweep:
 *
 * - `run-level-indeterminate`: provisioning never completed, so no test in
 *   the run produced an observation. Immediate and absolute,
 *   whatever else the run recorded - this is the highest-blast-radius failure
 *   and the most likely one in practice.
 * - `no-results`: the run recorded no tests at all.
 * - `widespread-failures`: definite failures wider than a plausible split
 *   (see MAX_DISAGREEING_FILES / MAX_DISAGREEING_TESTS).
 * - `widespread-indeterminacy`: too much of the suite was unobservable
 *   (see MAX_INDETERMINATE_SHARE).
 *
 * An unresolved region produces no split candidates at all: the caller must
 * exclude it from detection, not just from scoring.
 */
export function assessRegion(verdicts, { isExplained } = {}) {
  if (!Array.isArray(verdicts)) {
    throw new Error('assessRegion: expected an array of classified verdicts')
  }

  const counts = {
    tests: verdicts.length,
    passed: 0,
    failed: 0,
    explainedFailed: 0,
    skipped: 0,
    indeterminate: 0,
  }
  const failingFiles = new Set()
  const unexplainedFailingFiles = new Set()
  let runLevel = null
  for (const v of verdicts) {
    if (v.verdict === 'pass') counts.passed++
    else if (v.verdict === 'fail') {
      counts.failed++
      failingFiles.add(v.file)
      if (isExplained?.(v)) counts.explainedFailed++
      else unexplainedFailingFiles.add(v.file)
    } else if (v.verdict === 'skip') counts.skipped++
    else if (v.verdict === 'indeterminate') {
      counts.indeterminate++
      if (v.reason?.at === 'run') runLevel = v.reason
    } else {
      throw new Error(`assessRegion: unrecognised verdict "${v.verdict}"`)
    }
  }
  counts.failingFiles = failingFiles.size

  const unexplained = counts.failed - counts.explainedFailed
  const reasons = []
  if (runLevel) {
    reasons.push({
      kind: 'run-level-indeterminate',
      detail: `provisioning never completed (${runLevel.reason}); no test produced an observation`,
    })
  } else if (counts.tests === 0) {
    reasons.push({ kind: 'no-results', detail: 'the run recorded no tests at all' })
  } else {
    if (unexplained > MAX_DISAGREEING_TESTS || unexplainedFailingFiles.size > MAX_DISAGREEING_FILES) {
      const explainedNote =
        counts.explainedFailed > 0
          ? `; ${counts.explainedFailed} further failure(s) match admitted splits`
          : ''
      reasons.push({
        kind: 'widespread-failures',
        detail:
          `${unexplained} unexplained definite failures across ${unexplainedFailingFiles.size} files ` +
          `(resolved ceiling: ${MAX_DISAGREEING_TESTS} failures in ${MAX_DISAGREEING_FILES} files${explainedNote})`,
      })
    }
    if (counts.indeterminate / counts.tests > MAX_INDETERMINATE_SHARE) {
      reasons.push({
        kind: 'widespread-indeterminacy',
        detail:
          `${counts.indeterminate} of ${counts.tests} tests were unobservable ` +
          `(resolved ceiling: ${MAX_INDETERMINATE_SHARE * 100}% of the run)`,
      })
    }
  }

  return { resolved: reasons.length === 0, reasons, counts }
}
