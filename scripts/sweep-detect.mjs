#!/usr/bin/env node

/**
 * Detect regional splits from a sweep's per-region ground truth, confirm them
 * with targeted re-runs, and hand a human the evidence.
 *
 * Reads a directory of per-region results (`ground-truth/<region>.json` plus
 * `<region>.indeterminate.json` sidecars), classifies each region's run,
 * health-gates it, and compares classified verdicts across the resolved
 * regions. A test where regions disagree - and EVERY side returned a definite
 * answer - is a split candidate. A test where any side was indeterminate is
 * not a candidate, full stop: absence is not disagreement, and a timeout must
 * never be read as a behavioural difference.
 *
 * Candidates do not approach the registry on one observation. With --confirm,
 * each candidate is re-run - only that test, in only the disagreeing regions,
 * several times - and survives only if every re-run reproduces the first
 * observation. This targeted repeat is the flake remedy: re-running one test
 * five times costs less than one extra whole-suite pass, and repeating a whole
 * noisy suite would sample the same noise three times, not denoise it.
 *
 * THE SCRIPT NEVER WRITES registry/splits.json, UNDER ANY CODE PATH. Confirmed
 * candidates, and drift on already-admitted rows (regions that converged, or
 * now disagree differently), become GitHub issues carrying the evidence and
 * provenance; a human adjudicates and commits the row by hand. That gate is
 * the whole integrity story - see registry/README.md. Automated writes here
 * would launder a regional AWS defect, or plain noise, straight into the
 * baseline every target is scored against.
 *
 * The health verdicts also drive the observed-set bookkeeping: with
 * --record-health the per-region resolved/unresolved outcome is recorded into
 * registry/regions.json via scripts/lib/observed.mjs, and a region dropped by
 * this sweep (two consecutive misses) produces a paging issue in the same act.
 *
 * Usage:
 *   node scripts/sweep-detect.mjs <ground-truth-dir>
 *     [--expect r1,r2,...]        regions the sweep was meant to cover; one with
 *                                 no results file is unresolved, never silent
 *     [--registry <path>]         split registry to read (default registry/splits.json)
 *     [--record-health <path>]    record per-region outcomes (registry/regions.json)
 *     [--date YYYY-MM-DD]         sweep date for --record-health (default: today, UTC)
 *     [--confirm]                 targeted re-runs against real AWS (needs credentials)
 *     [--confirm-runs N]          re-runs per region per candidate (default 5)
 *     [--out <path>]              write the machine-readable sweep report
 *     [--file-issues]             file/refresh GitHub issues via `gh`; without it,
 *                                 issue bodies are printed (a dry run)
 *     [--run-url <url>]           provenance link for issue bodies
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { classifyResults } from './lib/classify.mjs'
import { assessRegion } from './lib/health.mjs'
import { isRegionName, loadRegistry, sameObservation, splitFor } from './lib/registry.mjs'
import { loadRegionHealth, recordSweep, validateRegionHealth } from './lib/observed.mjs'

// ── Reading a sweep directory ────────────────────────────────────────────────

/**
 * Read every per-region result in a sweep directory: `<region>.json` and, when
 * the run wrote one, its `<region>.indeterminate.json` sidecar. Non-region
 * files (README.md, sweep reports, the ad-hoc `latest.json` capture) are
 * ignored. Returns { [region]: { results, sidecar } }.
 */
export function readSweepDir(dir) {
  const docs = {}
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry.endsWith('.indeterminate.json')) continue
    const region = basename(entry, '.json')
    if (!isRegionName(region)) continue
    const results = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
    const sidecarFile = join(dir, `${region}.indeterminate.json`)
    const sidecar = existsSync(sidecarFile)
      ? JSON.parse(readFileSync(sidecarFile, 'utf8'))
      : null
    docs[region] = { results, sidecar }
  }
  return docs
}

// Vitest records the runner's absolute file paths; regions ran in separate CI
// jobs, so cross-region joins (and registry rows) use the repo-relative path.
export function relativeTestFile(file) {
  const ix = file.lastIndexOf('/tests/')
  return ix === -1 ? file : file.slice(ix + 1)
}

// ── Detection ────────────────────────────────────────────────────────────────

