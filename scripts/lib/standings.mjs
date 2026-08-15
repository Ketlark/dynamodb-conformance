// Whether two builds of one project print different figures.
//
// A project can ship several builds of one engine - a storage backend swapped
// underneath, the same query layer compiled for a different runtime - and the
// registry nests those under the project rather than seating them beside it, so
// one engine cannot occupy several top slots. Every build is measured, and every
// build's figures are published. What this decides is only how much of that a
// reader is shown at once: on the site a build reading the same figures as the
// one above it starts closed, and one that differs starts open.
//
// It used to decide more than that. A matching build was not rendered at all and
// the row above named it in text, which made this comparison the thing standing
// between a reader and a false statement about someone else's engine. Every
// column the board grew was another cell it had to remember, and six were missed
// in turn - the grade, the region cohort, the tier spread, the worst-region
// figure, the version, the observed-region count - each found after the last was
// fixed. Nothing here has to be exhaustive now. A cell it does not compare costs
// a click.
//
// It lives here, beside the registry, rather than in the site that reads it: the
// figures it compares are the suite's own. The published table used to ask the
// same question and no longer does - it renders every build outright - so the
// site is the only caller today.
import { gradeOf } from './grade.mjs'

// The three figures a reader compares between two builds, as they are printed.
//
// The grade is derived here rather than read off the row. Only the published
// table sets a `grade` field; the site computes its letter at render time, so a
// rule that read one compared undefined against undefined on that surface and
// silently ignored the letter altogether. Deriving it from the two values both
// surfaces do carry makes the answer the same wherever it is asked.
// Whether the suite declined to score this row. Both figures go null together
// on a partial run, but either one is enough to mean there is nothing to
// compare.
const unscored = (row) => row.divergenceValue == null || row.coverageValue == null

const printedFigures = (row) => [
  gradeOf(row.divergenceValue, row.coverageValue).letter ?? '-',
  row.divergence ?? '-',
  row.coverage ?? '-',
]

/**
 * Whether two builds print different figures.
 *
 * This chooses whether a build's row starts open. It does not decide whether
 * anything is published: every build renders with its own figures either way.
 *
 * Every uncertain case shows more: a row the suite declined to score differs
 * from everything, including another row it declined to score.
 *
 * Total on the two rows it is given. It used to guard against a missing row as
 * well, on the reasoning that a build standing for its project could reach it
 * with nothing to compare against - but that build becomes the parent and has
 * no builds under it, so the predicate is never called for it. The guard
 * defended a case that cannot happen, and a caller that passes nothing now
 * fails at build time rather than being absorbed into "differs".
 */
export function figuresDiffer(a, b) {
  // A run that recorded an indeterminate is not scored, and the row prints "-"
  // for both figures (axesOf, scripts/lib/score.mjs). Two of those match each
  // other on all three cells, so without this the disclosure would close over
  // a pair whose figures nobody knows, under a summary saying they are the
  // same. Unlike a carried row, such a row is `reTested` and not `carried`, so
  // the flag on the row does not catch it.
  if (unscored(a) || unscored(b)) return true
  const [ga, da, ca] = printedFigures(a)
  const [gb, db, cb] = printedFigures(b)
  return ga !== gb || da !== db || ca !== cb
}
