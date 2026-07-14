import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCandidateIssue,
  buildDriftIssue,
  buildPageIssue,
  confirmCandidates,
  detectRegistryDrift,
  detectSplitCandidates,
  evidenceFor,
  fileIssue,
  parseArgs,
  relativeTestFile,
} from './sweep-detect.mjs'

const TEST = {
  file: 'tests/tier3/error-messages/putItem.test.ts',
  fullName: 'PutItem — exact error messages accepts a null attribute',
  title: 'accepts a null attribute',
}

function verdict(v, overrides = {}) {
  return {
    file: `/home/runner/work/suite/${TEST.file}`,
    fullName: TEST.fullName,
    title: TEST.title,
    verdict: v,
    ...overrides,
  }
}

const emptyRegistry = { splits: [] }

// A registry row matching TEST, pinned to eu-west-2 (the accepting side).
const rowFor = (test = TEST) => ({
  splits: [
    {
      id: 'row-1',
      test: { file: test.file, fullName: test.fullName },
      behaviour: 'a split behaviour',
      pinned: 'eu-west-2',
      firstObserved: '2026-06-09',
      lastRefreshed: '2026-07-06',
      regions: {
        'eu-west-2': { outcome: 'accepted' },
        'us-east-1': { outcome: 'rejected' },
      },
    },
  ],
})

describe('relativeTestFile', () => {
  it('strips the runner prefix and keeps an already-relative path', () => {
    expect(relativeTestFile(`/home/runner/work/suite/${TEST.file}`)).toBe(TEST.file)
    expect(relativeTestFile(TEST.file)).toBe(TEST.file)
  })
})

describe('detectSplitCandidates', () => {
  it('two regions returning definite, differing answers produce exactly one candidate', () => {
    const candidates = detectSplitCandidates(
      { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('fail')] },
      emptyRegistry,
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0].test).toEqual(TEST)
    expect(candidates[0].regions).toEqual({ 'eu-west-2': 'pass', 'us-east-1': 'fail' })
  })

  it('all regions agreeing produce no candidate', () => {
    expect(
      detectSplitCandidates(
        { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('pass')] },
        emptyRegistry,
      ),
    ).toEqual([])
    expect(
      detectSplitCandidates(
        { 'eu-west-2': [verdict('fail')], 'us-east-1': [verdict('fail')] },
        emptyRegistry,
      ),
    ).toEqual([])
  })

  it('one region indeterminate produces NO candidate: absence is not disagreement', () => {
    const candidates = detectSplitCandidates(
      {
        'eu-west-2': [verdict('pass')],
        'us-east-1': [verdict('indeterminate', { reason: { reason: 'transport', at: 'test' } })],
        'eu-central-1': [verdict('fail')],
      },
      emptyRegistry,
    )
    expect(candidates).toEqual([])
  })

  it('a skip anywhere disqualifies the test: a declined probe is not an answer to compare', () => {
    expect(
      detectSplitCandidates(
        {
          'eu-west-2': [verdict('pass')],
          'us-east-1': [verdict('skip')],
          'eu-central-1': [verdict('fail')],
        },
        emptyRegistry,
      ),
    ).toEqual([])
  })

  it('a test with an admitted registry row is not a candidate: that disagreement is expected', () => {
    expect(
      detectSplitCandidates(
        { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('fail')] },
        rowFor(),
      ),
    ).toEqual([])
  })
})

