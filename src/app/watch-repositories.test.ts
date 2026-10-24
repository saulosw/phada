import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { WatchSettings } from '../config/watch-settings.js'
import type { OpenPull, PullListing } from '../github/list-pull-requests.js'
import type { BranchHead } from '../github/repository.js'
import { openHistoryStore } from '../store/history-store.js'
import type { DuePull, HistoryStore } from '../store/history-store.js'
import type { FailureKind, JobRecord, RequestRecord } from '../watch/types.js'
import { submitRequest } from './submit-request.js'
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
    plan: {
      comments: [],
      stillOpen: [],
      dismissed: [],
      fixedAgain: [],
      fixedThreads: 0,
      openThreads: 0,
    },
    rendered: { body: 'body', comments: [] },
    publication: {
      status: 'published',
      url: `https://x/${job.number}`,
      resolved: { resolved: 0, failed: 0, total: 0 },
    },
  }
}

interface Script {
  listings?: (cycle: number, now: number) => PullListing
  runJob?: (job: JobRecord, now: number) => Promise<ReviewRun>
  classify?: (error: unknown) => { kind: FailureKind; resetAt?: string }
  branchHead?: (now: number) => BranchHead
  refreshIndex?: () => Promise<'complete' | 'partial'>
  refreshFeedback?: (pulls: readonly DuePull[]) => Promise<void>
  stopWhen?: (state: { now: number; ran: JobRecord[]; sleeps: number }) => boolean
  settings?: WatchSettings
  readPull?: (repo: string, number: number) => { headSha: string; state?: 'open' | 'closed' }
}