function byTest(verdictsByRegion) {
  const tests = new Map()
  for (const [region, verdicts] of Object.entries(verdictsByRegion)) {
    for (const v of verdicts) {
      const file = relativeTestFile(v.file)
      const key = `${file}\n${v.fullName}`
      let entry = tests.get(key)
      if (!entry) {
        entry = { test: { file, fullName: v.fullName, title: v.title }, regions: {} }
        tests.set(key, entry)
      }
      entry.regions[region] = v.verdict
    }
  }
  return tests
}

/**
 * Split candidates: tests where resolved regions returned definite, differing
 * answers. Callers must pass only resolved regions' verdicts - an unresolved
 * region contributes nothing, not even its passes (see scripts/lib/health.mjs).
 *
 * Ineligible, by design:
 * - any region indeterminate on the test: absence is not disagreement;
 * - a skip anywhere: a probe that declined is not an answer to compare;
 * - tests with an admitted registry row: expected to disagree; whether they
 *   still disagree the recorded way is detectRegistryDrift's business.
 */
export function detectSplitCandidates(verdictsByRegion, registry) {
  const candidates = []
  for (const entry of byTest(verdictsByRegion).values()) {
    const verdicts = Object.values(entry.regions)
    if (verdicts.includes('indeterminate') || verdicts.includes('skip')) continue
    if (!verdicts.includes('pass') || !verdicts.includes('fail')) continue
    if (splitFor(registry, entry.test)) continue
    candidates.push(entry)
  }
  return candidates.sort((a, b) =>
    `${a.test.file}\n${a.test.fullName}`.localeCompare(`${b.test.file}\n${b.test.fullName}`),
  )
}

/**
 * Drift on admitted rows. Each row implies a verdict per named region: the
 * committed assertion encodes the pinned region's answer, so a region recorded
 * as agreeing with the pinned answer should pass it, and a region recorded as
 * answering differently should fail it. A definite verdict contradicting that
 * is drift; an indeterminate or missing observation says nothing and draws no
 * conclusion.
 *
 * Findings are `converged` (every named region gave a definite answer and all
 * now match the pinned answer: the split may have healed) or `moved` (the
 * disagreement is no longer the recorded one). Either way the outcome is an
 * issue for a human - reality moving is never a silent registry edit.
 */
export function detectRegistryDrift(verdictsByRegion, registry) {
  const tests = byTest(verdictsByRegion)
  const findings = []
  for (const row of registry.splits) {
    const observed = tests.get(`${row.test.file}\n${row.test.fullName}`)
    if (!observed) continue

    const expected = {}
    const actual = {}
    for (const region of Object.keys(row.regions)) {
      expected[region] = sameObservation(row.regions[region], row.regions[row.pinned])
        ? 'pass'
        : 'fail'
      const v = observed.regions[region]
      if (v === 'pass' || v === 'fail') actual[region] = v
    }

    const mismatched = Object.keys(actual).filter((r) => actual[r] !== expected[r])
    if (mismatched.length === 0) continue

    const converged = Object.keys(row.regions).every((r) => actual[r] === 'pass')
    findings.push({
      row: { id: row.id, test: row.test, pinned: row.pinned, behaviour: row.behaviour },
      kind: converged ? 'converged' : 'moved',
      expected,
      actual,
      mismatched,
    })
  }
  return findings
}

/**
 * The definite failures a region's report entry carries, so a human can
 * adjudicate from the sweep report alone.
 *
 * An unresolved region lists every definite failure (it produced no
 * candidates, so the report is the only place its redness is legible). A
 * resolved region lists only its failures on admitted-split tests, each with
 * the matched row id: those failures surface nowhere else - candidates skip
 * admitted rows, drift checks only the regions a row names, and the health
 * gate excludes them - yet they are exactly the cohort-membership evidence
 * an adjudicator needs to extend a row to regions it does not yet name. A
 * resolved region's novel failures are candidates and are not repeated here.
 *
 * Entries carry one uniform shape either way - { file, fullName, explained,
 * rowId? } - so a report consumer never has to branch on the region's
 * resolved flag to know what a failure entry means. `rowFor(verdict)` returns
 * the admitted registry row or null; injected so explained-ness has exactly
 * one definition, shared with the health gate.
 */
