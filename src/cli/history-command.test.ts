import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import { nodeFileSystem } from '../config/local-files.js'
import { PullRequestNotFoundError } from '../github/errors.js'
import type { FetchReviewStateOptions } from '../github/pull-request-reviews.js'
import { FINDING_MARKER } from '../publish/markers.js'
import { openHistoryStore } from '../store/history-store.js'
import type { RunRecord } from '../store/history-store.js'
import { MissingGitHubTokenError, UsageError } from './errors.js'
import { runHistory, runHistoryPrune, runHistoryShow } from './history-command.js'
import { contextReportFixture } from '../../test/support/context-report.js'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { RelatedReport } from '../app/related-report.js'
import type { Ci } from '../context/types.js'
import type { ImpactReport } from '../graph/report.js'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { Conversation } from '../publish/types.js'
import type { ReviewResult } from '../review/types.js'
import { formatAlreadyReviewedJson, formatReviewJson } from './format-json.js'
import type { Publication } from './format-json.js'
import { formatLocalTime } from './units.js'
import type { HistoryCommandDeps } from './history-command.js'

const root = mkdtempSync(join(tmpdir(), 'phada-history-command-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0
const local = (iso: string) => formatLocalTime(new Date(iso))

const NOW = new Date('2026-10-22T12:00:00.000Z')
const RUN: RunRecord = {
  source: 'manual',
  repo: 'acme/shop',
  number: 3,
  headSha: 'a'.repeat(40),
  startedAt: '2026-10-22T10:00:00.000Z',
  finishedAt: '2026-10-22T10:01:00.000Z',
  status: 'published',
  aiCalled: true,
  provider: 'claude',
  findings: 1,
  score: 4,
  url: 'https://github.com/acme/shop/pull/3#pullrequestreview-1',
}

const COMMAND = {
  limit: 50,
  stats: false,
  refresh: false,
  format: 'text' as const,
  debug: false,
}

function harness(
  options: {
    config?: string
    token?: boolean
    fetchReviewState?: HistoryCommandDeps['fetchReviewState']
  } = {},
) {
  const data = join(root, `d${++dirs}`)
  const out: string[] = []
  const err: string[] = []
  const fetched: FetchReviewStateOptions[] = []
  const config = memoryFiles(
    options.config === undefined ? {} : { '/cfg/config.yml': options.config },
  )
  const deps: HistoryCommandDeps = {
    env: {
      PHADA_CONFIG_HOME: '/cfg',
      PHADA_DATA_HOME: data,
      ...(options.token === false ? {} : { GITHUB_TOKEN: 'ghp_test' }),
    },
    ghToken: async () => undefined,
    home: '/home/u',
    files: { ...config, exists: (path) => nodeFileSystem.exists(path) },
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    clock: () => NOW,
    openHistoryStore: (path) => openHistoryStore(path),
    fetchReviewState: async (request) => {
      fetched.push(request)
      if (options.fetchReviewState !== undefined) return options.fetchReviewState(request)
      return reviewState({
        threads: [
          reviewThread({
            id: `T${request.number}`,
            isResolved: true,
            path: 'src/shop.ts',
            body: `**P1** · Spend has no auth · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
          }),
        ],
      })
    },
  }
  const file = join(data, 'history.sqlite')
  const seed = async (seeding: (store: Awaited<ReturnType<typeof openHistoryStore>>) => void) => {
    const store = await openHistoryStore(file)
    seeding(store)
    store.close()
  }
  return {
    deps,
    file,
    seed,
    fetched,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

describe('runHistory', () => {
  it('says the history is empty without creating the file', async () => {
    const h = harness()

    await runHistory(COMMAND, h.deps)

    expect(h.stdout()).toBe('No reviews in the history yet.\n')
    expect(existsSync(h.file)).toBe(false)
  })

  it('prints empty JSON without a file', async () => {
    const h = harness()

    await runHistory({ ...COMMAND, format: 'json' }, h.deps)

    expect(JSON.parse(h.stdout())).toEqual({ schemaVersion: 1, total: 0, runs: [], findings: [] })
  })

  it('lists the runs of a repository since a time', async () => {
    const h = harness()
    await h.seed((store) => {
      store.addRun(RUN)
      store.addRun({ ...RUN, startedAt: '2026-09-01T10:00:00.000Z' })
      store.addRun({ ...RUN, repo: 'acme/web' })
    })

    await runHistory(
      {
        ...COMMAND,
        target: { kind: 'repo', repo: { owner: 'acme', repo: 'shop' } },
        sinceMs: 86_400_000,
        format: 'json',
      },
      h.deps,
    )

    const json = JSON.parse(h.stdout()) as { total: number; runs: { repo: string }[] }
    expect(json.total).toBe(1)
    expect(json.runs.map((run) => run.repo)).toEqual(['acme/shop'])
  })

  it('shows the findings of a pull request', async () => {
    const h = harness()
    await h.seed((store) => {
      store.addRun(RUN)
      store.observeFeedback({
        repo: 'acme/shop',
        number: 3,
        pullState: 'open',
        observedAt: RUN.startedAt,
        source: 'manual',
        threads: [
          {
            threadId: 'T1',
            fingerprint: 'src/shop.ts:x',
            url: '',
            file: 'src/shop.ts',
            line: 4,
            title: 'X',
            severity: 'P2',
            commitSha: null,
            outdated: false,
            destination: 'dismissed',
            signals: ['dismissed'],
          },
        ],
      })
    })

    await runHistory(
      { ...COMMAND, target: { kind: 'pull', ref: { owner: 'acme', repo: 'shop', number: 3 } } },
      h.deps,
    )

    expect(h.stdout()).toContain('Findings:\n  P2  src/shop.ts:4  X  dismissed')
  })

  it('a text list without a pull request does not read the findings', async () => {
    const h = harness()
    await h.seed((store) => store.addRun(RUN))
    let reads = 0
    h.deps.openHistoryStore = async (path) => {
      const store = await openHistoryStore(path)
      return new Proxy(store, {
        get(target, key) {
          if (key === 'findings') reads++
          const value = Reflect.get(target, key) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }

    await runHistory(COMMAND, h.deps)
    await runHistory({ ...COMMAND, format: 'json' }, h.deps)

    expect(reads).toBe(1)
  })

  it('points to the recorded comments when there are no reviews to list', async () => {
    const h = harness()
    await h.seed((store) =>
      store.observeFeedback({
        repo: 'acme/shop',
        number: 3,
        pullState: 'open',
        observedAt: RUN.startedAt,
        source: 'refresh',
        threads: [
          {
            threadId: 'T1',
            fingerprint: 'src/shop.ts:x',
            url: '',
            file: 'src/shop.ts',
            line: 4,
            title: 'X',
            severity: 'P2',
            commitSha: null,
            outdated: false,
            destination: 'open',
            signals: [],
          },
        ],
      }),
    )

    await runHistory(
      { ...COMMAND, target: { kind: 'repo', repo: { owner: 'acme', repo: 'shop' } } },
      h.deps,
    )

    expect(h.stdout()).toBe(
      'No reviews in the history yet, but 1 Phada comment is recorded. See what happened to it with --stats, or with owner/repo#N for one pull request.\n',
    )
  })

  it('warns when the config turns the history off and still lists', async () => {
    const h = harness({ config: 'history: false' })
    await h.seed((store) => store.addRun(RUN))

    await runHistory(COMMAND, h.deps)

    expect(h.stderr()).toBe('The history is off in your config; nothing new is saved.\n')
    expect(h.stdout()).toContain('acme/shop#3')
  })

  it('prints the stats', async () => {
    const h = harness()
    await h.seed((store) => store.addRun(RUN))

    await runHistory({ ...COMMAND, stats: true }, h.deps)

    expect(h.stdout()).toContain('No published comments in the history yet.\n')
  })

  it('says the history is empty for --stats without a file', async () => {
    const h = harness()

    await runHistory({ ...COMMAND, stats: true }, h.deps)

    expect(h.stdout()).toBe('No reviews in the history yet.\n')
  })

  it('--refresh refuses without a token', async () => {
    const h = harness({ token: false })

    await expect(runHistory({ ...COMMAND, refresh: true }, h.deps)).rejects.toBeInstanceOf(
      MissingGitHubTokenError,
    )
  })

  it('--refresh refuses when the history is off', async () => {
    const h = harness({ config: 'history: false' })

    await expect(runHistory({ ...COMMAND, refresh: true }, h.deps)).rejects.toThrow(
      new UsageError('--refresh saves to the history; remove history: false from your config.'),
    )
  })

  it('--refresh reads the due pull requests of the filter before listing', async () => {
    const h = harness()
    await h.seed((store) => {
      store.addRun(RUN)
      store.addRun({ ...RUN, number: 4 })
      store.addRun({ ...RUN, repo: 'acme/web', number: 9 })
    })

    await runHistory(
      {
        ...COMMAND,
        refresh: true,
        stats: true,
        target: { kind: 'repo', repo: { owner: 'acme', repo: 'shop' } },
      },
      h.deps,
    )

    expect(
      h.fetched.map(({ owner, repo, number, token }) => `${owner}/${repo}#${number} ${token}`),
    ).toEqual(['acme/shop#3 ghp_test', 'acme/shop#4 ghp_test'])
    expect(h.stderr()).toBe('Refreshing 2 pull requests…\n')
    expect(h.stdout()).toContain('acme/shop: 2 comments · fixed 0 · dismissed 2 (100%)')
    const store = await openHistoryStore(h.file)
    expect(store.findings({})[0]?.signals[0]?.source).toBe('refresh')
    store.close()
  })

  it('--refresh reads the pull request it names even when the history does not know it', async () => {
    const h = harness()

    await runHistory(
      {
        ...COMMAND,
        refresh: true,
        target: { kind: 'pull', ref: { owner: 'acme', repo: 'shop', number: 8 } },
      },
      h.deps,
    )

    expect(h.fetched.map(({ number }) => number)).toEqual([8])
    expect(h.stdout()).toContain('Findings:\n  P1  src/shop.ts:10  Spend has no auth  dismissed')
  })

  it('--refresh warns about a pull request it cannot read and goes on', async () => {
    const h = harness({
      fetchReviewState: async (request) => {
        if (request.number === 3) throw new Error('timeout')
        throw new PullRequestNotFoundError('acme/shop#4')
      },
    })
    await h.seed((store) => {
      store.addRun(RUN)
      store.addRun({ ...RUN, number: 4 })
    })

    await runHistory({ ...COMMAND, refresh: true }, h.deps)

    expect(h.stderr()).toBe('Refreshing 2 pull requests…\nWarning: acme/shop#3: timeout\n')
  })
})

describe('runHistoryPrune', () => {
  it('removes what is older than the cut and says how much', async () => {
    const h = harness()
    await h.seed((store) => {
      store.addRun({ ...RUN, startedAt: '2026-01-01T00:00:00.000Z' })
      store.addRun({ ...RUN, startedAt: '2026-02-01T00:00:00.000Z' })
      store.addRun(RUN)
    })

    await runHistoryPrune({ olderThanMs: 180 * 86_400_000 }, h.deps)

    expect(h.stdout()).toBe('Removed 2 reviews, 0 findings and 0 jobs older than 2026-04-25.\n')
  })

  it('says the history is empty without creating the file', async () => {
    const h = harness()

    await runHistoryPrune({ olderThanMs: 86_400_000 }, h.deps)

    expect(h.stdout()).toBe('No reviews in the history yet.\n')
    expect(existsSync(h.file)).toBe(false)
  })
})

describe('runHistoryShow', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const RESULT: ReviewResult = {
    target: { repo: 'acme/shop', number: 12, headSha: SHA },
    providerId: 'codex-cli',
    model: 'gpt-6-astra',
    durationMs: 16_400,
    usage: { inputTokens: 9700, outputTokens: 417 },
    passUsage: [
      { pass: 'review', usage: { inputTokens: 9000, cachedInputTokens: 4000, outputTokens: 400 } },
      { pass: 'verify', usage: { inputTokens: 700, outputTokens: 17 } },
    ],
    summary: 'Adds a spend endpoint.',
    files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
    findings: [findingFixture({ confidence: 68, line: 3, closeToCut: true })],
    worthChecking: [],
    worthCheckingOmitted: 0,
    minConfidence: 60,
    score: { value: 3, reason: '1 P1 finding' },
    dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
    claims: [
      { claim: 'Checks the balance', verdict: 'contradicted', evidence: 'No check in spend()' },
    ],
    passes: [
      {
        skill: 'guide',
        origin: 'user:config.yml',
        status: 'reviewed',
        mode: 'native',
        durationMs: 2000,
        findings: 1,
        captured: 0,
        blocked: [{ tool: 'Bash', input: 'npm test' }],
      },
    ],
  }
  const CONVERSATION: Conversation = {
    items: [
      { kind: 'comment', at: '2026-10-20T10:00:00Z', author: 'alice', role: 'member', body: 'Hi' },
    ],
    report: { items: 1, omitted: 0, resolved: 0, bots: 0, truncated: 0, bytes: 120 },
  }
  const CI: Ci = {
    entries: [],
    checks: [{ name: 'test', state: 'failing', conclusion: 'failure', annotations: ['a:1 boom'] }],
    summary: { state: 'failing', total: 1, failing: ['test'], pending: [] },
    report: {
      annotations: 1,
      omittedAnnotations: 0,
      logs: 0,
      omittedLogs: 0,
      truncated: 0,
      bytes: 900,
    },
  }
  const IMPACT: ImpactReport = {
    status: 'used',
    changed: [
      {
        kind: 'function',
        name: 'spend',
        path: 'src/shop.ts',
        lines: [1, 9],
        callers: 2,
        files: 1,
        shown: 2,
        dependencies: 0,
        capped: false,
      },
    ],
    totals: { symbols: 1, callers: 2, files: 1 },
    learned: [],
  }
  const RELATED: RelatedReport = {
    status: 'used',
    repositories: [
      {
        repo: 'acme/web',
        origin: 'user:config.yml',
        commit: 'f'.repeat(40),
        state: 'consumers',
        count: 3,
        packages: [],
        graph: true,
      },
    ],
  }
  const INVESTIGATION: InvestigationReport = {
    status: 'used',
    calls: [
      {
        pass: 'review',
        tool: 'read_file',
        server: null,
        target: 'src/wallet.ts',
        bytes: 2048,
        error: null,
        inSources: true,
      },
    ],
    external: [],
    totals: { calls: 1, bytes: 2048 },
  }
  const PREVIEW = {
    body: '## Phada review\n\nAdds a spend endpoint.',
    comments: [{ path: 'src/shop.ts', line: 3, body: '**P1** · spend has no auth' }],
  }

  function storedRun(json: string, changes: Partial<RunRecord> = {}): RunRecord {
    return {
      source: 'manual',
      repo: 'acme/shop',
      number: 12,
      headSha: SHA,
      startedAt: '2026-10-22T10:00:00.000Z',
      finishedAt: '2026-10-22T10:01:00.000Z',
      status: 'dry-run',
      aiCalled: true,
      provider: 'codex',
      model: 'gpt-6-astra',
      score: 3,
      findings: 1,
      resultJson: json,
      ...changes,
    }
  }

  function fullJson(publication: Publication): string {
    return formatReviewJson(
      pullRequestFixture({ title: 'Let users \u001bspend crystals' }),
      { status: 'reviewed', result: RESULT },
      publication,
      contextReportFixture(),
      INVESTIGATION,
      IMPACT,
      RELATED,
      null,
      () => 'add Bash(npm test) to review.commands',
      { conversation: CONVERSATION, ci: CI, impactText: 'spend (src/shop.ts:1-9): 2 callers' },
    )
  }

  const DRY_RUN: Publication = { status: 'dry-run', review: PREVIEW, stillOpen: 0 }
  const SHOW = { id: 1, format: 'text' as const }

  it('prints a run with the sections of the dry run', async () => {
    const h = harness()
    await h.seed((store) => store.addRun(storedRun(fullJson(DRY_RUN))))

    await runHistoryShow(SHOW, h.deps)

    const out = h.stdout()
    expect(out.split('\n').slice(0, 3)).toEqual([
      `Run 1 · acme/shop#12 at a1b2c3d · ${local('2026-10-22T10:00:00.000Z')} · manual · codex/gpt-6-astra · dry run`,
      'Let users spend crystals',
      '',
    ])
    const headings = out.split('\n').filter((line) => line.startsWith('## '))
    expect(headings).toEqual([
      '## Phada review',
      '## Close to the cut',
      '## Claims of the description',
      '## Context sent to the AI',
      '## Conversation sent to the AI',
      '## CI sent to the AI',
      '## Impact',
      '## Related repositories',
      '## Skills',
      '## Investigation',
      '## Tokens',
    ])
    for (const line of [
      '- P1 · src/shop.ts:3: spend has no auth (confidence 68)',
      '- contradicted: Checks the balance (No check in spend())',
      '- orm-only (.phada/config.yml, **/*.py)',
      '- comment by alice (member), 2026-10-20 10:00',
      '- test: failing (failure), 1 annotation',
      'spend (src/shop.ts:1-9): 2 callers',
      '- acme/web at fffffff (from user:config.yml): consumer, 3 call sites',
      '  - blocked: npm test — add Bash(npm test) to review.commands',
      '- read_file src/wallet.ts (2.0 KB) · used in a finding',
      '- review: 9.0k in (4.0k cached) · 400 out',
      '- total: 9.7k in (4.0k cached) · 417 out',
    ]) {
      expect(out).toContain(`${line}\n`)
    }
    expect(out).toContain('**P1** · spend has no auth')
    expect(out).not.toContain('\u001b')
  })

  it('shows what a published run posted and where', async () => {
    const h = harness()
    const url = 'https://github.com/acme/shop/pull/12#pullrequestreview-1'
    const published: Publication = {
      status: 'published',
      url,
      comments: 1,
      stillOpen: 0,
      review: PREVIEW,
    }
    await h.seed((store) =>
      store.addRun(storedRun(fullJson(published), { status: 'published', url })),
    )

    await runHistoryShow(SHOW, h.deps)

    expect(h.stdout().split('\n')[0]).toMatch(
      / · codex\/gpt-6-astra · published https:\/\/github\.com\/acme\/shop\/pull\/12#pullrequestreview-1$/,
    )
    expect(h.stdout()).toContain('\n## Phada review\n\nAdds a spend endpoint.\n')
  })

  it('shows what a run of an older version kept', async () => {
    const h = harness()
    const old = JSON.stringify({
      schemaVersion: 1,
      status: 'reviewed',
      pullRequest: { title: 'Old run' },
      review: {
        summary: 'Adds a spend endpoint.',
        findings: [{ severity: 'P1', confidence: 90, file: 'src/shop.ts', line: 3, title: 'x' }],
        minConfidence: 60,
      },
      publication: {
        status: 'published',
        url: 'https://github.com/acme/shop/pull/12',
        comments: 1,
      },
      context: contextReportFixture(),
      conversation: null,
      ci: null,
      investigation: { status: 'off', calls: [], external: [], totals: { calls: 0, bytes: 0 } },
      impact: { ...IMPACT },
    })
    await h.seed((store) => store.addRun(storedRun(old, { status: 'published' })))

    await runHistoryShow(SHOW, h.deps)

    const out = h.stdout()
    expect(out.split('\n').filter((line) => line.startsWith('## '))).toEqual([
      '## Context sent to the AI',
      '## Conversation sent to the AI',
      '## CI sent to the AI',
      '## Impact',
      '## Investigation',
    ])
    expect(out).toContain('## Conversation sent to the AI\n\nOff.\n')
    expect(out).toContain('## Impact\n\n- function spend (src/shop.ts:1-9): 2 callers in 1 file\n')
  })

  it('says why a run was skipped or failed', async () => {
    const h = harness()
    await h.seed((store) => {
      store.addRun(
        storedRun(
          formatAlreadyReviewedJson(pullRequestFixture(), { kind: 'open-threads', openThreads: 1 }),
          {
            status: 'skipped',
            aiCalled: false,
            reason: 'open-threads',
          },
        ),
      )
      store.addRun({
        ...storedRun('', { status: 'skipped', aiCalled: false, reason: 'ci-failing' }),
        resultJson: JSON.stringify({
          ci: { state: 'failing', failing: ['lint'], pending: ['e2e'], checks: [] },
        }),
      })
      const { resultJson: _, ...failed } = storedRun('', {
        status: 'failed',
        error: 'Codex \u001bfailed.',
      })
      store.addRun(failed)
    })

    await runHistoryShow(SHOW, h.deps)
    await runHistoryShow({ ...SHOW, id: 2 }, h.deps)
    await runHistoryShow({ ...SHOW, id: 3 }, h.deps)

    const runs = h.stdout().split(/\n(?=Run \d)/)
    expect(runs[0]).toMatch(/· skipped: open-threads\n/)
    expect(runs[0]).toContain('## Tokens\n\nNo AI call.')
    expect(runs[1]).toMatch(/· skipped: ci-failing\nCI: failing; failing: lint; pending: e2e$/)
    expect(runs[2]).toMatch(/· failed: Codex failed\.\n$/)
  })

  it('prints the stored run as JSON with its history fields', async () => {
    const h = harness()
    const json = fullJson(DRY_RUN)
    await h.seed((store) => store.addRun(storedRun(json)))

    await runHistoryShow({ ...SHOW, format: 'json' }, h.deps)

    const printed = JSON.parse(h.stdout()) as Record<string, unknown>
    expect(printed).toEqual({
      schemaVersion: 1,
      run: expect.objectContaining({
        id: 1,
        repo: 'acme/shop',
        number: 12,
        status: 'dry-run',
        provider: 'codex',
      }) as unknown,
      result: JSON.parse(json) as unknown,
    })
  })

  it('refuses a run the history does not have', async () => {
    const h = harness()
    await h.seed((store) => store.addRun(RUN))

    await expect(runHistoryShow({ ...SHOW, id: 9 }, h.deps)).rejects.toThrow(
      'No run 9 in the history.',
    )
  })

  it('says the history is empty without creating the file', async () => {
    const h = harness()

    await runHistoryShow(SHOW, h.deps)

    expect(h.stdout()).toBe('No reviews in the history yet.\n')
    expect(existsSync(h.file)).toBe(false)
  })
})