describe('detectRegistryDrift', () => {
  it('regions still behaving as recorded produce no finding', () => {
    expect(
      detectRegistryDrift(
        { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('fail')] },
        rowFor(),
      ),
    ).toEqual([])
  })

  it('an admitted row whose regions have converged produces a reconciliation finding, not a registry edit', () => {
    const findings = detectRegistryDrift(
      { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('pass')] },
      rowFor(),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('converged')
    expect(findings[0].mismatched).toEqual(['us-east-1'])
  })

  it('the pinned region no longer matching its own recorded answer is drift of kind moved', () => {
    const findings = detectRegistryDrift(
      { 'eu-west-2': [verdict('fail')], 'us-east-1': [verdict('fail')] },
      rowFor(),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('moved')
  })

  it('an indeterminate observation draws no drift conclusion', () => {
    const findings = detectRegistryDrift(
      {
        'eu-west-2': [verdict('pass')],
        'us-east-1': [
          verdict('indeterminate', { reason: { reason: 'throttle-exhausted', at: 'test' } }),
        ],
      },
      rowFor(),
    )
    expect(findings).toEqual([])
  })
})

describe('confirmCandidates', () => {
  const candidate = { test: TEST, regions: { 'eu-west-2': 'pass', 'us-east-1': 'fail' } }

  it('confirms a candidate every re-run reproduces', async () => {
    const calls = []
    const runTest = (region) => {
      calls.push(region)
      return candidate.regions[region]
    }
    const { confirmed, discarded } = await confirmCandidates([candidate], { runs: 3, runTest })
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0].confirmation).toEqual({ runs: 3 })
    expect(discarded).toEqual([])
    // Targeted: only the disagreeing regions, only that test, runs× each.
    expect(calls.filter((r) => r === 'eu-west-2')).toHaveLength(3)
    expect(calls.filter((r) => r === 'us-east-1')).toHaveLength(3)
  })

  it('discards a candidate that fails to reproduce: it was non-determinism, not a split', async () => {
    let n = 0
    const runTest = (region) => (++n === 4 ? 'pass' : candidate.regions[region])
    const { confirmed, discarded } = await confirmCandidates([candidate], { runs: 3, runTest })
    expect(confirmed).toEqual([])
    expect(discarded).toHaveLength(1)
    expect(discarded[0].reason).toMatch(/us-east-1 returned pass/)
  })

  it('an indeterminate re-run discards the candidate: absence cannot confirm anything', async () => {
    const runTest = () => 'indeterminate'
    const { confirmed, discarded } = await confirmCandidates([candidate], { runs: 5, runTest })
    expect(confirmed).toEqual([])
    expect(discarded).toHaveLength(1)
  })
})

describe('issue bodies', () => {
  const candidate = {
    test: TEST,
    regions: { 'eu-west-2': 'pass', 'us-east-1': 'fail' },
    confirmation: { runs: 5 },
  }

  it('a candidate issue carries the evidence, the provenance, and the human gate', () => {
    const issue = buildCandidateIssue(candidate, {
      date: '2026-07-11',
      runUrl: 'https://example.test/run/1',
      evidence: {
        'us-east-1': { status: 'failed', failureMessages: ['ValidationException: nope'] },
      },
    })
    expect(issue.title).toContain(TEST.fullName)
    expect(issue.labels).toEqual(['split-candidate'])
    expect(issue.body).toContain(TEST.file)
    expect(issue.body).toContain('2026-07-11')
    expect(issue.body).toContain('https://example.test/run/1')
    expect(issue.body).toContain('ValidationException: nope')
    expect(issue.body).toContain('re-run 5× per region')
    expect(issue.body).toContain('never writes `registry/splits.json`')
  })

  it('a drift issue names the row, both readings, and leaves adjudication to a human', () => {
    const [finding] = detectRegistryDrift(
      { 'eu-west-2': [verdict('pass')], 'us-east-1': [verdict('pass')] },
      rowFor(),
    )
    const issue = buildDriftIssue(finding, { date: '2026-07-11' })
    expect(issue.title).toBe('Registry drift: row-1 (converged)')
    expect(issue.labels).toEqual(['registry-drift'])
    expect(issue.body).toContain('| us-east-1 | fail | pass |')
    expect(issue.body).toContain('never writes `registry/splits.json`')
  })

  it('a page issue says drop and page were one act, and that the region rejoins on recovery', () => {
    const issue = buildPageIssue(
      { region: 'sa-east-1', reasons: [{ kind: 'missing-results', detail: 'no results file' }] },
      { date: '2026-07-11' },
    )
    expect(issue.title).toContain('sa-east-1')
    expect(issue.labels).toEqual(['region-dropped'])
    expect(issue.body).toContain('two consecutive sweeps')
    expect(issue.body).toContain('missing-results')
    expect(issue.body).toContain('rejoins the observed set')
  })
})

