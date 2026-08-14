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
import { gradeOf } from './grade.mjs'

// The three figures a reader compares between two builds, as they are printed.
//
// The grade is derived here rather than read off the row. Only the published
// table sets a `grade` field; the site computes its letter at render time, so a
// rule that read one compared undefined against undefined on that surface and
// silently ignored the letter altogether. Deriving it from the two values both
// surfaces do carry makes the answer the same wherever it is asked.
const printedFigures = (row) => [
  gradeOf(row.divergenceValue, row.coverageValue).letter ?? '-',
  row.divergence ?? '-',
  row.coverage ?? '-',
]

/**
 * Whether two builds print different figures.
 *
 * This chooses whether a build's row starts open on the board. It does not
 * decide whether anything is published: every build renders with its own
 * figures either way, so being wrong here costs a reader one click.
 *
 * That is a deliberate reduction. An earlier version of this rule decided
 * whether a build was rendered at all, which meant every column the board grew
 * was another cell it had to remember to compare, and six were missed in turn.
 * Nothing here needs to be exhaustive any more.
 *
 * With nothing to compare against - a build standing for its project because
 * the reference has no result, or a row against itself - the answer is that
 * they differ, so the build starts open. Every uncertain case shows more.
 */
export function figuresDiffer(a, b) {
  if (!a || !b || a === b) return true
  const [ga, da, ca] = printedFigures(a)
  const [gb, db, cb] = printedFigures(b)
  return ga !== gb || da !== db || ca !== cb
}

// A row's whole published content, as one comparable value.
//
// This compares the measurement rather than the rendering, which is the only
// version of the rule that is safe to fold on. An earlier version compared the
// grade and the two headline percentages as printed, and that let two builds
// fold while disagreeing about columns nobody had compared: the same divergence
// spread differently across the tiers, or one extra failure that rounded to the
// same percentage over a suite this size. The row then published the parent's
// numbers for both builds, which is a false statement about someone else's
// engine on a board whose only job is not making those.
//
// Counts are exact, so every figure derived from them - the grade, both
// headline percentages, the fail and skip columns, the tier breakdown - is
// equal whenever these are. That also makes the rule surface-independent: the
// published table and the site derive their cells from the same counts, so they
// cannot reach different answers, and neither has to be trusted to carry a
// pre-computed field the other one does not. The site's rows, for one, carry no
// grade at all: it is computed at render time, so a rule that compared `grade`
// was silently comparing undefined against undefined there.
//
// Version and run date are part of it because the row publishes both. Two
// builds measured weeks apart, or from different releases, have not been shown
// to agree - they were never run against the same suite on the same day - and
// folding them would restate one build's version and date as the other's.
// Two rows are only ever compared against another row from the same surface, so
// these read whichever field that surface publishes rather than insisting both
// carry one shape. The published table holds the tier figures flat and names the
// cohort as a rendered count; the site holds tiers as objects and reaches the
// cohort through its region label. Reading only one of each silently compared
// undefined against undefined on the other surface, which is how an earlier
// version of this rule ended up ignoring the grade entirely on the site.
// Named explicitly rather than stringified whole. The two surfaces build their
// tier objects in different key orders, and one enriches a row from the summary
// overlay while the other does not, so comparing the object as JSON made two
// numerically identical tiers read as different - a silent refusal to fold
// rather than a wrong one, but wrong all the same.
const tierOf = (t) =>
  t == null
    ? null
    : typeof t === 'string'
      ? t
      : [
          t.passed ?? t.p ?? null,
          t.failed ?? t.f ?? null,
          t.skipped ?? t.s ?? null,
          t.indeterminate ?? t.i ?? null,
          t.divergence ?? null,
          t.coverage ?? null,
        ]

const tiersOf = (row) =>
  (row.tiers ? [row.tiers.tier1, row.tiers.tier2, row.tiers.tier3] : [row.tier1, row.tier2, row.tier3]).map(tierOf)

// The regional evidence a row prints, which is more than the size of the cohort:
// the standings say "in N regions, up to X in the other M", so two builds can
// agree on N and disagree on X. Comparing only the count folded a build that
// diverged several times worse outside its headline region into a row
// publishing the other build's figure.
const regionalOf = (row) => [
  row.cohort ?? row.regionLabel?.regions?.length ?? null,
  row.divergenceWorstLabel ?? null,
]

export function publishedFigures(row) {
  return JSON.stringify([
    row.version ?? null,
    row.runDate ?? null,
    row.passed ?? null,
    row.failed ?? null,
    row.skipped ?? null,
    row.count ?? null,
    regionalOf(row),
    tiersOf(row),
  ])
}

/**
 * Whether `variant` differs from the build above it by enough to deserve its
 * own row. It does unless every figure the row would publish is identical.
 *
 * Erring towards a row is deliberate. An extra row states something true twice;
 * a wrong fold states something false once, and only the second is a claim the
 * suite cannot defend.
 *
 * A build with nothing above it earns a row by default. The grouping promotes a
 * build to parent when the reference build has no result, and that build then
 * stands for the whole project.
 */
export function earnsOwnRow(variant, parent) {
  if (!parent || parent === variant) return true
  return publishedFigures(variant) !== publishedFigures(parent)
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

/**
 * Those names as one phrase: "PostgreSQL and SQLite", or "PostgreSQL, SQLite
 * and MongoDB" once a third arrives.
 */
export function listOf(names) {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