async function setup(script: Script, history?: HistoryStore) {
  const store = history ?? (await openHistoryStore(join(dir, `w${++files}.sqlite`)))
  let now = START
  let cycle = 0
  let sleeps = 0
  const ran: JobRecord[] = []
  const asked: RequestRecord[][] = []
  const notified: string[] = []
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
    readPull: async (repo, number) => ({
      repo,
      number,
      headSha: script.readPull?.(repo, number).headSha ?? A,
      state: script.readPull?.(repo, number).state ?? 'open',
      private: false,
      association: 'MEMBER',
    }),
    branchHead: async () => script.branchHead?.(now) ?? { status: 'not-modified' },
    runJob: async (job, requests) => {
      ran.push(job)
      asked.push([...requests])
      return script.runJob?.(job, now) ?? published(job)
    },
    recordRun: (job, outcome) => {
      recorded.push(`${job.number}:${'run' in outcome ? outcome.run.status : outcome.kind}`)
    },
    refreshIndex: async (_repo, budgetMs) => {
      indexed.push(budgetMs)
      events.push('index checked')
      return script.refreshIndex?.() ?? 'complete'
    },
    refreshFeedback: async (pulls) => {
      events.push(`feedback ${pulls.map((due) => `${due.repo}#${due.number}`).join(' ')}`)
      await script.refreshFeedback?.(pulls)
    },
    notify: async ({ kind, job, reason, requests }) => {
      const sources = requests.map(({ source }) => source).join(',')
      notified.push(
        `${kind} #${job.number}${reason === undefined ? '' : ` ${reason}`} [${sources}]`,
      )
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
      feedback: (repo, number, threads) => events.push(`observed ${repo}#${number} ${threads}`),
      warning: (message) => events.push(`warning ${message}`),
      limited: (count, until) =>
        events.push(`limited ${count} until ${(Date.parse(until) - START) / MIN}`),
    },
  }
  return { deps, store, ran, asked, notified, events, recorded, indexed, now: () => now - START }
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

  it('attaches a watch request to the jobs it queues', async () => {
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      stopWhen: ({ ran }) => ran.length === 1,
    })

    await watchRepositories(input(), h.deps)

    expect(h.asked).toEqual([[expect.objectContaining({ source: 'watch', publish: 'pr' })]])
    expect(h.ran[0]?.publish).toBe('pr')
  })

  it('runs a request from another source at once and joins the watch to it: one job', async () => {
    const h = await setup({
      listings: () => ({ status: 'ok', pulls: [pull(3)] }),
      stopWhen: ({ ran }) => ran.length === 1,
    })
    h.store.saveRepo({ repo: 'acme/shop', baselineAt: new Date(START - MIN).toISOString() })
    await submitRequest(
      { repo: 'acme/shop', number: 3, source: 'slack', publish: 'none', data: { ts: '1.2' } },
      { ...h.deps, settings: SETTINGS },
    )

    await watchRepositories(input(), h.deps)

    expect(h.store.jobs({})).toHaveLength(1)
    expect(h.ran[0]?.publish).toBe('pr')
    expect(h.asked[0]?.map(({ source }) => source)).toEqual(['slack', 'watch'])
    expect(h.events).toContain('started #3 @0')
  })

  it('moves the requests of a superseded job to the new commit', async () => {
    const h = await setup({
      listings: (cycle) => ({
        status: 'ok',
        pulls: [pull(3, cycle === 1 ? A : B, { draft: true })],
      }),
      readPull: () => ({ headSha: B }),
      stopWhen: ({ ran }) => ran.length === 1,
    })
    h.store.saveRepo({ repo: 'acme/shop', baselineAt: new Date(START - MIN).toISOString() })
    h.store.addJob({
      repo: 'acme/shop',
      number: 3,
      headSha: A,
      status: 'queued',
      attempts: 0,
      notBefore: new Date(START + 60 * MIN).toISOString(),
      publish: 'none',
      createdAt: new Date(START).toISOString(),
    })
    h.store.addRequest({
      jobId: 1,
      source: 'mcp',
      publish: 'none',
      createdAt: new Date(START).toISOString(),
    })

    await watchRepositories(input(), h.deps)

    expect(h.ran.map((job) => job.headSha)).toEqual([B])
    expect(h.asked[0]?.map(({ source }) => source)).toEqual(['mcp'])
    expect(h.events.slice(0, 2)).toEqual(['superseded #3', 'queued #3 b'])
  })

  it('tells a moved request it was refused on the new commit', async () => {
    const h = await setup({
      listings: (cycle) => ({
        status: 'ok',
        pulls: [pull(3, cycle === 1 ? A : B, { draft: true })],
      }),
      readPull: () => ({ headSha: B, state: 'closed' }),
      stopWhen: ({ sleeps }) => sleeps === 2,
    })
    h.store.saveRepo({ repo: 'acme/shop', baselineAt: new Date(START - MIN).toISOString() })
    h.store.addJob({
      repo: 'acme/shop',
      number: 3,
      headSha: A,
      status: 'queued',
      attempts: 0,
      notBefore: new Date(START + 60 * MIN).toISOString(),
      publish: 'none',
      createdAt: new Date(START).toISOString(),
    })
    h.store.addRequest({
      jobId: 1,
      source: 'mcp',
      publish: 'none',
      createdAt: new Date(START).toISOString(),
    })

    await watchRepositories(input(), h.deps)

    expect(h.ran).toEqual([])
    expect(h.notified).toEqual(['skipped #3 closed [mcp]'])
  })

  it('asks the when command before queueing a push, and remembers the refusal for the commit', async () => {
    const asked: string[] = []
    const settings = { ...SETTINGS, repos: [{ ...SETTINGS.repos[0]!, when: './team.sh' }] }
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      settings,
      stopWhen: ({ sleeps }) => sleeps === 3,
    })
    h.deps.checkWhen = async (command, input) => {
      asked.push(
        `${command} ${input.request.source} #${input.pullRequest.number} ${input.pullRequest.author}`,
      )
      return 'not the payments team'
    }

    await watchRepositories(input({ settings }), h.deps)

    expect(asked).toEqual(['./team.sh watch #3 alice'])
    expect(h.ran).toEqual([])
    expect(h.store.jobs({})).toEqual([
      expect.objectContaining({ status: 'skipped', reason: 'when-command' }),
    ])
    expect(h.events).toContain(
      'warning acme/shop#3: the when command refused it (not the payments team)',
    )
  })

  it('notifies when a job starts and finishes', async () => {
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      stopWhen: ({ ran }) => ran.length === 1,
    })

    await watchRepositories(input(), h.deps)

    expect(h.notified).toEqual(['started #3 [watch]', 'finished #3 [watch]'])
  })

  it('notifies a skipped review with its reason', async () => {
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      runJob: async (job) => ({
        status: 'skipped',
        pullRequest: pullRequestFixture({ number: job.number }),
        reason: { kind: 'already-reviewed' },
      }),
      stopWhen: ({ ran }) => ran.length === 1,
    })

    await watchRepositories(input(), h.deps)

    expect(h.notified).toEqual(['started #3 [watch]', 'skipped #3 already-reviewed [watch]'])
  })

  it('notifies a failure only once the job fails for good', async () => {
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      runJob: async () => {
        throw new Error('bad')
      },
      classify: () => ({ kind: 'definitive' }),
      stopWhen: ({ ran }) => ran.length === 1,
    })

    await watchRepositories(input(), h.deps)

    expect(h.notified).toEqual(['started #3 [watch]', 'failed #3 [watch]'])
  })

  it('notifies a closed pull request and a superseded commit to the requests that do not move', async () => {
    const h = await setup({
      listings: (cycle) => ({
        status: 'ok',
        pulls: cycle === 1 ? [pull(3, A), pull(4)] : [pull(3, B)],
      }),
      settings: { ...SETTINGS, settleMs: 60 * MIN },
      stopWhen: ({ sleeps }) => sleeps === 2,
    })
    h.store.saveRepo({ repo: 'acme/shop', baselineAt: new Date(START - MIN).toISOString() })

    await watchRepositories(input({ settings: { ...SETTINGS, settleMs: 60 * MIN } }), h.deps)

    expect(h.notified).toEqual(['skipped #3 superseded [watch]', 'skipped #4 closed [watch]'])
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

  describe('feedback', () => {
    const iso = (offset: number) => new Date(START + offset).toISOString()
    const publishedRun = (number: number) => ({
      source: 'watch' as const,
      repo: 'acme/shop',
      number,
      headSha: A,
      startedAt: iso(-60 * MIN),
      finishedAt: iso(-60 * MIN),
      status: 'published' as const,
      aiCalled: true,
      findings: 1,
    })

    async function storeWith(...numbers: number[]) {
      const store = await openHistoryStore(join(dir, `w${++files}.sqlite`))
      store.saveRepo({ repo: 'acme/shop', baselineAt: iso(-120 * MIN) })
      for (const number of numbers) store.addRun(publishedRun(number))
      return store
    }

    it('idle cycle refreshes due feedback after the index, even for a pull no longer listed', async () => {
      const h = await setup({ branchHead: () => ({ status: 'ok', sha: B }) }, await storeWith(7))

      await watchRepositories(input({ once: true }), h.deps)

      expect(h.events).toEqual(['index checked', 'indexed acme/shop', 'feedback acme/shop#7'])
    })

    it('asks for at most 10 pulls observed more than 30 minutes ago', async () => {
      const store = await storeWith(...Array.from({ length: 12 }, (_, index) => index + 1))
      store.observeFeedback({
        repo: 'acme/shop',
        number: 1,
        pullState: 'open',
        observedAt: iso(-10 * MIN),
        source: 'watch',
        threads: [],
      })
      const h = await setup({}, store)

      await watchRepositories(input({ once: true }), h.deps)

      const asked = h.events
        .find((event) => event.startsWith('feedback'))
        ?.split(' ')
        .slice(1)
      expect(asked).toHaveLength(10)
      expect(asked).not.toContain('acme/shop#1')
    })

    it('stops reading a pull request after the read that saw it merged or closed', async () => {
      const store = await storeWith(7, 8)
      for (const [number, pullState] of [
        [7, 'merged'],
        [8, 'closed'],
      ] as const) {
        store.observeFeedback({
          repo: 'acme/shop',
          number,
          pullState,
          observedAt: iso(-120 * MIN),
          source: 'watch',
          threads: [],
        })
      }
      const h = await setup({}, store)

      await watchRepositories(input({ once: true }), h.deps)

      expect(h.events.some((event) => event.startsWith('feedback'))).toBe(false)
    })

    it('skips repositories that are not watched', async () => {
      const store = await storeWith()
      store.addRun({ ...publishedRun(4), repo: 'acme/other' })
      const h = await setup({}, store)

      await watchRepositories(input({ once: true }), h.deps)

      expect(h.events.some((event) => event.startsWith('feedback'))).toBe(false)
    })

    it('refreshes feedback only once the queue is idle', async () => {
      const store = await storeWith(7)
      store.addJob({
        repo: 'acme/shop',
        number: 3,
        headSha: A,
        status: 'queued',
        attempts: 0,
        notBefore: iso(-MIN),
        createdAt: iso(-5 * MIN),
      })
      const h = await setup({}, store)

      await watchRepositories(input({ once: true }), h.deps)

      const order = h.events.filter((event) => /^(finished|feedback)/.test(event))
      expect(order).toEqual(['finished #3', 'feedback acme/shop#7'])
    })

    it('warns and goes on when the feedback refresh throws', async () => {
      const h = await setup(
        {
          refreshFeedback: async () => {
            throw new Error('disk full')
          },
        },
        await storeWith(7),
      )

      expect(await watchRepositories(input({ once: true }), h.deps)).toEqual({ reason: 'once' })
      expect(h.events).toContain('warning could not refresh the feedback (disk full)')
    })
  })
})
