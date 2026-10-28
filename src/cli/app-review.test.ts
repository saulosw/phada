import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { reviewState } from '../../test/support/review-state.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import type { ReviewProgress } from '../app/review-progress.js'
import type { CreateReviewOptions } from '../github/create-review.js'
import type { OpenPull } from '../github/list-pull-requests.js'
import { CommandError } from '../process/errors.js'
import { childScope, runCommand } from '../process/run-command.js'
import { createExtractor } from '../repo-map/extract.js'
import { openHistoryStore } from '../store/history-store.js'
import { openIndexStore } from '../store/index-store.js'
import { openObservedStore } from '../store/observed-store.js'
import type { ProviderOptions } from './provider-choice.js'
import { appReview } from './app-review.js'
import type { AppReviewDeps } from './app-review.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-app-review-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN = `ghp_${'Z9y8X7w6V5'.repeat(4)}`
const TARGET = { owner: 'acme', repo: 'shop', number: 12 }
let runs = 0
const LONG_CHILD: [string, string[]] = [process.execPath, ['-e', 'setTimeout(() => {}, 30_000)']]

function harness(changes: Partial<AppReviewDeps> = {}) {
  runs += 1
  const data = join(dir, `data-${runs}`)
  const posts: CreateReviewOptions[] = []
  const providers: ProviderOptions[] = []
  const written: string[] = []
  const output = { write: (text: string) => written.push(text) !== 0, isTTY: true }
  const deps: AppReviewDeps & { stdout: typeof output; stderr: typeof output } = {
    env: { GITHUB_TOKEN: TOKEN, PHADA_CACHE_HOME: join(dir, 'cache'), PHADA_DATA_HOME: data },
    ghToken: async () => undefined,
    version: '1.2.3',
    home: '/home/u',
    files: memoryFiles(),
    stdout: output,
    stderr: output,
    fetchRepositoryTree: async () => ({ entries: [], truncated: false }),
    fetchRepositoryFile: async () => null,
    fetchCheckRuns: async () => [],
    fetchCommitStatuses: async () => [],
    fetchCheckAnnotations: async () => [],
    fetchJobLog: () => Promise.reject(new Error('no job log in this test')),
    fetchRepository: () => Promise.reject(new Error('no related repositories in this test')),
    openMirror: async () => memoryMirror({ 'src/shop.ts': 'export function spend() {}\n' }),
    openIndexStore: () => openIndexStore(join(dir, `index-${runs}.sqlite`)),
    openObservedStore: () => openObservedStore(join(dir, `observed-${runs}.sqlite`)),
    createExtractor,
    createProvider: (_name, options) => {
      providers.push(options)
      const answers = [reviewReportJson(), verificationJson([verdictFixture()])]
      return {
        id: 'fake-cli',
        review: async () => ({ text: answers.shift() ?? '', durationMs: 1 }),
      }
    },
    runsSkills: () => false,
    checkMcpNames: async () => undefined,
    fetchPullRequest: async () => pullRequestFixture(),
    fetchReviewState: async () => reviewState(),
    fetchPullComments: async () => [],
    createReview: async (options) => {
      posts.push(options)
      return { url: 'https://github.com/acme/shop/pull/12#pullrequestreview-9' }
    },
    fetchComparison: async () => [],
    replyAndResolve: async () => undefined,
    openHistoryStore: (path) => openHistoryStore(path),
    sleep: async () => undefined,
    clock: () => new Date('2026-10-28T12:00:00.000Z'),
    listOpenPullRequests: async () => ({ status: 'ok', pulls: [] }),
    fetchPullRequestMetadata: async () => pullRequestFixture(),
    lockHolder: async () => undefined,
    ...changes,
  }
  return { deps, posts, providers, written, data }
}

function openPull(number: number, changes: Partial<OpenPull> = {}): OpenPull {
  return {
    number,
    headSha: 'a'.repeat(40),
    title: `Pull ${number}`,
    draft: false,
    author: 'ana',
    authorIsBot: false,
    association: 'MEMBER',
    labels: [],
    baseRef: 'main',
    private: false,
    ...changes,
  }
}

