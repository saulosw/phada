import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import { nodeFileSystem } from '../config/local-files.js'
import { COMPARE_MAX_FILES, ComparisonDivergedError } from '../github/compare-commits.js'
import type { CompareOptions } from '../github/compare-commits.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import { FINDING_MARKER, reviewMarker } from '../publish/markers.js'
import type { Miss } from '../publish/misses.js'
import { createExtractor } from '../repo-map/extract.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore, RunRecord } from '../store/history-store.js'
import { MissNotFoundError, MissingGitHubTokenError, UsageError } from './errors.js'
import type { HistoryCommandDeps } from './history-access.js'
import { runMisses, runMissesDismiss } from './misses-command.js'
import type { MissesCommandDeps } from './misses-command.js'

const root = mkdtempSync(join(tmpdir(), 'phada-misses-command-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0

const NOW = new Date('2026-10-22T12:00:00.000Z')
const REVIEWED = 'a'.repeat(40)
const COMMAND = { all: false, refresh: false, format: 'text' as const }

function miss(overrides: Partial<Miss> = {}): Miss {
  return {
    key: overrides.threadId ?? 'T9',
    origin: 'person',
    seen: 'missed-live',
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

function harness(
  options: {
    config?: string
    token?: boolean
    configHome?: string
    state?: (request: FetchReviewStateOptions) => PullRequestReviewState
    fetchRepositoryFile?: HistoryCommandDeps['fetchRepositoryFile']
    fetchComparison?: HistoryCommandDeps['fetchComparison']
    listClosedPullRequests?: MissesCommandDeps['listClosedPullRequests']
  } = {},
) {
  const data = join(root, `d${++dirs}`)
  const out: string[] = []
  const err: string[] = []
  const fetched: FetchReviewStateOptions[] = []
  const config = memoryFiles(
    options.config === undefined ? {} : { '/cfg/config.yml': options.config },
  )
  const deps: MissesCommandDeps = {
    env: {
      PHADA_CONFIG_HOME: options.configHome ?? '/cfg',
      PHADA_DATA_HOME: data,
      ...(options.token === false ? {} : { GITHUB_TOKEN: 'ghp_test' }),
    },
    ghToken: async () => undefined,
    home: '/home/u',
    files:
      options.configHome === undefined
        ? { ...config, exists: (path) => nodeFileSystem.exists(path) }
        : nodeFileSystem,
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    clock: () => NOW,
    openHistoryStore: (path) => openHistoryStore(path),
    fetchRepositoryFile: options.fetchRepositoryFile ?? (async () => null),
    fetchComparison: options.fetchComparison ?? (async () => []),
    createExtractor,
    listClosedPullRequests:
      options.listClosedPullRequests ??
      (async () => {
        throw new Error('listClosedPullRequests was not expected')
      }),
    fetchReviewState: async (request) => {
      fetched.push(request)
      if (options.state !== undefined) return options.state(request)
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
        '   1  acme/shop#3  src/shop.ts:20-22  alice (member)  person · missed-live  open',
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
      '   1  acme/shop#3  src/shop.ts:22  alice (member)  person · missed-live  dismissed',
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
          origin: 'person',
          seen: 'missed-live',
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

  it('shows a miss without a thread, a role or a reviewed commit by its origin and mark', async () => {
    const h = harness()
    const unseen: Miss = {
      key: 'phada:4:a',
      origin: 'phada',
      seen: 'not-reviewed',
      repo: 'acme/shop',
      number: 3,
      commitSha: 'c'.repeat(40),
      file: 'src/shop.ts',
      line: 22,
      author: 'phada',
      body: 'The timeout is never read.',
      createdAt: '2026-10-20T11:00:00Z',
    }
    await h.seed((store) => store.recordMisses([unseen], NOW.toISOString()))

    await runMisses(COMMAND, h.deps)
    const text = h.stdout()
    await runMisses({ ...COMMAND, format: 'json' }, h.deps)
    const json = JSON.parse(h.stdout().slice(text.length))

    expect(text).toBe(
      [
        '   1  acme/shop#3  src/shop.ts:22  phada  phada · not-reviewed  open',
        '      The timeout is never read.',
        '',
      ].join('\n'),
    )
    expect(json.misses).toEqual([
      expect.objectContaining({
        origin: 'phada',
        seen: 'not-reviewed',
        author: 'phada',
        role: null,
        threadUrl: null,
        reviewedSha: null,
        commitSha: 'c'.repeat(40),
      }),
    ])
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
    expect(h.stdout()).toContain(
      'acme/shop#8  src/cart.ts:8  carol (owner)  person · missed-live  open',
    )
  })

  it('--refresh reads the file at the commit of the thread to tell whether a Phada finding sat in the same function', async () => {
    const source = [
      'export function total(items: number[]): number {',
      ...Array.from({ length: 23 }, (_, index) => `  items.push(${index})`),
      '  return items.length',
      '}',
    ].join('\n')
    const read: string[] = []
    const h = harness({
      fetchRepositoryFile: async ({ owner, repo, token, path, ref }) => {
        read.push(`${owner}/${repo} ${token} ${path}@${ref.slice(0, 1)}`)
        return source
      },
      state: () =>
        reviewState({
          viewer: 'octocat',
          author: 'bob',
          threads: [
            reviewThread({
              id: 'T1',
              path: 'src/cart.ts',
              line: null,
              originalLine: 8,
              originalCommit: 'c'.repeat(40),
              isOutdated: true,
              author: 'carol',
              association: 'OWNER',
              bot: false,
              body: 'The total skips the discount.',
              createdAt: '2026-10-20T11:00:00Z',
            }),
            reviewThread({
              id: 'P1',
              path: 'src/cart.ts',
              line: 20,
              author: 'octocat',
              body: `**P2** · Something · confidence 80\n\nWhy.\n\n${FINDING_MARKER}`,
              createdAt: '2026-10-20T10:00:00Z',
            }),
          ],
        }),
    })

    await runMisses(
      {
        ...COMMAND,
        refresh: true,
        target: { kind: 'pull', ref: { owner: 'acme', repo: 'shop', number: 8 } },
      },
      h.deps,
    )

    expect(read).toEqual(['acme/shop ghp_test src/cart.ts@c'])
    expect(h.stderr()).toBe('Refreshing 1 pull request…\n')
  })

  it('--refresh harvests the threads of the bots listed in the user config of that repository, on a pull request Phada never reviewed', async () => {
    const configHome = join(root, `c${++dirs}`)
    mkdirSync(join(configHome, 'repos', 'acme', 'shop'), { recursive: true })
    writeFileSync(
      join(configHome, 'repos', 'acme', 'shop', 'config.yml'),
      'misses:\n  bots: [review-bot]\n',
    )
    const thread = (id: string, author: string) =>
      reviewThread({
        id,
        path: 'src/cart.ts',
        line: null,
        originalLine: 93,
        originalCommit: 'c'.repeat(40),
        isOutdated: true,
        url: `https://github.com/acme/shop/pull/8#discussion_${id}`,
        author,
        association: 'NONE',
        bot: true,
        body: 'The card is created twice.',
        createdAt: '2026-10-20T11:00:00Z',
      })
    const h = harness({
      configHome,
      state: () =>
        reviewState({
          viewer: 'octocat',
          author: 'bob',
          threads: [thread('T1', 'review-bot[bot]'), thread('T2', 'dependabot[bot]')],
        }),
    })

    await runMisses(
      {
        ...COMMAND,
        refresh: true,
        format: 'json',
        target: { kind: 'pull', ref: { owner: 'acme', repo: 'shop', number: 8 } },
      },
      h.deps,
    )

    expect(h.stderr()).toBe('Refreshing 1 pull request…\nFound 1 new miss.\n')
    expect(JSON.parse(h.stdout()).misses).toEqual([
      expect.objectContaining({
        origin: 'bot',
        seen: 'not-reviewed',
        author: 'review-bot[bot]',
        file: 'src/cart.ts',
        line: 93,
        reviewedSha: null,
        commitSha: 'c'.repeat(40),
      }),
    ])
  })

  describe('--refresh on a pull request where a replay found what the review at the head lost', () => {
    const REPLAYED = `fd830e1${'0'.repeat(33)}`
    const HEAD = 'e'.repeat(40)
    const run = (overrides: Partial<RunRecord>): RunRecord => ({
      source: 'manual',
      repo: 'acme/pay',
      number: 480,
      headSha: HEAD,
      startedAt: '2026-10-29T09:50:00.000Z',
      finishedAt: '2026-10-29T10:00:00.000Z',
      status: 'published',
      aiCalled: true,
      provider: 'claude',
      resultJson: JSON.stringify({ review: { findings: [], worthChecking: [] } }),
      ...overrides,
    })
    const timeout = {
      severity: 'P2',
      confidence: 68,
      file: 'README.md',
      line: 57,
      title: 'aws lambda invoke waits without --cli-read-timeout',
      why: 'The invoke blocks for as long as the function runs.',
    }

    function scenario(fetchComparison: HistoryCommandDeps['fetchComparison']) {
      const configHome = join(root, `c${++dirs}`)
      mkdirSync(join(configHome, 'repos', 'acme', 'pay'), { recursive: true })
      writeFileSync(
        join(configHome, 'repos', 'acme', 'pay', 'config.yml'),
        'misses:\n  bots: [review-bot]\n',
      )
      return harness({
        configHome,
        fetchComparison,
        state: () =>
          reviewState({
            viewer: 'octocat',
            author: 'bob',
            reviews: [
              {
                id: 'R1',
                author: 'octocat',
                body: reviewMarker({ sha: HEAD, findings: 0 }),
                commitSha: HEAD,
                createdAt: '2026-10-29T10:00:00Z',
              },
            ],
            threads: [
              reviewThread({
                id: 'PRRT_93',
                path: 'src/ensure-card.ts',
                line: null,
                originalLine: 93,
                originalCommit: REPLAYED,
                isOutdated: true,
                url: 'https://github.com/acme/pay/pull/480#discussion_r93',
                author: 'review-bot[bot]',
                association: 'NONE',
                bot: true,
                body: 'The card is ensured twice when the lookup fails.',
                createdAt: '2026-10-28T09:00:00Z',
              }),
            ],
          }),
      })
    }

    const seeding = (store: HistoryStore) => {
      store.addRun(run({}))
      store.addRun(
        run({
          source: 'replay',
          headSha: REPLAYED,
          status: 'dry-run',
          startedAt: '2026-11-03T09:50:00.000Z',
          finishedAt: '2026-11-03T10:00:00.000Z',
          resultJson: JSON.stringify({ review: { findings: [timeout], worthChecking: [] } }),
        }),
      )
    }
    const command = {
      ...COMMAND,
      refresh: true,
      target: { kind: 'pull' as const, ref: { owner: 'acme', repo: 'pay', number: 480 } },
    }

    it('keeps the finding of the replay as a miss of Phada at the head, beside the miss of the listed bot', async () => {
      const compared: CompareOptions[] = []
      const h = scenario(async (options) => {
        compared.push(options)
        return [
          { path: 'README.md', status: 'modified', patch: '@@ -5,2 +5,3 @@\n a\n+b\n c' },
          {
            path: 'src/ensure-card.ts',
            status: 'modified',
            patch: '@@ -90,6 +90,8 @@',
          },
        ]
      })
      await h.seed(seeding)

      await runMisses({ ...command, format: 'json' }, h.deps)

      expect(compared).toEqual([
        { owner: 'acme', repo: 'pay', token: 'ghp_test', base: REPLAYED, head: HEAD },
      ])
      expect(h.stderr()).toBe('Refreshing 1 pull request…\nFound 2 new misses.\n')
      expect(JSON.parse(h.stdout()).misses).toEqual([
        expect.objectContaining({
          origin: 'phada',
          seen: 'missed-live',
          file: 'README.md',
          line: 58,
          author: 'phada',
          threadUrl: null,
          reviewedSha: HEAD,
          commitSha: HEAD,
          body: `${timeout.title}\n\n${timeout.why}`,
        }),
        expect.objectContaining({
          origin: 'bot',
          seen: 'not-reviewed',
          file: 'src/ensure-card.ts',
          line: 93,
          commitSha: REPLAYED,
        }),
      ])

      await runMisses({ ...COMMAND, target: command.target }, h.deps)

      expect(h.stdout()).toContain(
        [
          `   2  acme/pay#480  README.md:58  phada  phada · missed-live  open`,
          `      ${timeout.title}`,
          '',
          '   1  acme/pay#480  src/ensure-card.ts:93  review-bot[bot] (external)  bot · not-reviewed  open',
        ].join('\n'),
      )
    })

    it('keeps only the miss of the bot when the head is not a later commit of the replay', async () => {
      const h = scenario(async ({ base, head }) => {
        throw new ComparisonDivergedError(base, head)
      })
      await h.seed(seeding)

      await runMisses({ ...command, format: 'json' }, h.deps)

      expect(h.stderr()).toBe('Refreshing 1 pull request…\nFound 1 new miss.\n')
      expect(JSON.parse(h.stdout()).misses).toEqual([expect.objectContaining({ origin: 'bot' })])
    })

    it('keeps only the miss of the bot when the comparison stops at the 300 files GitHub lists', async () => {
      const h = scenario(async () =>
        Array.from({ length: COMPARE_MAX_FILES }, (_, index) => ({
          path: `src/file-${index}.ts`,
          status: 'modified',
          patch: '@@ -1 +1 @@',
        })),
      )
      await h.seed(seeding)

      await runMisses({ ...command, format: 'json' }, h.deps)

      expect(JSON.parse(h.stdout()).misses).toEqual([expect.objectContaining({ origin: 'bot' })])
    })
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

  it('--refresh with --since harvests the pull requests closed since the date and the due ones of that repository, only from GitHub', async () => {
    const listed: string[] = []
    const h = harness({
      listClosedPullRequests: async ({ owner, repo, token, since }) => {
        listed.push(`${owner}/${repo} ${token} ${since}`)
        return [
          { number: 8, closedAt: '2026-10-21T00:00:00Z' },
          { number: 3, closedAt: '2026-10-20T00:00:00Z' },
        ]
      },
      state: (request) =>
        reviewState({
          viewer: 'octocat',
          author: 'bob',
          threads:
            request.number === 8
              ? [
                  reviewThread({
                    id: 'T8',
                    path: 'src/cart.ts',
                    line: null,
                    originalLine: 8,
                    originalCommit: 'c'.repeat(40),
                    isOutdated: true,
                    url: 'https://github.com/acme/shop/pull/8#discussion_r8',
                    author: 'carol',
                    association: 'OWNER',
                    bot: false,
                    body: 'The total skips the discount.',
                    createdAt: '2026-10-20T11:00:00Z',
                  }),
                ]
              : [],
        }),
    })
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
      store.addRun({ ...run, number: 5 })
      store.addRun({ ...run, repo: 'acme/web' })
    })

    await runMisses(
      {
        ...COMMAND,
        refresh: true,
        since: '2026-10-01T00:00:00.000Z',
        target: { kind: 'repo', repo: { owner: 'acme', repo: 'shop' } },
      },
      h.deps,
    )

    expect(listed).toEqual(['acme/shop ghp_test 2026-10-01T00:00:00.000Z'])
    expect(h.fetched.map(({ repo, number }) => `${repo}#${number}`).sort()).toEqual([
      'shop#3',
      'shop#5',
      'shop#8',
    ])
    expect(h.stderr()).toBe('Refreshing 3 pull requests…\nFound 1 new miss.\n')
    expect(h.stdout()).toContain(
      'acme/shop#8  src/cart.ts:8  carol (owner)  person · not-reviewed  open',
    )
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