export function reportFailures(verdicts, rowFor, resolved) {
  const failures = []
  for (const v of verdicts) {
    if (v.verdict !== 'fail') continue
    const row = rowFor(v)
    if (resolved && !row) continue
    failures.push({
      file: relativeTestFile(v.file),
      fullName: v.fullName,
      explained: Boolean(row),
      ...(row ? { rowId: row.id } : {}),
    })
  }
  return failures
}

/** Raw per-region evidence for one test: status and failure messages. */
export function evidenceFor(docs, test) {
  const out = {}
  for (const [region, { results }] of Object.entries(docs)) {
    for (const tr of results.testResults ?? []) {
      if (relativeTestFile(tr.name) !== test.file) continue
      for (const ar of tr.assertionResults ?? []) {
        if (ar.fullName === test.fullName) {
          out[region] = { status: ar.status, failureMessages: ar.failureMessages ?? [] }
        }
      }
    }
  }
  return out
}

// ── Targeted confirmation ────────────────────────────────────────────────────

/**
 * Re-run each candidate - only that test, in only the regions on the
 * divergent side - `runs` times each, keeping only candidates where every
 * re-run reproduces the sweep's failure. Anything else (a flipped verdict, an
 * indeterminate, a test that did not run) discards the candidate: it was
 * non-determinism, not a split, or it could not be re-observed - and in
 * neither case may it approach the registry.
 *
 * Only the fail side is re-run. A fail verdict contradicts the committed
 * assertion and must reproduce to be believed; a pass verdict is the steady
 * state, re-proven by every sweep of that region. Re-running the pass side
 * too would scale confirmation with the region set instead of the divergent
 * cohort, which on a full-region sweep costs more wall-clock than the sweep
 * itself and busts the detect job's ceiling. The confirmation block records
 * which regions were re-run so downstream provenance never overstates the
 * evidence.
 *
 * `runTest(region, test)` returns a verdict string; the default runner spawns
 * the real suite (makeVitestRunner). Injected so the logic tests without AWS.
 */