describe('a review the app asks for', () => {
  it('only looks: reports its progress, posts nothing, saves the run and gives its detail', async () => {
    const { deps, posts, providers, written, data } = harness()
    const events: ReviewProgress[] = []

    const review = await appReview(deps).reviewPullRequest(TARGET, 'look', (event) =>
      events.push(event),
    )

    expect(events.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['fetched', 'contextLoaded', 'aiStarted', 'aiFinished']),
    )
    expect(posts).toEqual([])
    expect(providers).toEqual([expect.objectContaining({ detached: true })])
    expect(written).toEqual([])
    if (review.status !== 'reviewed') throw new Error('expected a review')
    expect(review.detail).toMatchObject({
      run: { repo: 'acme/shop', number: 12, source: 'manual', status: 'dry-run' },
      pullRequest: { title: 'Let users spend crystals' },
      findings: [{ title: 'spend has no auth', file: 'src/shop.ts', line: 1 }],
      publication: { status: 'dry-run', comments: 1 },
    })
    expect(review.history).toMatchObject({ status: 'saved' })
    const history = await openHistoryStore(join(data, 'history.sqlite'))
    expect(history.runs({ limit: 5 }).runs.map(({ status }) => status)).toEqual(['dry-run'])
    history.close()
  })

  it('reviews and publishes as phada review does', async () => {
    const { deps, posts, written } = harness()

    const review = await appReview(deps).reviewPullRequest(TARGET, 'publish', () => undefined)

    expect(posts).toEqual([
      expect.objectContaining({ owner: 'acme', repo: 'shop', number: 12, token: TOKEN }),
    ])
    expect(review).toMatchObject({
      status: 'reviewed',
      detail: {
        run: { status: 'published' },
        publication: {
          status: 'published',
          url: 'https://github.com/acme/shop/pull/12#pullrequestreview-9',
        },
      },
    })
    expect(written).toEqual([])
  })

  it('publishes nothing while a watch holds the lock, saying which, and still only looks', async () => {
    const locks: string[] = []
    const { deps, posts, providers, data } = harness({
      lockHolder: async (path) => {
        locks.push(path)
        return 4242
      },
    })
    const review = appReview(deps)

    expect(await review.reviewPullRequest(TARGET, 'publish', () => undefined)).toEqual({
      status: 'watch-running',
      pid: 4242,
    })
    expect(posts).toEqual([])
    expect(providers).toEqual([])
    expect(locks).toEqual([join(data, 'watch.lock')])
    expect(await review.reviewPullRequest(TARGET, 'look', () => undefined)).toMatchObject({
      status: 'reviewed',
    })
  })

  it('says when there is no GitHub token, without reviewing', async () => {
    const { deps, posts, providers } = harness({ env: {}, ghToken: async () => undefined })

    const review = await appReview(deps).reviewPullRequest(TARGET, 'publish', () => undefined)

    expect(review).toEqual({ status: 'no-token' })
    expect(posts).toEqual([])
    expect(providers).toEqual([])
  })

  it('leaves the history alone when the user config turns it off', async () => {
    const { deps, data } = harness()
    deps.files = memoryFiles({ '/home/u/.config/phada/config.yml': 'history: false\n' })

    const review = await appReview(deps).reviewPullRequest(TARGET, 'look', () => undefined)

    expect(review).toMatchObject({ status: 'reviewed', history: { status: 'off' } })
    expect(existsSync(join(data, 'history.sqlite'))).toBe(false)
  })

  it('fails as phada review fails, with nothing written to the terminal', async () => {
    const { deps, written } = harness({
      fetchPullRequest: () => Promise.reject(new Error('Pull request acme/shop#12 not found.')),
    })

    await expect(
      appReview(deps).reviewPullRequest(TARGET, 'look', () => undefined),
    ).rejects.toThrow('not found')
    expect(written).toEqual([])
  })
})

describe('a review the app cancels', () => {
  function cancelling(mode: 'look' | 'publish') {
    const controller = new AbortController()
    let aiCli: Promise<unknown> = Promise.resolve()
    const setup = harness({
      createProvider: () => ({
        id: 'fake-cli',
        review: async () => {
          aiCli = runCommand(...LONG_CHILD, { detached: true }).catch((error: unknown) => error)
          setTimeout(() => controller.abort(), 200)
          await aiCli
          throw new Error('Claude Code ended without an exit code (SIGTERM).')
        },
      }),
    })
    const review = appReview(setup.deps).reviewPullRequest(
      TARGET,
      mode,
      () => undefined,
      controller.signal,
    )
    return { ...setup, review, aiCli: () => aiCli }
  }

  it('kills the AI CLI it started, posts nothing and saves no run', async () => {
    const { review, aiCli, posts, written, data } = cancelling('publish')

    expect(await review).toEqual({ status: 'cancelled' })
    expect(await aiCli()).toBeInstanceOf(CommandError)
    expect(posts).toEqual([])
    expect(written).toEqual([])
    expect(existsSync(join(data, 'history.sqlite'))).toBe(false)
  })

  it('leaves alone the children another run of the same process started', async () => {
    const watch = childScope()
    const watchJob = watch.run(() =>
      runCommand(...LONG_CHILD, { detached: true }).then(
        () => 'ended',
        () => 'killed',
      ),
    )
    const { review } = cancelling('look')

    expect(await review).toEqual({ status: 'cancelled' })
    const settled = await Promise.race([
      watchJob,
      new Promise((done) => setTimeout(() => done('running'), 300)),
    ])
    watch.kill()
    expect(settled).toBe('running')
    expect(await watchJob).toBe('killed')
  })

  it('kills nothing once the review ended', async () => {
    const controller = new AbortController()
    let kills = 0
    const { deps } = harness({
      childScope: () => ({ run: (work) => work(), kill: () => (kills += 1) }),
    })

    const review = await appReview(deps).reviewPullRequest(
      TARGET,
      'look',
      () => undefined,
      controller.signal,
    )
    controller.abort()

    expect(review.status).toBe('reviewed')
    expect(kills).toBe(0)
  })
})

