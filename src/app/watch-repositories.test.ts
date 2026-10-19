import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { WatchSettings } from '../config/watch-settings.js'
import type { OpenPull, PullListing } from '../github/list-pull-requests.js'
import type { BranchHead } from '../github/repository.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import type { FailureKind, JobRecord } from '../watch/types.js'
import type { ReviewRun } from './review-and-publish.js'
import { watchRepositories } from './watch-repositories.js'
import type { WatchDeps } from './watch-repositories.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-watch-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0

const START = Date.parse('2026-10-18T12:00:00.000Z')
const MIN = 60_000
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const SETTINGS: WatchSettings = {
  intervalMs: 5 * MIN,
  settleMs: 3 * MIN,
  maxReviewsPerHour: 6,
  repos: [{ repo: 'acme/shop', publish: true, allowExternal: false }],
}

const pull = (number: number, headSha = A, overrides: Partial<OpenPull> = {}): OpenPull => ({
  number,
  headSha,
  draft: false,
  author: 'alice',
  authorIsBot: false,
  association: 'MEMBER',
  labels: [],
  baseRef: 'main',
  private: false,
  ...overrides,
})

function published(job: JobRecord): ReviewRun {
  const pullRequest = pullRequestFixture({ number: job.number, headSha: job.headSha })
  return {
    status: 'reviewed',
    pullRequest,
    reviewed: {} as never,
    plan: { comments: [], stillOpen: [], dismissed: [], openThreads: 0 },
    rendered: { body: 'body', comments: [] },
    publication: { status: 'published', url: `https://x/${job.number}` },
  }
}

interface Script {
  listings?: (cycle: number, now: number) => PullListing
  runJob?: (job: JobRecord, now: number) => Promise<ReviewRun>
  classify?: (error: unknown) => { kind: FailureKind; resetAt?: string }
  branchHead?: (now: number) => BranchHead
  refreshIndex?: () => Promise<'complete' | 'partial'>
  stopWhen?: (state: { now: number; ran: JobRecord[]; sleeps: number }) => boolean
  settings?: WatchSettings
}

async function setup(script: Script, history?: HistoryStore) {
  const store = history ?? (await openHistoryStore(join(dir, `w${++files}.sqlite`)))
  let now = START
  let cycle = 0
  let sleeps = 0
  const ran: JobRecord[] = []
  const events: string[] = []
  const recorded: string[] = []
  const indexed: number[] = []
  const deps: WatchDeps = {
    history: store,
    listPulls: async () => {
      cycle += 1
      return script.listings?.(cycle, now) ?? { status: 'ok', pulls: [] }
    },
    defaultBranch: async () => 'main',
    branchHead: async () => script.branchHead?.(now) ?? { status: 'not-modified' },
    runJob: async (job) => {
      ran.push(job)
      return script.runJob?.(job, now) ?? published(job)
    },
    recordRun: (job, outcome) => {
      recorded.push(`${job.number}:${'run' in outcome ? outcome.run.status : outcome.kind}`)
    },
    refreshIndex: async (_repo, budgetMs) => {
      indexed.push(budgetMs)
      return script.refreshIndex?.() ?? 'complete'
    },
    classify: script.classify ?? (() => ({ kind: 'transient' })),
    now: () => new Date(now),
    sleep: async (ms) => {
      sleeps += 1
      now += ms
    },
    stopRequested: () =>
      sleeps > 200 || (script.stopWhen?.({ now: now - START, ran, sleeps }) ?? false),
    events: {
      cycle: () => undefined,
      baseline: (repo, count) => events.push(`baseline ${repo} ${count}`),
      queued: (job) => events.push(`queued #${job.number} ${job.headSha.slice(0, 1)}`),
      superseded: (job) => events.push(`superseded #${job.number}`),
      started: (job) => events.push(`started #${job.number} @${(now - START) / MIN}`),
      finished: (job) => events.push(`finished #${job.number}`),
      retry: (job, at) => events.push(`retry #${job.number} @${(Date.parse(at) - START) / MIN}`),
      paused: (pause) => events.push(`paused until ${(Date.parse(pause.until) - START) / MIN}`),
      failed: (job) => events.push(`failed #${job.number}`),
      indexed: (repo) => events.push(`indexed ${repo}`),
      indexPartial: (repo) => events.push(`partial ${repo}`),
      warning: (message) => events.push(`warning ${message}`),
      limited: (count, until) =>
        events.push(`limited ${count} until ${(Date.parse(until) - START) / MIN}`),
    },
  }
  return { deps, store, ran, events, recorded, indexed, now: () => now - START }
}