export async function confirmCandidates(candidates, { runs = 5, runTest }) {
  const confirmed = []
  const discarded = []
  for (const candidate of candidates) {
    const rerunRegions = Object.keys(candidate.regions)
      .filter((region) => candidate.regions[region] === 'fail')
      .sort()
    // detectSplitCandidates guarantees a mixed pass/fail verdict set, so an
    // empty fail side means the caller broke that contract - and a candidate
    // confirmed on zero re-runs must never approach the human gate.
    if (rerunRegions.length === 0) {
      discarded.push({ ...candidate, reason: 'no fail-side region to re-run; nothing to confirm' })
      continue
    }
    let failure = null
    const started = Date.now()
    outer: for (const region of rerunRegions) {
      for (let i = 1; i <= runs; i++) {
        const verdict = await runTest(region, candidate.test)
        if (verdict !== 'fail') {
          failure = `re-run ${i} in ${region} returned ${verdict}; the sweep observed fail`
          break outer
        }
      }
    }
    // The cost data future re-tuning (--confirm-runs, parallelism) needs.
    console.log(
      `confirm: ${candidate.test.fullName}: ${rerunRegions.length} region(s) × ${runs}, ` +
        `${Math.round((Date.now() - started) / 1000)}s`,
    )
    if (failure === null) {
      confirmed.push({ ...candidate, confirmation: { runs, regions: rerunRegions } })
    } else discarded.push({ ...candidate, reason: failure })
  }
  return { confirmed, discarded }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The real confirmation runner: one test, one region, one fresh suite process
 * against real AWS (so DYNAMODB_ENDPOINT is stripped), classified from its own
 * results file and sidecar. Requires AWS credentials; never invoked by tests.
 */
export function makeVitestRunner({ cwd = process.cwd() } = {}) {
  return function runTest(region, test) {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-confirm-'))
    const slug = `confirm-${region}`
    const outputFile = join(dir, `${slug}.json`)
    const env = {
      ...process.env,
      AWS_REGION: region,
      CONFORMANCE_TARGET: slug,
      CONFORMANCE_RESULTS_DIR: dir,
    }
    delete env.DYNAMODB_ENDPOINT
    spawnSync(
      'npx',
      [
        'vitest',
        'run',
        test.file,
        '--testNamePattern',
        escapeRegExp(test.fullName),
        '--reporter=json',
        `--outputFile=${outputFile}`,
      ],
      { cwd, env, encoding: 'utf8' },
    )

    // A run that produced no readable observation of the test is an absence,
    // and an absence can never confirm a candidate.
    if (!existsSync(outputFile)) return 'indeterminate'
    const results = JSON.parse(readFileSync(outputFile, 'utf8'))
    const sidecarFile = join(dir, `${slug}.indeterminate.json`)
    const sidecar = existsSync(sidecarFile)
      ? JSON.parse(readFileSync(sidecarFile, 'utf8'))
      : null
    const verdict = classifyResults(results, sidecar).find(
      (v) => v.fullName === test.fullName && relativeTestFile(v.file) === test.file,
    )
    return verdict?.verdict ?? 'indeterminate'
  }
}

// ── Issue bodies ─────────────────────────────────────────────────────────────

const HUMAN_GATE =
  'Nothing here is automatic: the sweep never writes `registry/splits.json`. ' +
  'A maintainer reviews the evidence and decides - see `registry/README.md` ' +
  'for what a row means and what admitting one commits the project to.'

function provenance({ date, runUrl }) {
  const run = runUrl ? ` ([sweep run](${runUrl}))` : ''
  return `Detected by the weekly ground-truth sweep on ${date}${run}.`
}

export function buildCandidateIssue(candidate, { date, runUrl, evidence = {} }) {
  const { test, regions, confirmation } = candidate
  const lines = [
    `## Split candidate: regions disagree on a behaviour`,
    '',
    provenance({ date, runUrl }),
    '',
    `- **Test:** \`${test.file}\``,
    `- **Name:** ${test.fullName}`,
    confirmation
      ? `- **Confirmation:** the divergent side (${confirmation.regions.join(', ')}) was re-run ${confirmation.runs}× each; every run reproduced the failure. Pass-side verdicts are single sweep observations.`
      : `- **Confirmation:** none - this candidate has NOT been re-confirmed and must not be admitted on this evidence alone.`,
    '',
    '| Region | Verdict against the committed assertion |',
    '| --- | --- |',
  ]
  for (const region of Object.keys(regions).sort()) {
    lines.push(`| ${region} | ${regions[region]} |`)
  }
  const withMessages = Object.keys(evidence)
    .sort()
    .filter((r) => (evidence[r]?.failureMessages ?? []).length > 0)
  if (withMessages.length > 0) {
    lines.push('', '### Evidence')
    for (const region of withMessages) {
      lines.push('', `**${region}**`, '', '```')
      lines.push(...evidence[region].failureMessages.map((m) => m.trim()))
      lines.push('```')
    }
  }
  lines.push('', '### Next step', '', HUMAN_GATE)
  return {
    title: `Split candidate: ${test.fullName}`,
    labels: ['split-candidate'],
    body: lines.join('\n'),
  }
}

export function buildDriftIssue(finding, { date, runUrl }) {
  const { row, kind, expected, actual } = finding
  const explanation =
    kind === 'converged'
      ? 'Every region named in the row now returns a definite answer matching the pinned one. The split may have healed; if so, the row should be retired.'
      : 'At least one region named in the row no longer answers the way the row records. The registry may be describing a divergence that has moved.'
  const lines = [
    `## Registry drift: \`${row.id}\``,
    '',
    provenance({ date, runUrl }),
    '',
    explanation,
    '',
    `- **Test:** \`${row.test.file}\``,
    `- **Name:** ${row.test.fullName}`,
    `- **Pinned region:** ${row.pinned}`,
    '',
    '| Region | Row implies | Sweep observed |',
    '| --- | --- | --- |',
  ]
  for (const region of Object.keys(expected).sort()) {
    lines.push(`| ${region} | ${expected[region]} | ${actual[region] ?? 'no definite answer'} |`)
  }
  lines.push('', '### Next step', '', HUMAN_GATE)
  return {
    title: `Registry drift: ${row.id} (${kind})`,
    labels: ['registry-drift'],
    body: lines.join('\n'),
  }
}

export function buildPageIssue(page, { date, runUrl }) {
  const reasons = (page.reasons ?? [])
    .map((r) => `- ${r.kind}: ${r.detail}`)
    .join('\n')
  const body = [
    `## Region dropped from the observed set: ${page.region}`,
    '',
    provenance({ date, runUrl }),
    '',
    `\`${page.region}\` has now been unresolved for two consecutive sweeps, so it has been dropped from the observed region set - scores no longer draw on its data. Dropping and paging happen in this same act, deliberately: holding the region in the set while waiting for a human would keep scoring on data nobody can vouch for.`,
    '',
    "This sweep's health verdict:",
    '',
    reasons || '- (no per-run detail: the region produced no results at all)',
    '',
    'The region rejoins the observed set automatically on its next resolved sweep. The follow-up here is operational: find out why the region cannot complete a sweep.',
  ].join('\n')
  return {
    title: `Region dropped from the observed set: ${page.region}`,
    labels: ['region-dropped'],
    body,
  }
}

// ── Filing (the only GitHub-touching path; opt-in via --file-issues) ─────────

function gh(args, opts = {}) {
  const res = spawnSync('gh', args, { encoding: 'utf8', ...opts })
  if (res.status !== 0) {
    throw new Error(`gh ${args[0]} failed: ${res.stderr || res.stdout}`)
  }
  return res.stdout
}

const LABELS = {
  'split-candidate': 'Sweep-confirmed regional split awaiting a human decision',
  'registry-drift': 'An admitted split no longer matches what regions return',
  'region-dropped': 'A region missed two consecutive sweeps and left the observed set',
}

/**
 * File one issue via the `gh` CLI, deduplicating on exact title: a candidate
 * confirmed again next week comments on its open issue rather than opening a
 * second one.
 */
export function fileIssue(issue, { exec = gh } = {}) {
  const label = issue.labels[0]
  try {
    exec(['label', 'create', label, '--description', LABELS[label] ?? '', '--color', 'D93F0B'])
  } catch {
    // The label already existing is the steady state.
  }
  const open = JSON.parse(
    exec(['issue', 'list', '--label', label, '--state', 'open', '--json', 'number,title']),
  )
  const existing = open.find((i) => i.title === issue.title)
  if (existing) {
    exec(['issue', 'comment', String(existing.number), '--body', issue.body])
    return { action: 'commented', number: existing.number }
  }
  exec([
    'issue',
    'create',
    '--title',
    issue.title,
    '--label',
    issue.labels.join(','),
    '--body',
    issue.body,
  ])
  return { action: 'created' }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    dir: null,
    expect: null,
    registry: 'registry/splits.json',
    recordHealth: null,
    date: new Date().toISOString().slice(0, 10),
    confirm: false,
    confirmRuns: 5,
    out: null,
    fileIssues: false,
    runUrl: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--expect') {
      args.expect = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
      // An empty expectation would make every region silently out of scope,
      // and nothing here may produce silence.
      if (args.expect.length === 0) throw new Error('--expect needs at least one region')
    }
    else if (a === '--registry') args.registry = argv[++i]
    else if (a === '--record-health') args.recordHealth = argv[++i]
    else if (a === '--date') args.date = argv[++i]
    else if (a === '--confirm') args.confirm = true
    else if (a === '--confirm-runs') args.confirmRuns = Number(argv[++i])
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--file-issues') args.fileIssues = true
    else if (a === '--run-url') args.runUrl = argv[++i]
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (args.dir === null) args.dir = a
    else throw new Error(`unexpected argument ${a}`)
  }
  if (!args.dir) throw new Error('usage: sweep-detect.mjs <ground-truth-dir> [options]')

  // Belt and braces on the integrity guarantee: no output path this script
  // accepts may ever be the split registry.
  for (const path of [args.out, args.recordHealth]) {
    if (path && resolve(path) === resolve(args.registry)) {
      throw new Error(`refusing to write the split registry: only a human edits ${args.registry}`)
    }
  }
  return args
}