describe('a review the app puts in the queue', () => {
  const WATCHED = { '/home/u/.config/phada/config.yml': 'watch:\n  repos: [acme/shop]\n' }

  it('queues a job the watch publishes, and joins it when asked again', async () => {
    const { deps, data, posts, providers } = harness({ files: memoryFiles(WATCHED) })
    const { enqueueReview } = appReview(deps)

    const first = await enqueueReview(TARGET)
    const second = await enqueueReview(TARGET)

    expect(first).toMatchObject({
      status: 'submitted',
      result: {
        status: 'queued',
        job: { repo: 'acme/shop', number: 12, headSha: pullRequestFixture().headSha },
      },
    })
    if (first.status !== 'submitted' || first.result.status === 'refused') {
      throw new Error('expected a queued job')
    }
    expect(second).toMatchObject({
      status: 'submitted',
      result: { status: 'joined', job: { id: first.result.job.id } },
    })
    const history = await openHistoryStore(join(data, 'history.sqlite'))
    expect(history.requests([first.result.job.id])).toEqual([
      expect.objectContaining({ source: 'enqueue', publish: 'pr' }),
      expect.objectContaining({ source: 'enqueue', publish: 'pr' }),
    ])
    history.close()
    expect([posts, providers]).toEqual([[], []])
  })

  it('gives the reason the queue refused it', async () => {
    const { deps } = harness({
      files: memoryFiles({
        '/home/u/.config/phada/config.yml': 'watch:\n  repos: [acme/web]\n',
      }),
    })

    expect(await appReview(deps).enqueueReview(TARGET)).toEqual({
      status: 'submitted',
      result: { status: 'refused', reason: 'not-watched' },
    })
  })

  it('says when there is no GitHub token', async () => {
    const { deps } = harness({ env: {}, files: memoryFiles(WATCHED) })

    expect(await appReview(deps).enqueueReview(TARGET)).toEqual({ status: 'no-token' })
  })

  it('fails as phada enqueue does without watch: in the user config', async () => {
    const { deps, data } = harness()

    await expect(appReview(deps).enqueueReview(TARGET)).rejects.toThrow(
      'Nothing to watch: list the repositories under watch: in your own config',
    )
    expect(existsSync(join(data, 'history.sqlite'))).toBe(false)
  })
})

describe('the open pull requests of a repository', () => {
  it('lists their number, title, author and draft', async () => {
    const { deps } = harness({
      listOpenPullRequests: async (options) => {
        expect(options).toMatchObject({ owner: 'acme', repo: 'shop', token: TOKEN })
        return {
          status: 'ok',
          pulls: [openPull(12), openPull(7, { title: undefined, draft: true, author: 'bo' })],
        }
      },
    })

    expect(await appReview(deps).readOpenPullRequests('acme/shop')).toEqual({
      status: 'read',
      repo: 'acme/shop',
      pulls: [
        { number: 12, title: 'Pull 12', author: 'ana', draft: false },
        { number: 7, title: null, author: 'bo', draft: true },
      ],
    })
  })

  it('says when there is no GitHub token', async () => {
    const { deps } = harness({ env: {} })

    expect(await appReview(deps).readOpenPullRequests('acme/shop')).toEqual({ status: 'no-token' })
  })
})

describe('a typed pull request', () => {
  it('reads owner/repo#N and a pull request URL, and nothing else', () => {
    const { parsePullRequest } = appReview(harness().deps)

    expect(parsePullRequest(' acme/shop#12 ')).toEqual(TARGET)
    expect(parsePullRequest('https://github.com/acme/shop/pull/12/files')).toEqual(TARGET)
    expect(parsePullRequest('acme/shop')).toBeUndefined()
    expect(parsePullRequest('')).toBeUndefined()
  })
})