describe('fileIssue', () => {
  const issue = { title: 'Split candidate: x', labels: ['split-candidate'], body: 'b' }

  it('creates an issue when no open issue carries the title', () => {
    const calls = []
    const exec = (args) => {
      calls.push(args)
      return args[0] === 'issue' && args[1] === 'list' ? '[]' : ''
    }
    expect(fileIssue(issue, { exec })).toEqual({ action: 'created' })
    expect(calls.at(-1).slice(0, 2)).toEqual(['issue', 'create'])
  })

  it('comments on an existing open issue rather than duplicating it', () => {
    const calls = []
    const exec = (args) => {
      calls.push(args)
      return args[0] === 'issue' && args[1] === 'list'
        ? JSON.stringify([{ number: 7, title: issue.title }])
        : ''
    }
    expect(fileIssue(issue, { exec })).toEqual({ action: 'commented', number: 7 })
    expect(calls.at(-1).slice(0, 3)).toEqual(['issue', 'comment', '7'])
  })
})

describe('parseArgs', () => {
  it('refuses any output path that resolves to the split registry', () => {
    expect(() => parseArgs(['gt', '--out', 'registry/splits.json'])).toThrow(
      /only a human edits/,
    )
    expect(() =>
      parseArgs(['gt', '--record-health', './registry/../registry/splits.json']),
    ).toThrow(/only a human edits/)
  })

  it('rejects unknown options rather than ignoring them', () => {
    expect(() => parseArgs(['gt', '--frobnicate'])).toThrow(/unknown option/)
  })

  it('rejects an empty --expect: silently covering no regions is not an option', () => {
    expect(() => parseArgs(['gt', '--expect', ''])).toThrow(/at least one region/)
  })
})

// ── CLI integration: the script end to end, on fixtures, with no AWS ─────────

// A minimal Vitest-shaped results document.
function resultsDoc(assertions) {
  return {
    testResults: [
      {
        name: `/home/runner/work/suite/${TEST.file}`,
        assertionResults: assertions.map((a) => ({
          title: TEST.title,
          fullName: a.fullName ?? TEST.fullName,
          status: a.status,
          meta: a.meta ?? {},
          failureMessages: a.failureMessages ?? [],
        })),
      },
    ],
  }
}

function writeFixtures(dir) {
  const gt = join(dir, 'ground-truth')
  const registryPath = join(dir, 'splits.json')
  const healthPath = join(dir, 'regions.json')
  spawnSync('mkdir', ['-p', gt])
  writeFileSync(
    join(gt, 'eu-west-2.json'),
    JSON.stringify(resultsDoc([{ status: 'passed' }])),
  )
  writeFileSync(
    join(gt, 'us-east-1.json'),
    JSON.stringify(
      resultsDoc([{ status: 'failed', failureMessages: ['ValidationException: nope'] }]),
    ),
  )
  writeFileSync(registryPath, JSON.stringify(rowFor({ ...TEST, fullName: 'some other test' }), null, 2))
  writeFileSync(
    healthPath,
    JSON.stringify({
      regions: { 'sa-east-1': { lastResolved: '2026-06-29', consecutiveUnresolved: 1 } },
    }),
  )
  return { gt, registryPath, healthPath }
}

