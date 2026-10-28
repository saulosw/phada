import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { ReviewProgress } from '../app/review-progress.js'
import type { WatchEvent } from '../app/watch-event.js'
import type { PullRequest } from '../github/pull-request.js'
import { MirrorLockTimeoutError } from '../repository/mirror-lock.js'
import { openHistoryStore } from '../store/history-store.js'
import type { JobRecord } from '../watch/types.js'
import { UsageError, WatchRunningError } from './errors.js'
import { startWatch } from './watch-session.js'
import type { WatchHandle, WatchSessionDeps } from './watch-session.js'

const CONFIG = 'verify: false\nci:\n  wait: 0s\nwatch:\n  repos: [acme/shop]\n'
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const OPEN_PULL = {
  number: 12,
  headSha: HEAD_SHA,
  draft: false,
  author: 'octocat',
  authorIsBot: false,
  association: 'OWNER',
  labels: [],
  baseRef: 'main',
  private: false,
}

const historyDir = mkdtempSync(join(tmpdir(), 'phada-watch-session-'))
afterAll(() => rmSync(historyDir, { recursive: true, force: true }))
let historyCount = 0

const notUsed = () => Promise.reject(new Error('not used by the watch in this test'))

interface Session {
  deps: WatchSessionDeps
  historyFile: string
  kills: () => number
  events: WatchEvent[]
  warnings: string[]
  progress: { job: number; event: ReviewProgress['kind'] }[]
  listeners: Parameters<typeof startWatch>[2]
}

function session(
  overrides: {
    config?: string
    pulls?: (typeof OPEN_PULL)[]
    fetchPullRequest?: () => Promise<PullRequest>
    withLock?: WatchSessionDeps['withLock']
    lockHolder?: number
  } = {},
): Session {
  historyCount += 1
  const historyFile = join(historyDir, `history-${historyCount}.sqlite`)
  let clock = Date.parse('2026-10-18T12:00:00.000Z')
  let kills = 0
  const events: WatchEvent[] = []
  const warnings: string[] = []
  const progress: Session['progress'] = []
  const deps: WatchSessionDeps = {
    env: { GITHUB_TOKEN: 'test-token', PHADA_CONFIG_HOME: '/cfg' },
    ghToken: async () => undefined,
    version: '1.2.3',
    home: '/home/u',
    files: memoryFiles({ '/cfg/config.yml': overrides.config ?? CONFIG }),
    fetchRepositoryTree: notUsed,
    fetchRepositoryFile: async () => null,
    fetchRepository: async () => ({
      repo: 'acme/shop',
      private: false,
      defaultBranch: 'main',
      empty: false,
    }),
    openMirror: notUsed,
    openIndexStore: notUsed,
    openObservedStore: notUsed,
    createExtractor: () => {
      throw new Error('not used by the watch in this test')
    },
    createProvider: () => {
      throw new Error('not used by the watch in this test')
    },
    runsSkills: () => false,
    checkMcpNames: async () => undefined,
    fetchCheckRuns: notUsed,
    fetchCommitStatuses: notUsed,
    fetchCheckAnnotations: notUsed,
    fetchJobLog: notUsed,
    fetchPullRequest: overrides.fetchPullRequest ?? (async () => pullRequestFixture()),
    fetchReviewState: notUsed,
    fetchPullComments: notUsed,
    createReview: notUsed,
    fetchComparison: notUsed,
    replyAndResolve: notUsed,
    openHistoryStore: () => openHistoryStore(historyFile),
    listOpenPullRequests: async () => ({ status: 'ok', pulls: overrides.pulls ?? [] }),
    fetchPullRequestMetadata: async () => pullRequestFixture(),
    listIssueComments: async () => ({ status: 'ok', comments: [] }),
    addCommentReaction: notUsed,
    fetchPullRequestHead: notUsed,
    fetchBranchHead: async () => ({ status: 'not-modified' }),
    withLock: overrides.withLock ?? ((_path, work) => work()),
    lockHolder: async () => overrides.lockHolder,
    killDetachedChildren: () => {
      kills += 1
    },
    sleep: async (ms) => {
      clock += ms
    },
    clock: () => new Date(clock),
  }
  return {
    deps,
    historyFile,
    kills: () => kills,
    events,
    warnings,
    progress,
    listeners: {
      event: (event) => events.push(event),
      warning: (message) => warnings.push(message),
      progress: (job) => {
        const record = (event: ReviewProgress) => progress.push({ job: job.id, event: event.kind })
        return { review: record, reviewAndPublish: record }
      },
    },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function storedJobs(file: string): Promise<JobRecord[]> {
  const history = await openHistoryStore(file)
  try {
    return history.jobs({})
  } finally {
    history.close()
  }
}

describe('startWatch', () => {
  it('reports the watch events as data and ends after one pass with once', async () => {
    const s = session({ pulls: [OPEN_PULL] })

    const handle = await startWatch({ once: true, backfill: false }, s.deps, s.listeners)

    expect(await handle.done).toEqual({ reason: 'once' })
    expect(s.events).toEqual([{ kind: 'baseline', repo: 'acme/shop', count: 1 }])
  })

  it('finishes the running review on stop, then ends', async () => {
    const opened = deferred<WatchHandle>()
    const s = session({
      pulls: [OPEN_PULL],
      fetchPullRequest: async () => {
        const handle = await opened.promise
        expect(handle.running()?.number).toBe(12)
        handle.stop()
        return pullRequestFixture({ state: 'closed' })
      },
    })

    const handle = await startWatch({ once: false, backfill: true }, s.deps, s.listeners)
    opened.resolve(handle)

    expect(await handle.done).toEqual({ reason: 'stopped' })
    expect(handle.stopRequested()).toBe(true)
    expect(s.events.map(({ kind }) => kind)).toEqual(['queued', 'started', 'finished'])
    expect(s.progress).toEqual([{ job: 1, event: 'fetched' }])
    expect(s.kills()).toBe(0)
  })

  it('kills the AI CLI and puts the running job back in the queue on abort', async () => {
    const opened = deferred<WatchHandle>()
    const s = session({
      pulls: [OPEN_PULL],
      fetchPullRequest: async () => {
        ;(await opened.promise).abort()
        return new Promise<PullRequest>(() => undefined)
      },
    })

    const handle = await startWatch({ once: false, backfill: true }, s.deps, s.listeners)
    opened.resolve(handle)

    expect(await handle.done).toEqual({ reason: 'aborted' })
    expect(s.kills()).toBe(1)
    expect((await storedJobs(s.historyFile)).map(({ status }) => status)).toEqual(['queued'])
  })

  it('says which process holds the lock of another watch', async () => {
    const s = session({
      lockHolder: 123,
      withLock: () => Promise.reject(new MirrorLockTimeoutError('/data/watch.lock')),
    })

    const started = startWatch({ once: false, backfill: false }, s.deps, s.listeners)

    await expect(started).rejects.toThrow(WatchRunningError)
    await expect(started).rejects.toThrow('Another phada watch is running (PID 123).')
  })

  it('refuses to start without repositories to watch', async () => {
    const s = session({ config: 'verify: false\n' })

    await expect(startWatch({ once: false, backfill: false }, s.deps, s.listeners)).rejects.toThrow(
      UsageError,
    )
  })
})
