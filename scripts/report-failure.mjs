#!/usr/bin/env node

/**
 * Format a GitHub issue body from a Vitest JSON report's classified failures,
 * and - when a drift diff is supplied - label the failure as confirmed AWS
 * drift or a likely flake.
 *
 * Usage:
 *   node scripts/report-failure.mjs <vitest-json> <run-url> \
 *     [--drift <drift.json>] [--verdict-out <file>]
 *
 * The scheduled-run workflow calls this on a deterministic ground-truth failure
 * (after retries) and threads the output onto a single deduped issue, so a red
 * Monday is actionable rather than a silent X.
 *
 * The report is classified (scripts/lib/classify.mjs) before anything is
 * listed, because a raw `status: "failed"` cannot tell a real behavioural
 * failure from a failed observation. The run's indeterminate sidecar is read
 * from the path beside the report (<report>.json -> <report>.indeterminate.json,
 * the pairing src/indeterminate-sink.ts writes), so the triage this issue
 * carries distinguishes three kinds of red:
 *
 * - definite failures: real behavioural evidence, listed for re-characterising;
 * - failed observations (test-level indeterminates): timeouts, exhausted
 *   throttles, transport faults - not evidence of drift, listed separately;
 * - a run-level indeterminate: provisioning never completed, so no test
 *   produced an observation and nothing is listed as a failure.
 *
 * With --drift (the output of drift-diff.mjs comparing a fresh eu-west-2
 * capture against the committed baseline) it fills the triage slot with a
 * verdict and writes the recommended issue label to --verdict-out. The pure
 * functions are unit-tested via test:tooling.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { classifyResults } from './lib/classify.mjs'

/**
 * Classify every assertion in a Vitest JSON report (merging its indeterminate
 * sidecar) and pair each verdict with the report's display fields: the test's
 * name and the first line of its first failure message.
 */
export function collectResults(report, sidecar = null) {
  if (!Array.isArray(report?.testResults)) return []
  const verdicts = classifyResults(report, sidecar)
  const out = []
  let i = 0
  for (const tr of report.testResults) {
    for (const ar of tr.assertionResults ?? []) {
      const { verdict, reason } = verdicts[i++]
      const name =
        ar.fullName ||
        [...(ar.ancestorTitles ?? []), ar.title].filter(Boolean).join(' > ')
      const detail = (ar.failureMessages ?? [])[0]?.split('\n')[0]?.trim() ?? ''
      out.push({ file: tr.name, name, detail, verdict, reason })
    }
  }
  return out
}

/**
 * The report's definite failures: real behavioural evidence, classified so a
 * failed observation is never listed as one.
 */
export function collectFailures(report, sidecar = null) {
  return collectResults(report, sidecar)
    .filter((r) => r.verdict === 'fail')
    .map(({ file, name, detail }) => ({ file, name, detail }))
}

/**
 * The report's failed observations (indeterminates). Each carries its reason
 * and whether the observation failed at test or run level.
 */
export function collectIndeterminates(report, sidecar = null) {
  return collectResults(report, sidecar).filter((r) => r.verdict === 'indeterminate')
}

/**
 * Turn a drift-diff result (drift-diff.mjs across-time output) into a verdict.
 * Returns null when no usable drift data is available, so the body falls back to
 * the generic triage note.
 */
export function verdictFromDrift(driftResult) {
  if (!driftResult || typeof driftResult.clean !== 'boolean') return null
  // A diff that compared nothing (a missing region block) yields no verdict -
  // fall back to the generic triage note rather than guessing flake or drift.
  if (driftResult.comparable === false) return null
  if (driftResult.clean) {
    return {
      label: 'likely-flake',
      summary:
        "eu-west-2's wording matches the committed baseline, so this is most likely a " +
        'transient flake the retry happened not to catch. Investigate timing rather than ' +
        're-characterising.',
      probes: [],
    }
  }
  const probes = (driftResult.drift?.probes ?? []).map((p) => p.id)
  // A round-trip-only change carries no probe id, so name it explicitly or the
  // issue would claim drift with nothing to act on.
  if (driftResult.drift?.nullRoundTrip) probes.push('{ NULL: false } round-trip')
  return {
    label: 'aws-drift-confirmed',
    summary:
      "eu-west-2's wording has moved from the committed baseline, so this is real AWS drift. " +
      'Re-characterise the affected assertions against current AWS per the suite doctrine.',
    probes,
  }
}