const input = (overrides: Partial<Parameters<typeof watchRepositories>[0]> = {}) => ({
  settings: SETTINGS,
  backfill: false,
  once: false,
  ...overrides,
})

describe('watchRepositories', () => {
  it('records the pull requests open at start without reviewing them', async () => {
    const h = await setup({ listings: () => ({ status: 'ok', pulls: [pull(1), pull(2)] }) })

    expect(await watchRepositories(input({ once: true }), h.deps)).toEqual({ reason: 'once' })
    expect(h.events).toEqual(['baseline acme/shop 2'])
    expect(h.ran).toEqual([])
  })

  it('reviews the open pull requests at start with backfill', async () => {
    const h = await setup({ listings: () => ({ status: 'ok', pulls: [pull(1)] }) })

    await watchRepositories(input({ once: true, backfill: true }), h.deps)

    expect(h.ran.map((job) => job.number)).toEqual([1])
  })

  it('reviews a new pull request once the settle time is over', async () => {
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      stopWhen: ({ ran }) => ran.length === 1,
    })

    expect(await watchRepositories(input(), h.deps)).toEqual({ reason: 'stopped' })

    expect(h.events).toEqual([
      'baseline acme/shop 0',
      'queued #3 a',
      'started #3 @8',
      'finished #3',
    ])
    expect(h.recorded).toEqual(['3:reviewed'])
    expect(h.store.jobs({ status: ['done'] })).toHaveLength(1)
  })

  it('reviews only the newest commit when a push lands before the settle time', async () => {
    const h = await setup({
      listings: (cycle) => ({
        status: 'ok',
        pulls: cycle === 1 ? [] : [pull(3, cycle === 2 ? A : B)],
      }),
      settings: { ...SETTINGS, intervalMs: MIN, settleMs: 3 * MIN },
      stopWhen: ({ ran }) => ran.length === 1,
    })

    await watchRepositories(input({ settings: { ...SETTINGS, intervalMs: MIN } }), h.deps)

    expect(h.events.slice(0, 4)).toEqual([
      'baseline acme/shop 0',
      'queued #3 a',
      'superseded #3',
      'queued #3 b',
    ])
    expect(h.ran.map((job) => job.headSha)).toEqual([B])
  })

  it('keeps a review that went stale and queues the new commit', async () => {
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      runJob: async (job) => ({
        ...published(job),
        publication: { status: 'superseded', headSha: B },
      }),
      stopWhen: ({ ran }) => ran.length === 1,
    })

    await watchRepositories(input(), h.deps)

    expect(h.store.jobs({ status: ['superseded'] })).toHaveLength(1)
    expect(h.store.pulls('acme/shop')).toEqual([expect.objectContaining({ number: 3, headSha: B })])
    expect(h.recorded).toEqual(['3:reviewed'])
  })

  it('retries a transient failure after 1 and 5 minutes, then fails the job', async () => {
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      runJob: async () => {
        throw new Error('network down')
      },
      stopWhen: ({ now }) => now > 60 * MIN,
    })

    await watchRepositories(input(), h.deps)

    expect(h.events.filter((event) => !event.startsWith('baseline'))).toEqual([
      'queued #3 a',
      'started #3 @8',
      'retry #3 @9',
      'started #3 @9',
      'retry #3 @14',
      'started #3 @14',
      'failed #3',
    ])
    expect(h.store.jobs({ status: ['failed'] })).toEqual([
      expect.objectContaining({ attempts: 3, errorKind: 'transient', error: 'network down' }),
    ])
    expect(h.recorded).toEqual(['3:transient', '3:transient', '3:transient'])
  })

  it('pauses the queue on a usage limit and goes on after it', async () => {
    let calls = 0
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      runJob: async (job) => {
        calls += 1
        if (calls === 1) throw new Error('limit')
        return published(job)
      },
      classify: () => ({ kind: 'usage-limit' }),
      stopWhen: ({ ran }) => ran.length === 2,
    })

    await watchRepositories(input(), h.deps)

    expect(h.events).toContain('paused until 23')
    expect(h.events.filter((event) => event.startsWith('started'))).toEqual([
      'started #3 @8',
      'started #3 @23',
    ])
    expect(h.store.pause()).toBeUndefined()
  })

  it('stops on a fatal failure and keeps the job queued', async () => {
    const error = new Error('not logged in')
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      runJob: async () => {
        throw error
      },
      classify: () => ({ kind: 'fatal' }),
    })

    expect(await watchRepositories(input(), h.deps)).toEqual({ reason: 'fatal', error })
    expect(h.store.jobs({ status: ['queued'] })).toEqual([
      expect.objectContaining({ attempts: 0, errorKind: 'fatal' }),
    ])
  })

  it('waits for the hourly limit before the next review', async () => {
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3), pull(4)] }),
      settings: { ...SETTINGS, maxReviewsPerHour: 1 },
      stopWhen: ({ ran }) => ran.length === 2,
    })
    h.deps.recordRun = (job) => {
      h.store.addRun({
        source: 'watch',
        repo: job.repo,
        number: job.number,
        headSha: job.headSha,
        startedAt: new Date(START + h.now()).toISOString(),
        finishedAt: new Date(START + h.now()).toISOString(),
        status: 'published',
        aiCalled: true,
      })
    }

    await watchRepositories(input({ settings: { ...SETTINGS, maxReviewsPerHour: 1 } }), h.deps)

    expect(h.events.filter((event) => event.startsWith('started'))).toEqual([
      'started #3 @8',
      'started #4 @68',
    ])
    expect(h.events.filter((event) => event.startsWith('limited'))).toEqual(['limited 1 until 68'])
  })

  it('puts a job interrupted by a crash back in the queue', async () => {
    const store = await openHistoryStore(join(dir, `w${++files}.sqlite`))
    store.saveRepo({ repo: 'acme/shop', baselineAt: new Date(START).toISOString() })
    store.addJob({
      repo: 'acme/shop',
      number: 9,
      headSha: A,
      status: 'running',
      attempts: 0,
      notBefore: new Date(START - MIN).toISOString(),
      createdAt: new Date(START - MIN).toISOString(),
    })
    const h = await setup({ listings: () => ({ status: 'ok', pulls: [pull(9)] }) }, store)

    await watchRepositories(input({ once: true }), h.deps)

    expect(h.ran).toEqual([expect.objectContaining({ number: 9, attempts: 1 })])
  })

  it('leaves with --once without waiting for a job that is not ready', async () => {
    const store = await openHistoryStore(join(dir, `w${++files}.sqlite`))
    store.saveRepo({ repo: 'acme/shop', baselineAt: new Date(START).toISOString() })
    const h = await setup({ listings: () => ({ status: 'ok', pulls: [pull(3)] }) }, store)

    expect(await watchRepositories(input({ once: true }), h.deps)).toEqual({ reason: 'once' })
    expect(h.ran).toEqual([])
    expect(h.store.jobs({ status: ['queued'] })).toHaveLength(1)
  })

  it('stops while sleeping when asked to', async () => {
    const h = await setup({ stopWhen: ({ sleeps }) => sleeps === 1 })

    expect(await watchRepositories(input(), h.deps)).toEqual({ reason: 'stopped' })
    expect(h.ran).toEqual([])
  })

  it('refreshes the default branch index only when the branch moved', async () => {
    let heads = 0
    const h = await setup({
      branchHead: () => {
        heads += 1
        return heads === 1 ? { status: 'ok', sha: A, etag: '"1"' } : { status: 'not-modified' }
      },
      stopWhen: ({ now }) => now > 11 * MIN,
    })

    await watchRepositories(input(), h.deps)

    expect(h.indexed).toEqual([60_000])
    expect(h.events).toContain('indexed acme/shop')
    expect(h.store.repo('acme/shop')).toMatchObject({ indexedSha: A, branchEtag: '"1"' })
    expect(heads).toBe(3)
  })

  it('continues a partial index on the next idle cycle', async () => {
    let refreshes = 0
    const h = await setup({
      branchHead: () => ({ status: 'ok', sha: A, etag: '"1"' }),
      refreshIndex: async () => {
        refreshes += 1
        return refreshes === 1 ? 'partial' : 'complete'
      },
      stopWhen: ({ now }) => now > 6 * MIN,
    })

    await watchRepositories(input(), h.deps)

    expect(h.events.filter((event) => /indexed|partial/.test(event))).toEqual([
      'partial acme/shop',
      'indexed acme/shop',
    ])
    expect(h.store.repo('acme/shop')?.indexedSha).toBe(A)
  })

  it('warns about a repository it cannot list and goes on', async () => {
    const h = await setup({
      settings: {
        ...SETTINGS,
        repos: [...SETTINGS.repos, { repo: 'acme/web', publish: true, allowExternal: false }],
      },
    })
    let listed = 0
    h.deps.listPulls = async (repo) => {
      listed += 1
      if (repo === 'acme/shop') throw new Error('Cannot read acme/shop with this token (HTTP 404)')
      return { status: 'ok', pulls: [] }
    }
    h.deps.classify = () => ({ kind: 'definitive' })

    await watchRepositories(
      input({
        once: true,
        settings: {
          ...SETTINGS,
          repos: [...SETTINGS.repos, { repo: 'acme/web', publish: true, allowExternal: false }],
        },
      }),
      h.deps,
    )

    expect(listed).toBe(2)
    expect(h.events).toEqual([
      'warning acme/shop: Cannot read acme/shop with this token (HTTP 404)',
      'baseline acme/web 0',
    ])
  })

  it('stops between repositories when asked during discovery', async () => {
    let stop = false
    const h = await setup({
      settings: {
        ...SETTINGS,
        repos: [...SETTINGS.repos, { repo: 'acme/web', publish: true, allowExternal: false }],
      },
      stopWhen: () => stop,
    })
    const listed: string[] = []
    h.deps.listPulls = async (repo) => {
      listed.push(repo)
      stop = true
      return { status: 'ok', pulls: [] }
    }

    await watchRepositories(
      input({
        settings: {
          ...SETTINGS,
          repos: [...SETTINGS.repos, { repo: 'acme/web', publish: true, allowExternal: false }],
        },
      }),
      h.deps,
    )

    expect(listed).toEqual(['acme/shop'])
  })

  it('looks for changes on every --once run, even before the interval', async () => {
    const store = await openHistoryStore(join(dir, `w${++files}.sqlite`))
    const recent = new Date(START - MIN).toISOString()
    store.saveRepo({ repo: 'acme/shop', baselineAt: recent, checkedAt: recent })
    const h = await setup({ listings: () => ({ status: 'ok', pulls: [pull(3)] }) }, store)

    await watchRepositories(input({ once: true }), h.deps)

    expect(h.events).toEqual(['queued #3 a'])
  })

  it('says --backfill does nothing for a repository already recorded', async () => {
    const store = await openHistoryStore(join(dir, `w${++files}.sqlite`))
    store.saveRepo({ repo: 'acme/shop', baselineAt: '2026-10-17T09:00:00.000Z' })
    const h = await setup({ listings: () => ({ status: 'ok', pulls: [] }) }, store)

    await watchRepositories(input({ once: true, backfill: true }), h.deps)

    expect(h.events).toEqual([
      'warning acme/shop: --backfill only applies the first time a repository is seen; its open pull requests were recorded as they were on 2026-10-17.',
    ])
  })
})
