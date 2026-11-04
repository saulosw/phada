import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import { nodeFileSystem } from '../config/local-files.js'
import type { FetchReviewStateOptions } from '../github/pull-request-reviews.js'
import { reviewMarker } from '../publish/markers.js'
import type { Miss } from '../publish/misses.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { MissNotFoundError, MissingGitHubTokenError, UsageError } from './errors.js'
import type { HistoryCommandDeps } from './history-access.js'
import { runMisses, runMissesDismiss } from './misses-command.js'

const root = mkdtempSync(join(tmpdir(), 'phada-misses-command-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0

const NOW = new Date('2026-10-22T12:00:00.000Z')
const REVIEWED = 'a'.repeat(40)
const COMMAND = { all: false, refresh: false, format: 'text' as const }

function miss(overrides: Partial<Miss> = {}): Miss {
  return {
    repo: 'acme/shop',
    number: 3,
    reviewedSha: REVIEWED,
    commitSha: 'c'.repeat(40),
    threadId: 'T9',
    threadUrl: 'https://github.com/acme/shop/pull/3#discussion_r9',
    file: 'src/shop.ts',
    startLine: 20,
    line: 22,
    author: 'alice',
    role: 'member',
    body: 'This loses the balance\nwhen the order fails.',
    createdAt: '2026-10-20T11:00:00Z',
    ...overrides,
  }
}

function harness(options: { config?: string; token?: boolean } = {}) {
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
      return reviewState({
        viewer: 'octocat',
        author: 'bob',
        reviews: [
          {
            id: 'R1',
            author: 'octocat',
            body: reviewMarker({ sha: REVIEWED, findings: 0 }),
            commitSha: REVIEWED,
            createdAt: '2026-10-20T10:00:00Z',
          },
        ],
        threads: [
          reviewThread({
            id: `T${request.number}`,
            path: 'src/cart.ts',
            line: null,
            originalLine: 8,
            isOutdated: true,
            url: `https://github.com/acme/shop/pull/${request.number}#discussion_r1`,
            author: 'carol',
            association: 'OWNER',
            bot: false,
            body: 'The total skips the discount.',
            createdAt: '2026-10-20T11:00:00Z',
          }),
        ],
      })
    },
  }
  const file = join(data, 'history.sqlite')
  const seed = async (seeding: (store: HistoryStore) => void) => {
    const store = await openHistoryStore(file)
    seeding(store)
    store.close()
  }
  return { deps, file, seed, fetched, stdout: () => out.join(''), stderr: () => err.join('') }
}

