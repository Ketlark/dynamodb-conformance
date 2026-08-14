// Which builds of a project earn a place on the board, and what a row that
// absorbed the others should call itself.
//
// A project can ship several builds of one engine - a storage backend swapped
// underneath, the same query layer compiled for a different runtime - and the
// registry nests those under a parent rather than seating them beside it. That
// keeps one engine from occupying several top slots. It does not stop a nested
// row repeating its parent across every column, which is what happens when a
// build differs in how it is deployed but not in how it behaves.
//
// So the row is earned by the measurement rather than by existing. A build that
// scores differently gets its own line; one that scores the same is named on
// the parent instead. Nobody adjudicates per build, and the rule reverses
// itself: a build that converges folds in, and one that later diverges comes
// back out on the next run.
//
// This lives here, beside the registry both renderers already read, because the
// published table and the site build their rows separately. Two copies of the
// rule would eventually disagree about the same run, and a reader comparing the
// README against the site would have no way to tell which was right.
import { configurationOf } from './targets.mjs'

/**
 * Whether `variant` differs from the build above it by enough to deserve its
 * own row.
 *
 * The comparison is on the figures as rendered, not the raw values behind them.
 * Two builds separated in the fourth decimal print the same percentages, and
 * comparing raw values would have a row appear and vanish between runs over a
 * difference nobody can see on the board.
 *
 * The suite size is checked alongside them because divergence and coverage are
 * both ratios: equal percentages over different denominators describe different
 * work, and folding those together would put one set of figures over two runs
 * that never matched.
 *
 * A build with nothing above it earns a row by default. The grouping promotes a
 * build to parent when the reference build has no result, and that build then
 * stands for the whole project.
 */
export function earnsOwnRow(variant, parent) {
  if (!parent || parent === variant) return true
  return (
    variant.grade !== parent.grade ||
    variant.divergence !== parent.divergence ||
    variant.coverage !== parent.coverage ||
    variant.count !== parent.count
  )
}

/**
 * A parent's builds split into the ones that render their own row and the ones
 * that fold into it, preserving the order they arrived in.
 */
export function splitVariants(parent) {
  const shown = []
  const collapsed = []
  for (const variant of parent?.variants ?? []) {
    if (earnsOwnRow(variant, parent)) shown.push(variant)
    else collapsed.push(variant)
  }
  return { shown, collapsed }
}

/**
 * The configurations a row should name: its own, then those that folded into
 * it. The reference leads because the row carries its figures, so it is the
 * build the numbers actually describe.
 *
 * Empty for a project that declares no configurations, which is most of them.
 * A single-shape project has nothing to disambiguate and the board should not
 * invent a name for it.
 */
export function configurationsOf(parent, collapsed = []) {
  return [parent, ...collapsed].map((row) => configurationOf(row.slug)).filter(Boolean)
}
