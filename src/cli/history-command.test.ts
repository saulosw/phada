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
import { runHistory, runHistoryPrune } from './history-command.js'
import type { HistoryCommandDeps } from './history-command.js'

const root = mkdtempSync(join(tmpdir(), 'phada-history-command-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0

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

    expect(h.stdout()).toBe('No published comments in the history yet.\n')
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