describe('runMisses', () => {
  it('says there are no misses without creating the history', async () => {
    const h = harness()

    await runMisses(COMMAND, h.deps)

    expect(h.stdout()).toBe('No misses in the history yet.\n')
    expect(existsSync(h.file)).toBe(false)
  })

  it('lists the open misses of a repository with where, who and the first line of the comment', async () => {
    const h = harness()
    await h.seed((store) => {
      store.recordMisses(
        [
          miss(),
          miss({ threadId: 'T10', repo: 'acme/web', body: 'Elsewhere.' }),
          miss({ threadId: 'T11', startLine: undefined, line: 5, body: 'Gone.' }),
        ],
        NOW.toISOString(),
      )
      const gone = store.misses({}).misses.find(({ threadId }) => threadId === 'T11')
      store.dismissMiss(gone?.id ?? 0)
    })

    await runMisses(
      { ...COMMAND, target: { kind: 'repo', repo: { owner: 'acme', repo: 'shop' } } },
      h.deps,
    )

    expect(h.stdout()).toBe(
      [
        '   1  acme/shop#3  src/shop.ts:20-22  alice (member)  open',
        '      This loses the balance',
        '      https://github.com/acme/shop/pull/3#discussion_r9',
        '',
        '1 dismissed miss not shown; add --all to see it.',
        '',
      ].join('\n'),
    )
  })

  it('--all shows the dismissed ones too', async () => {
    const h = harness()
    await h.seed((store) => {
      store.recordMisses([miss({ startLine: undefined })], NOW.toISOString())
      store.dismissMiss(store.misses({}).misses[0]?.id ?? 0)
    })

    await runMisses({ ...COMMAND, all: true }, h.deps)

    expect(h.stdout().split('\n')[0]).toBe(
      '   1  acme/shop#3  src/shop.ts:22  alice (member)  dismissed',
    )
  })

  it('cleans what people wrote before it reaches the terminal and cuts a long first line', async () => {
    const h = harness()
    await h.seed((store) => {
      store.recordMisses(
        [miss({ author: 'ev\u001b[31mil', body: `\u001b]8;;x\u0007${'y'.repeat(200)}` })],
        NOW.toISOString(),
      )
    })

    await runMisses(COMMAND, h.deps)

    expect(h.stdout()).not.toContain('\u001b')
    const [, comment] = h.stdout().split('\n')
    expect(comment?.length).toBeLessThanOrEqual(106)
    expect(comment?.endsWith('…')).toBe(true)
  })

  it('prints the misses as JSON', async () => {
    const h = harness()
    await h.seed((store) => store.recordMisses([miss({ startLine: undefined })], NOW.toISOString()))

    await runMisses({ ...COMMAND, format: 'json' }, h.deps)

    expect(JSON.parse(h.stdout())).toEqual({
      schemaVersion: 1,
      total: 1,
      misses: [
        {
          id: 1,
          repo: 'acme/shop',
          number: 3,
          file: 'src/shop.ts',
          startLine: null,
          line: 22,
          author: 'alice',
          role: 'member',
          body: 'This loses the balance\nwhen the order fails.',
          threadUrl: 'https://github.com/acme/shop/pull/3#discussion_r9',
          reviewedSha: REVIEWED,
          commitSha: 'c'.repeat(40),
          createdAt: '2026-10-20T11:00:00Z',
          harvestedAt: NOW.toISOString(),
          state: 'open',
        },
      ],
    })
  })

  it('prints empty JSON without a history', async () => {
    const h = harness()

    await runMisses({ ...COMMAND, format: 'json' }, h.deps)

    expect(JSON.parse(h.stdout())).toEqual({ schemaVersion: 1, total: 0, misses: [] })
  })

  it('--refresh harvests the pull request it names, even when the history does not know it', async () => {
    const h = harness()

    await runMisses(
      {
        ...COMMAND,
        refresh: true,
        target: { kind: 'pull', ref: { owner: 'acme', repo: 'shop', number: 8 } },
      },
      h.deps,
    )

    expect(h.fetched.map(({ number, token }) => `${number} ${token}`)).toEqual(['8 ghp_test'])
    expect(h.stderr()).toBe('Refreshing 1 pull request…\nFound 1 new miss.\n')
    expect(h.stdout()).toContain('acme/shop#8  src/cart.ts:8  carol (owner)  open')
  })

  it('--refresh harvests the due pull requests of a repository', async () => {
    const h = harness()
    const run = {
      source: 'watch' as const,
      repo: 'acme/shop',
      number: 3,
      headSha: REVIEWED,
      startedAt: '2026-10-20T09:00:00.000Z',
      finishedAt: '2026-10-20T09:30:00.000Z',
      status: 'dry-run' as const,
      aiCalled: true,
      provider: 'claude',
    }
    await h.seed((store) => {
      store.addRun(run)
      store.addRun({ ...run, repo: 'acme/web' })
    })

    await runMisses(
      {
        ...COMMAND,
        refresh: true,
        target: { kind: 'repo', repo: { owner: 'acme', repo: 'shop' } },
      },
      h.deps,
    )

    expect(h.fetched.map(({ repo, number }) => `${repo}#${number}`)).toEqual(['shop#3'])
  })

  it('--refresh refuses without a token or when the history is off', async () => {
    await expect(
      runMisses({ ...COMMAND, refresh: true }, harness({ token: false }).deps),
    ).rejects.toBeInstanceOf(MissingGitHubTokenError)
    await expect(
      runMisses({ ...COMMAND, refresh: true }, harness({ config: 'history: false' }).deps),
    ).rejects.toThrow(
      new UsageError('--refresh saves to the history; remove history: false from your config.'),
    )
  })
})

describe('runMissesDismiss', () => {
  it('takes a miss off the list', async () => {
    const h = harness()
    await h.seed((store) => store.recordMisses([miss()], NOW.toISOString()))

    await runMissesDismiss({ id: 1 }, h.deps)

    expect(h.stderr()).toBe('Dismissed miss 1; phada misses no longer lists it.\n')
    const store = await openHistoryStore(h.file)
    expect(store.misses({}).misses[0]?.state).toBe('dismissed')
    store.close()
  })

  it('refuses a miss the history does not have', async () => {
    const h = harness()

    await expect(runMissesDismiss({ id: 4 }, h.deps)).rejects.toBeInstanceOf(MissNotFoundError)
    expect(existsSync(h.file)).toBe(false)
  })
})