/**
 * The whole pipeline for one sweep, exported so the write ordering is
 * testable with an injected runner. `runTest` overrides the confirmation
 * runner; omitted, --confirm spawns the real suite (makeVitestRunner).
 */
export async function run(args, { runTest } = {}) {
  const registry = loadRegistry(args.registry)
  const rowFor = (v) => splitFor(registry, v)
  const docs = readSweepDir(args.dir)
  const regions = args.expect ?? Object.keys(docs).sort()

  // Health-gate every expected region. A region with no results file at all is
  // unresolved, never silently absent: nothing may produce silence.
  const health = {}
  const verdictsByRegion = {}
  for (const region of regions) {
    if (!docs[region]) {
      health[region] = {
        resolved: false,
        reasons: [{ kind: 'missing-results', detail: 'the sweep produced no results file for this region' }],
        counts: null,
        failures: [],
      }
      continue
    }
    const verdicts = classifyResults(docs[region].results, docs[region].sidecar)
    // A failure on a test with an admitted registry row is a recorded
    // regional difference, not sickness - it must not spend the region's
    // sick-failure budget (see assessRegion). rowFor is the one definition of
    // explained-ness, shared by the gate and the report.
    const assessed = assessRegion(verdicts, { isExplained: (v) => Boolean(rowFor(v)) })
    health[region] = {
      ...assessed,
      failures: reportFailures(verdicts, rowFor, assessed.resolved),
    }
    if (assessed.resolved) verdictsByRegion[region] = verdicts
  }

  const candidates = detectSplitCandidates(verdictsByRegion, registry)
  const drift = detectRegistryDrift(verdictsByRegion, registry)

  // Record each region's outcome; a region dropped by this sweep pages in the
  // same act (see scripts/lib/observed.mjs for why the two must not be split).
  const pages = []
  if (args.recordHealth) {
    let healthDoc = existsSync(args.recordHealth)
      ? loadRegionHealth(args.recordHealth)
      : validateRegionHealth({ regions: {} })
    for (const region of regions) {
      const outcome = recordSweep(healthDoc, {
        region,
        resolved: health[region].resolved,
        date: args.date,
      })
      healthDoc = outcome.doc
      if (outcome.page) pages.push({ region, reasons: health[region].reasons })
    }
    writeFileSync(args.recordHealth, JSON.stringify(healthDoc, null, 2) + '\n')
  }

  let confirmed = []
  let discarded = []
  const writeReport = (confirmationState) => {
    if (!args.out) return
    mkdirSync(dirname(args.out), { recursive: true })
    writeFileSync(
      args.out,
      JSON.stringify(
        { date: args.date, confirmationState, regions: health, candidates, confirmed, discarded, drift, pages },
        null,
        2,
      ) + '\n',
    )
  }

  // Health above, and an initial report here, both land BEFORE confirmation:
  // the confirmation loop is the long tail of a wide sweep, and the job
  // timeout killing the process mid-loop must cost only the unconfirmed
  // candidates - never the sweep's health record or its report artifact.
  writeReport(args.confirm ? 'pending' : 'not-requested')

  if (args.confirm) {
    ;({ confirmed, discarded } = await confirmCandidates(candidates, {
      runs: args.confirmRuns,
      runTest: runTest ?? makeVitestRunner(),
    }))
    writeReport('complete')
  }

  const issues = [
    ...(args.confirm ? confirmed : []).map((c) =>
      buildCandidateIssue(c, {
        date: args.date,
        runUrl: args.runUrl,
        evidence: evidenceFor(docs, c.test),
      }),
    ),
    ...drift.map((f) => buildDriftIssue(f, { date: args.date, runUrl: args.runUrl })),
    ...pages.map((p) => buildPageIssue(p, { date: args.date, runUrl: args.runUrl })),
  ]

  const unresolved = regions.filter((r) => !health[r].resolved)
  console.log(
    `${regions.length} region(s): ${regions.length - unresolved.length} resolved` +
      (unresolved.length ? `, unresolved: ${unresolved.join(', ')}` : ''),
  )
  console.log(
    `${candidates.length} split candidate(s)` +
      (args.confirm ? ` (${confirmed.length} confirmed, ${discarded.length} discarded)` : ' (unconfirmed)') +
      `, ${drift.length} drift finding(s), ${pages.length} region(s) paged`,
  )

  for (const issue of issues) {
    if (args.fileIssues) {
      const outcome = fileIssue(issue)
      console.log(`${outcome.action}: ${issue.title}`)
    } else {
      console.log(`\n--- would file: ${issue.title} [${issue.labels.join(', ')}] ---\n`)
      console.log(issue.body)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