function runCli(args, cwd) {
  return spawnSync('node', [join(process.cwd(), 'scripts/sweep-detect.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  })
}

describe('the CLI, end to end on fixtures', () => {
  it('detects, reports, records health, and never touches the split registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
    const { gt, registryPath, healthPath } = writeFixtures(dir)
    const registryBefore = readFileSync(registryPath, 'utf8')

    const res = runCli(
      [
        gt,
        '--registry', registryPath,
        '--record-health', healthPath,
        '--expect', 'eu-west-2,us-east-1,sa-east-1',
        '--date', '2026-07-11',
        '--out', join(dir, 'report.json'),
      ],
      dir,
    )
    expect(res.status, res.stderr).toBe(0)

    // The integrity guarantee, asserted directly: the registry is byte-identical.
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore)

    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    // Two resolved regions disagree on the one test: one unconfirmed candidate.
    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0].regions).toEqual({ 'eu-west-2': 'pass', 'us-east-1': 'fail' })
    expect(report.confirmed).toEqual([])
    // A region the sweep was meant to cover but produced nothing is unresolved,
    // never silent.
    expect(report.regions['sa-east-1'].resolved).toBe(false)
    expect(report.regions['sa-east-1'].reasons[0].kind).toBe('missing-results')

    // Health recorded: the second consecutive miss drops sa-east-1 and pages in
    // the same act; the resolved regions reset to zero.
    const health = JSON.parse(readFileSync(healthPath, 'utf8'))
    expect(health.regions['sa-east-1']).toEqual({
      lastResolved: '2026-06-29',
      consecutiveUnresolved: 2,
    })
    expect(health.regions['eu-west-2']).toEqual({
      lastResolved: '2026-07-11',
      consecutiveUnresolved: 0,
    })
    expect(report.pages).toEqual([
      { region: 'sa-east-1', reasons: report.regions['sa-east-1'].reasons },
    ])

    // Without --file-issues the page issue is a dry run on stdout; without
    // --confirm the unconfirmed candidate files nothing.
    expect(res.stdout).toContain('would file: Region dropped from the observed set: sa-east-1')
    expect(res.stdout).not.toContain('would file: Split candidate')
    expect(res.stdout).toContain('1 split candidate(s) (unconfirmed)')
  })

  it('a region failing only an admitted-split test resolves: admission must never spend the sick budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
    const { gt, registryPath } = writeFixtures(dir)
    // Point the registry row at the fixture test itself: us-east-1's failure
    // is now a recorded regional difference, matching the row's rejected side.
    writeFileSync(registryPath, JSON.stringify(rowFor(), null, 2))

    const res = runCli(
      [
        gt,
        '--registry', registryPath,
        '--expect', 'eu-west-2,us-east-1',
        '--date', '2026-07-11',
        '--out', join(dir, 'report.json'),
      ],
      dir,
    )
    expect(res.status, res.stderr).toBe(0)

    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
    expect(report.regions['us-east-1'].resolved).toBe(true)
    expect(report.regions['us-east-1'].counts).toMatchObject({ failed: 1, explainedFailed: 1 })
    // The admitted disagreement is not a fresh candidate, and behaving as
    // recorded is not drift.
    expect(report.candidates).toEqual([])
    expect(report.drift).toEqual([])
  })

  it('surfaces drift on an admitted row as an issue body, still without touching the registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-detect-'))
    const { gt, registryPath } = writeFixtures(dir)
    // Re-point the registry at the fixture test, recorded as split - but both
    // fixture regions... first make them both pass so the row has converged.
    writeFileSync(registryPath, JSON.stringify(rowFor(), null, 2))
    writeFileSync(
      join(gt, 'us-east-1.json'),
      JSON.stringify(resultsDoc([{ status: 'passed' }])),
    )
    const registryBefore = readFileSync(registryPath, 'utf8')

    const res = runCli([gt, '--registry', registryPath, '--date', '2026-07-11'], dir)
    expect(res.status, res.stderr).toBe(0)
    expect(readFileSync(registryPath, 'utf8')).toBe(registryBefore)
    expect(res.stdout).toContain('would file: Registry drift: row-1 (converged)')
    // The converged test is not simultaneously a fresh candidate.
    expect(res.stdout).toContain('0 split candidate(s)')
  })
})