/**
 * Build the Markdown issue body. `report` may be null when parsing failed;
 * `sidecar` is the run's indeterminate sidecar, when it wrote one.
 */
export function buildIssueBody(report, runUrl, verdict = null, sidecar = null) {
  const lines = []
  lines.push('The scheduled `Conformance Tests` ground-truth run went red after retries.')
  lines.push('')
  if (runUrl) lines.push(`Run: ${runUrl}`)
  lines.push('')

  const runLevel = (sidecar?.runLevel ?? [])[0] ?? null
  if (runLevel) {
    // A run-level indeterminate means no test produced an
    // observation, so listing the run's reds as failures would present one
    // provisioning fault as several hundred behavioural disagreements.
    lines.push(
      `**The run itself was indeterminate**: provisioning never completed (\`${runLevel.reason}\`),`,
    )
    lines.push('so no test produced an observation. This is a failed observation')
    lines.push('of AWS, not evidence of drift; investigate the run (credentials, throttling,')
    lines.push('region health) rather than re-characterising any assertion.')
  } else if (!report) {
    lines.push('The Vitest report could not be read or parsed, so the failure was')
    lines.push('likely in setup/teardown or the runner itself. See the run log.')
  } else {
    const failures = collectFailures(report, sidecar)
    const indeterminates = collectIndeterminates(report, sidecar)
    if (failures.length === 0 && indeterminates.length === 0) {
      lines.push('No failed assertions are present in the report, so the failure was')
      lines.push('likely in a `beforeAll`/`afterAll` hook or infrastructure rather than')
      lines.push('a test body. See the run log.')
    }
    if (failures.length > 0) {
      lines.push(`**${failures.length} failed test${failures.length === 1 ? '' : 's'}:**`)
      lines.push('')
      for (const f of failures) {
        lines.push(`- \`${f.name}\``)
        if (f.detail) lines.push(`  - ${f.detail}`)
      }
    }
    if (indeterminates.length > 0) {
      if (failures.length > 0) lines.push('')
      lines.push(
        `**${indeterminates.length} failed observation${indeterminates.length === 1 ? '' : 's'}** ` +
          '(indeterminate: timeout, exhausted throttle or transport fault - not behavioural',
      )
      lines.push('failures, and counted neither for nor against ground truth):')
      lines.push('')
      for (const t of indeterminates) {
        lines.push(`- \`${t.name}\` - \`${t.reason?.reason ?? 'unknown'}\``)
      }
    }
  }

  lines.push('')
  lines.push('<!-- triage-slot -->')
  if (verdict) {
    const tag = verdict.label === 'aws-drift-confirmed' ? 'AWS drift confirmed' : 'Likely a flake'
    lines.push(`**Verdict: ${tag}.** ${verdict.summary}`)
    if (verdict.probes.length) {
      lines.push('')
      lines.push('Drifted probes: ' + verdict.probes.map((id) => `\`${id}\``).join(', '))
    }
  } else {
    lines.push(
      '_Triage: a deterministic red here is either real AWS drift (re-characterise ' +
        'against current AWS) or a flake the retry did not catch. No drift verdict was ' +
        'available for this run._',
    )
  }
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { drift: null, verdictOut: null, _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--drift') args.drift = argv[++i]
    else if (a === '--verdict-out') args.verdictOut = argv[++i]
    else args._.push(a)
  }
  return args
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const [reportPath, runUrl = ''] = args._
  if (!reportPath) {
    console.error('usage: report-failure.mjs <vitest-json> <run-url> [--drift <file>] [--verdict-out <file>]')
    process.exit(1)
  }
  const report = readJson(reportPath)
  // The sidecar sits beside the report it qualifies (src/indeterminate-sink.ts
  // pairs the two by slug), so its path is derived rather than passed.
  const sidecarPath = reportPath.replace(/\.json$/, '.indeterminate.json')
  const sidecar = existsSync(sidecarPath) ? readJson(sidecarPath) : null
  const verdict = args.drift ? verdictFromDrift(readJson(args.drift)) : null
  process.stdout.write(buildIssueBody(report, runUrl, verdict, sidecar) + '\n')
  if (args.verdictOut && verdict) writeFileSync(args.verdictOut, verdict.label + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
