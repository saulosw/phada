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
import type { CommentListing, IssueComment } from '../github/issue-comments.js'
import type { FailureKind, JobRecord, RequestRecord } from '../watch/types.js'
import type { WhenInput } from './submit-request.js'
import { submitRequest } from './submit-request.js'
import { CiReadError } from './read-ci.js'
import type { ReviewRun } from './review-and-publish.js'
import { watchRepositories } from './watch-repositories.js'
import type { PullCi, WatchDeps } from './watch-repositories.js'

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
  repos: [{ repo: 'acme/shop', publish: 'pr', allowExternal: false }],
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
  whenRefusal?: string
  comments?: (since: string) => CommentListing
  baselineAt?: string
  ci?: (job: JobRecord, now: number) => PullCi | undefined
}

async function setup(script: Script, history?: HistoryStore) {
  const store = history ?? (await openHistoryStore(join(dir, `w${++files}.sqlite`)))
  if (script.baselineAt !== undefined) {
    store.saveRepo({ repo: 'acme/shop', baselineAt: script.baselineAt })
  }
  let now = START
  let cycle = 0
  let sleeps = 0
  const ran: JobRecord[] = []
  const asked: RequestRecord[][] = []
  const notified: string[] = []
  const { comments } = script
  const whenAsked: string[] = []
  const reacted: number[] = []
  const events: string[] = []
  const recorded: string[] = []
  const indexed: number[] = []
  const ciReads: string[] = []
  const deps: WatchDeps = {
    history: store,
    listPulls: async () => {
      cycle += 1
      return script.listings?.(cycle, now) ?? { status: 'ok', pulls: [] }
    },
    defaultBranch: async () => 'main',
    submit: {
      history: store,
      settings: script.settings ?? SETTINGS,
      readPull: async (repo, number) => ({
        repo,
        number,
        headSha: script.readPull?.(repo, number).headSha ?? A,
        state: script.readPull?.(repo, number).state ?? 'open',
        private: false,
        association: 'MEMBER',
      }),
      now: () => new Date(now),
      ...(script.whenRefusal === undefined
        ? {}
        : {
            checkWhen: async (command: string, input: WhenInput) => {
              const { pullRequest, request } = input
              whenAsked.push(
                `${command} ${request.source} #${pullRequest.number} ${pullRequest.author}`,
              )
              return script.whenRefusal
            },
          }),
    },
    ...(comments === undefined
      ? {}
      : { listComments: async (_repo: string, since: string) => comments(since) }),
    react: async (_repo, id) => {
      reacted.push(id)
    },
    branchHead: async () => script.branchHead?.(now) ?? { status: 'not-modified' },
    runJob: async (job, requests) => {
      ran.push(job)
      asked.push([...requests])
      return script.runJob?.(job, now) ?? published(job)
    },
    ...(script.ci === undefined
      ? {}
      : {
          readCi: async (job: JobRecord) => {
            ciReads.push(`#${job.number} @${(now - START) / MIN}`)
            return script.ci?.(job, now - START)
          },
        }),
    recordRun: (job, outcome) => {
      recorded.push(
        `${job.number}:${'run' in outcome ? outcome.run.status : 'kind' in outcome ? outcome.kind : `ci-failing ${outcome.skippedForCi.summary.failing.join(',')}`}`,
      )
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
      waiting: (job) =>
        events.push(
          `waiting #${job.number} @${(now - START) / MIN} until ${(Date.parse(job.ciDeadline ?? '') - START) / MIN} [${(job.ciPending ?? []).join(',')}]`,
        ),
      finished: (job) => events.push(`finished #${job.number}`),
      ciFailing: (job) =>
        events.push(
          `ci-failing #${job.number} @${(now - START) / MIN} [${(job.ciFailing ?? []).join(',')}]`,
        ),
      ciCleared: (job) => events.push(`ci-cleared #${job.number} @${(now - START) / MIN}`),
      retry: (job, at) => events.push(`retry #${job.number} @${(Date.parse(at) - START) / MIN}`),
      paused: (pause) => events.push(`paused until ${(Date.parse(pause.until) - START) / MIN}`),
      failed: (job) => events.push(`failed #${job.number}`),
      indexed: (repo) => events.push(`indexed ${repo}`),
      indexPartial: (repo) => events.push(`partial ${repo}`),
      feedback: (repo, number, threads) => events.push(`observed ${repo}#${number} ${threads}`),
      warning: (message) => events.push(`warning ${message}`),
      refused: (request, result) =>
        events.push(`refused ${request.source} #${request.number} ${result.reason}`),
      limited: (count, until) =>
        events.push(`limited ${count} until ${(Date.parse(until) - START) / MIN}`),
    },
  }
  return {
    deps,
    store,
    ran,
    asked,
    notified,
    whenAsked,
    reacted,
    events,
    recorded,
    indexed,
    ciReads,
    now: () => now - START,
  }
}

const BASELINE = new Date(START - MIN).toISOString()

function queuedMcpJob(store: HistoryStore): void {
  const id = store.addJob({
    repo: 'acme/shop',
    number: 3,
    headSha: A,
    status: 'queued',
    attempts: 0,
    notBefore: new Date(START + 60 * MIN).toISOString(),
    publish: 'none',
    createdAt: new Date(START).toISOString(),
  })
  store.addRequest({
    jobId: id,
    source: 'mcp',
    publish: 'none',
    createdAt: new Date(START).toISOString(),
  })
}

const command = (id: number, overrides: Partial<IssueComment> = {}): IssueComment => ({
  id,
  body: '/phada review',
  author: 'alice',
  authorIsBot: false,
  association: 'MEMBER',
  createdAt: new Date(START).toISOString(),
  url: `https://github.com/acme/shop/pull/3#issuecomment-${id}`,
  number: 3,
  pullRequest: true,
  ...overrides,
})

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
      baselineAt: BASELINE,
      stopWhen: ({ ran }) => ran.length === 1,
    })
    await submitRequest(
      { repo: 'acme/shop', number: 3, source: 'slack', publish: 'none', data: { ts: '1.2' } },
      h.deps.submit,
    )

    await watchRepositories(input(), h.deps)

    expect(h.store.jobs({})).toHaveLength(1)
    expect(h.ran[0]?.publish).toBe('pr')
    expect(h.asked[0]?.map(({ source }) => source)).toEqual(['slack', 'watch'])
    expect(h.events).toContain('started #3 @0')
  })

  const supersededDraft = (cycle: number) => ({
    status: 'ok' as const,
    pulls: [pull(3, cycle === 1 ? A : B, { draft: true })],
  })

  it('moves the requests of a superseded job to the new commit', async () => {
    const h = await setup({
      listings: supersededDraft,
      readPull: () => ({ headSha: B }),
      baselineAt: BASELINE,
      stopWhen: ({ ran }) => ran.length === 1,
    })
    queuedMcpJob(h.store)

    await watchRepositories(input(), h.deps)

    expect(h.ran.map((job) => job.headSha)).toEqual([B])
    expect(h.asked[0]?.map(({ source }) => source)).toEqual(['mcp'])
    expect(h.events.slice(0, 2)).toEqual(['superseded #3', 'queued #3 b'])
  })

  it('tells a moved request it was refused on the new commit', async () => {
    const h = await setup({
      listings: supersededDraft,
      readPull: () => ({ headSha: B, state: 'closed' }),
      baselineAt: BASELINE,
      stopWhen: ({ sleeps }) => sleeps === 2,
    })
    queuedMcpJob(h.store)

    await watchRepositories(input(), h.deps)

    expect(h.notified).toEqual(['skipped #3 closed [mcp]'])
  })

  it('gives a moved request the review the new commit already has', async () => {
    const h = await setup({
      listings: supersededDraft,
      readPull: () => ({ headSha: B }),
      baselineAt: BASELINE,
      stopWhen: ({ sleeps }) => sleeps === 2,
    })
    queuedMcpJob(h.store)
    h.store.addJob({
      repo: 'acme/shop',
      number: 3,
      headSha: B,
      status: 'done',
      attempts: 0,
      notBefore: new Date(START).toISOString(),
      publish: 'pr',
      createdAt: new Date(START).toISOString(),
      finishedAt: new Date(START).toISOString(),
    })

    await watchRepositories(input(), h.deps)

    expect(h.notified).toEqual(['finished #3 [mcp]'])
  })

  it('asks the when command before queueing a push, and remembers the refusal for the commit', async () => {
    const settings = { ...SETTINGS, repos: [{ ...SETTINGS.repos[0]!, when: './team.sh' }] }
    const h = await setup({
      listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3)] }),
      settings,
      whenRefusal: 'not the payments team',
      stopWhen: ({ sleeps }) => sleeps === 3,
    })

    await watchRepositories(input({ settings }), h.deps)

    expect(h.whenAsked).toEqual(['./team.sh watch #3 alice'])
    expect(h.store.jobs({})).toEqual([
      expect.objectContaining({ status: 'skipped', reason: 'when-command' }),
    ])
    expect(h.events).toContain(
      'warning acme/shop#3: the when command refused it (not the payments team)',
    )
  })

  it('takes a /phada review comment as a request, reacts to it and reviews at once', async () => {
    const sinces: string[] = []
    const baselineAt = new Date(START - 60 * MIN).toISOString()
    const h = await setup({
      listings: () => ({ status: 'not-modified' }),
      baselineAt,
      comments: (since) => {
        sinces.push(since)
        return {
          status: 'ok',
          etag: 'W/"c"',
          comments: [
            command(40, { createdAt: new Date(START - MIN).toISOString() }),
            command(41, { author: 'mallory', association: 'NONE' }),
          ],
        }
      },
      stopWhen: ({ ran }) => ran.length === 1,
    })

    await watchRepositories(input(), h.deps)

    expect(sinces).toEqual([baselineAt])
    expect(h.reacted).toEqual([40])
    expect(h.asked[0]).toMatchObject([
      { source: 'pr-command', publish: 'pr', data: { commentId: 40, author: 'alice' } },
    ])
    expect(h.store.repo('acme/shop')).toMatchObject({
      commentsEtag: 'W/"c"',
      commentsLastId: 41,
      commentsSince: new Date(START).toISOString(),
    })
  })

  it('says why a /phada review was refused, without reacting', async () => {
    const h = await setup({
      listings: () => ({ status: 'not-modified' }),
      readPull: () => ({ headSha: A, state: 'closed' }),
      baselineAt: new Date(START - 60 * MIN).toISOString(),
      comments: () => ({ status: 'ok', comments: [command(40, { association: 'OWNER' })] }),
      stopWhen: ({ sleeps }) => sleeps === 1,
    })

    await watchRepositories(input(), h.deps)

    expect(h.events).toContain('refused pr-command #3 closed')
    expect(h.reacted).toEqual([])
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
      baselineAt: BASELINE,
      stopWhen: ({ sleeps }) => sleeps === 2,
    })

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
        repos: [...SETTINGS.repos, { repo: 'acme/web', publish: 'pr', allowExternal: false }],
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
          repos: [...SETTINGS.repos, { repo: 'acme/web', publish: 'pr', allowExternal: false }],
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
        repos: [...SETTINGS.repos, { repo: 'acme/web', publish: 'pr', allowExternal: false }],
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
          repos: [...SETTINGS.repos, { repo: 'acme/web', publish: 'pr', allowExternal: false }],
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

  describe('waiting for CI', () => {
    const newPull = (cycle: number) => ({
      status: 'ok' as const,
      pulls: cycle === 1 ? [] : [pull(3)],
    })
    const summary = (
      state: 'none' | 'pending' | 'passing' | 'failing',
      pending: string[] = [],
    ): PullCi => ({
      waitMs: 15 * MIN,
      onFailure: 'review',
      summary: { state, pending, failing: [] },
      checks: pending.map((name) => ({ name, state: 'pending' })),
    })

    it('waits for pending checks without starting the job, reads them each minute and reviews once they pass', async () => {
      const h = await setup({
        listings: newPull,
        ci: (_job, now) => (now < 11 * MIN ? summary('pending', ['test']) : summary('passing')),
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.events).toEqual([
        'baseline acme/shop 0',
        'queued #3 a',
        'waiting #3 @8 until 20 [test]',
        'started #3 @11',
        'finished #3',
      ])
      expect(h.ciReads).toEqual(['#3 @8', '#3 @9', '#3 @10', '#3 @11'])
      expect(h.notified).toEqual(['started #3 [watch]', 'finished #3 [watch]'])
      expect(h.recorded).toEqual(['3:reviewed'])
      expect(h.ran[0]?.reason).toBeUndefined()
      expect(h.store.jobs({ status: ['done'] })).toHaveLength(1)
    })

    it('reviews at the deadline with the checks still pending', async () => {
      const h = await setup({
        listings: newPull,
        ci: () => summary('pending', ['e2e']),
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.events).toContain('started #3 @20')
      expect(h.ciReads).toHaveLength(13)
      expect(h.ran[0]?.ciPending).toEqual(['e2e'])
      expect(h.store.jobs({ status: ['done'] })[0]?.ciPending).toEqual(['e2e'])
    })

    it('reviews the other jobs while one waits for CI', async () => {
      const h = await setup({
        listings: (cycle) => ({ status: 'ok', pulls: cycle === 1 ? [] : [pull(3), pull(4)] }),
        ci: (job) => (job.number === 3 ? summary('pending', ['test']) : summary('passing')),
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.ran.map(({ number }) => number)).toEqual([4])
      expect(h.store.jobs({ status: ['waiting'] })).toEqual([
        expect.objectContaining({ number: 3, reason: 'ci-pending', ciPending: ['test'] }),
      ])
    })

    it('waits 2 minutes for checks to appear on a commit it just saw, then reviews without CI', async () => {
      const h = await setup({
        listings: () => ({ status: 'ok', pulls: [pull(3)] }),
        baselineAt: BASELINE,
        ci: () => summary('none'),
        stopWhen: ({ ran }) => ran.length === 1,
      })
      await submitRequest(
        { repo: 'acme/shop', number: 3, source: 'slack', publish: 'none' },
        h.deps.submit,
      )

      await watchRepositories(input(), h.deps)

      expect(h.events).toEqual(['waiting #3 @0 until 2 []', 'started #3 @2', 'finished #3'])
    })

    it('tells the CI it read when the job starts, and nothing when it read none', async () => {
      const startedCi = async (ci: Script['ci']) => {
        const h = await setup({ listings: newPull, ci, stopWhen: ({ ran }) => ran.length === 1 })
        const seen: unknown[] = []
        const notify = h.deps.notify
        h.deps.notify = async (event) => {
          if (event.kind === 'started') seen.push(event.ci)
          await notify(event)
        }
        await watchRepositories(input(), h.deps)
        return seen
      }
      const failing: PullCi = {
        waitMs: 0,
        onFailure: 'review',
        summary: { state: 'failing', pending: [], failing: ['test'] },
        checks: [
          { name: 'test', state: 'failing' },
          { name: 'build', state: 'passing' },
        ],
      }

      expect(await startedCi(() => failing)).toEqual([
        {
          state: 'failing',
          checks: [
            { name: 'test', state: 'failing' },
            { name: 'build', state: 'passing' },
          ],
        },
      ])
      expect(await startedCi(() => undefined)).toEqual([undefined])
      expect(
        await startedCi(() => {
          throw new Error('checks:read is missing')
        }),
      ).toEqual([undefined])
    })

    it('warns with what was not read when the checks cannot be read', async () => {
      const h = await setup({
        listings: newPull,
        ci: () => {
          throw new CiReadError([
            'CI check runs were not read: HTTP 403',
            'Commit statuses were not read: HTTP 502',
          ])
        },
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.events).toContain(
        'warning acme/shop#3: CI check runs were not read: HTTP 403; Commit statuses were not read: HTTP 502; reviewing without waiting for CI',
      )
      expect(h.events).toContain('started #3 @8')
    })

    it('does not wait when the CI settings turn the wait off', async () => {
      const h = await setup({
        listings: newPull,
        ci: () => undefined,
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.events).toContain('started #3 @8')
    })

    it('reviews without waiting when the checks cannot be read', async () => {
      const h = await setup({
        listings: newPull,
        ci: () => {
          throw new Error('checks:read is missing')
        },
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.events).toContain(
        'warning acme/shop#3: the checks were not read (checks:read is missing); reviewing without waiting for CI',
      )
      expect(h.events).toContain('started #3 @8')
    })
  })
  describe('skipping a commit whose CI fails', () => {
    const at = (minutes: number) => new Date(START + minutes * MIN).toISOString()
    const newPull = (cycle: number) => ({
      status: 'ok' as const,
      pulls: cycle === 1 ? [] : [pull(3)],
    })
    const ci = (
      state: 'pending' | 'passing' | 'failing',
      names: string[] = [],
      onFailure: 'review' | 'skip' = 'skip',
    ): PullCi => ({
      waitMs: 15 * MIN,
      onFailure,
      summary: {
        state,
        pending: state === 'pending' ? names : [],
        failing: state === 'failing' ? names : [],
      },
      checks: names.map((name) => ({ name, state: state === 'passing' ? 'passing' : state })),
    })
    const skippedForCi = (store: HistoryStore, number: number, finishedAt: string): number => {
      store.savePull({
        repo: 'acme/shop',
        number,
        headSha: A,
        headSeenAt: finishedAt,
        eligible: true,
        state: 'open',
      })
      const id = store.addJob({
        repo: 'acme/shop',
        number,
        headSha: A,
        status: 'skipped',
        reason: 'ci-failing',
        attempts: 0,
        notBefore: finishedAt,
        publish: 'pr',
        createdAt: finishedAt,
        finishedAt,
        ciFailing: ['test'],
      })
      store.addRequest({ jobId: id, source: 'watch', publish: 'pr', createdAt: finishedAt })
      return id
    }

    it('skips a job whose checks fail with onFailure skip, records the run and tells why', async () => {
      const h = await setup({
        listings: newPull,
        ci: () => ci('failing', ['test', 'lint']),
        stopWhen: ({ now }) => now >= 9 * MIN,
      })

      await watchRepositories(input(), h.deps)

      expect(h.ran).toEqual([])
      expect(h.events).toEqual([
        'baseline acme/shop 0',
        'queued #3 a',
        'ci-failing #3 @8 [test,lint]',
      ])
      expect(h.recorded).toEqual(['3:ci-failing test,lint'])
      expect(h.notified).toEqual(['skipped #3 ci-failing [watch]'])
      expect(h.store.jobs({})).toEqual([
        expect.objectContaining({
          number: 3,
          status: 'skipped',
          reason: 'ci-failing',
          ciFailing: ['test', 'lint'],
          finishedAt: at(8),
        }),
      ])
    })

    it('reviews a failing commit with onFailure review', async () => {
      const h = await setup({
        listings: newPull,
        ci: () => ci('failing', ['test'], 'review'),
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.events).toContain('started #3 @8')
      expect(h.recorded).toEqual(['3:reviewed'])
    })

    it('waits for the pending checks of a failing commit with onFailure review', async () => {
      const failingWith = (pending: string[]): PullCi => ({
        waitMs: 15 * MIN,
        onFailure: 'review',
        summary: { state: 'failing', pending, failing: ['test'] },
        checks: [
          { name: 'test', state: 'failing' },
          ...pending.map((name) => ({ name, state: 'pending' as const })),
        ],
      })
      const h = await setup({
        listings: newPull,
        ci: (_job, now) => failingWith(now < 10 * MIN ? ['e2e'] : []),
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.events).toEqual([
        'baseline acme/shop 0',
        'queued #3 a',
        'waiting #3 @8 until 20 [e2e]',
        'started #3 @10',
        'finished #3',
      ])
      expect(h.ran[0]?.ciPending).toBeUndefined()
    })

    it('reads the checks again each discovery cycle and queues the same job once they no longer fail', async () => {
      const h = await setup({
        listings: newPull,
        ci: (_job, now) =>
          now < 10 * MIN
            ? ci('failing', ['test'])
            : now < 12 * MIN
              ? ci('pending', ['test'])
              : ci('passing', ['test']),
        stopWhen: ({ ran }) => ran.length === 1,
      })

      await watchRepositories(input(), h.deps)

      expect(h.events).toEqual([
        'baseline acme/shop 0',
        'queued #3 a',
        'ci-failing #3 @8 [test]',
        'ci-cleared #3 @10',
        'waiting #3 @10 until 25 [test]',
        'started #3 @12',
        'finished #3',
      ])
      expect(h.ciReads).toEqual(['#3 @8', '#3 @10', '#3 @10', '#3 @11', '#3 @12'])
      expect(h.notified).toEqual([
        'skipped #3 ci-failing [watch]',
        'started #3 [watch]',
        'finished #3 [watch]',
      ])
      expect(h.store.jobs({})).toEqual([
        expect.objectContaining({ id: 1, status: 'done', ciSince: at(10) }),
      ])
      expect(h.store.job(1)?.ciFailing).toBeUndefined()
    })

    it('stops reading the checks of a skipped commit 24 hours after the skip', async () => {
      const h = await setup({
        listings: () => ({ status: 'ok', pulls: [pull(3)] }),
        baselineAt: BASELINE,
        ci: () => ci('failing', ['test']),
        stopWhen: ({ now }) => now >= 20 * MIN,
      })
      const id = skippedForCi(h.store, 3, new Date(START - 24 * 60 * MIN + 10 * MIN).toISOString())

      await watchRepositories(input(), h.deps)

      expect(h.ciReads).toEqual(['#3 @0', '#3 @5'])
      expect(h.store.job(id)).toMatchObject({ status: 'skipped', ciCheckedAt: at(5) })
      expect(h.notified).toEqual([])
    })

    it('reads at most 10 skipped commits per cycle, the ones read longest ago first', async () => {
      const numbers = Array.from({ length: 12 }, (_, index) => index + 1)
      const h = await setup({
        listings: () => ({ status: 'ok', pulls: numbers.map((number) => pull(number)) }),
        baselineAt: BASELINE,
        ci: () => ci('failing', ['test']),
        stopWhen: ({ now }) => now >= 6 * MIN,
      })
      for (const number of numbers) skippedForCi(h.store, number, at(-60 + number))

      await watchRepositories(input(), h.deps)

      expect(h.ciReads).toEqual([
        ...numbers.slice(0, 10).map((number) => `#${number} @0`),
        ...[11, 12, 1, 2, 3, 4, 5, 6, 7, 8].map((number) => `#${number} @5`),
      ])
    })

    it('stops reading the checks of a skipped commit once the pull request has a new commit', async () => {
      const h = await setup({
        listings: () => ({ status: 'ok', pulls: [pull(3, B)] }),
        baselineAt: BASELINE,
        ci: (job) => (job.headSha === A ? ci('passing') : ci('failing', ['lint'])),
        stopWhen: ({ now }) => now >= 4 * MIN,
      })
      const id = skippedForCi(h.store, 3, at(-30))

      await watchRepositories(input(), h.deps)

      expect(h.ciReads).toEqual(['#3 @3'])
      expect(h.store.job(id)).toMatchObject({ status: 'skipped', reason: 'ci-failing' })
      expect(h.store.jobs({ status: ['skipped'] })).toHaveLength(2)
    })

    it('moves the requests of a commit skipped for CI to the new commit', async () => {
      const h = await setup({
        listings: () => ({ status: 'ok', pulls: [pull(3, B)] }),
        readPull: () => ({ headSha: B }),
        baselineAt: BASELINE,
        ci: (job) => (job.headSha === A ? ci('failing', ['test']) : ci('passing', ['test'])),
        stopWhen: ({ ran }) => ran.length === 1,
      })
      const id = skippedForCi(h.store, 3, at(-30))
      h.store.addRequest({ jobId: id, source: 'mcp', publish: 'none', createdAt: at(-30) })

      await watchRepositories(input(), h.deps)

      expect(h.ran.map((job) => job.headSha)).toEqual([B])
      expect(h.asked[0]?.map(({ source }) => source).sort()).toEqual(['mcp', 'watch'])
      expect(h.notified).toEqual(['started #3 [watch,mcp]', 'finished #3 [watch,mcp]'])
      expect(h.store.job(id)).toMatchObject({ status: 'skipped', reason: 'ci-failing' })
    })

    it('reads the checks of a requested commit on a draft again and reviews it once they pass', async () => {
      const h = await setup({
        listings: () => ({ status: 'ok', pulls: [pull(3, A, { draft: true })] }),
        baselineAt: BASELINE,
        ci: (_job, now) => (now < 5 * MIN ? ci('failing', ['test']) : ci('passing', ['test'])),
        stopWhen: ({ ran }) => ran.length === 1,
      })
      const id = skippedForCi(h.store, 3, at(-30))
      h.store.savePull({ ...h.store.pulls('acme/shop')[0]!, eligible: false })
      h.store.addRequest({ jobId: id, source: 'slack', publish: 'none', createdAt: at(-30) })

      await watchRepositories(input(), h.deps)

      expect(h.ciReads.slice(0, 2)).toEqual(['#3 @0', '#3 @5'])
      expect(h.events).toContain('ci-cleared #3 @5')
      expect(h.ran.map((job) => job.id)).toEqual([id])
    })

    it('moves the requests of a commit skipped for CI on a draft to its new commit', async () => {
      const h = await setup({
        listings: () => ({ status: 'ok', pulls: [pull(3, B, { draft: true })] }),
        readPull: () => ({ headSha: B }),
        baselineAt: BASELINE,
        ci: () => ci('passing', ['test']),
        stopWhen: ({ ran }) => ran.length === 1,
      })
      const id = skippedForCi(h.store, 3, at(-30))
      h.store.savePull({ ...h.store.pulls('acme/shop')[0]!, eligible: false })
      h.store.addRequest({ jobId: id, source: 'slack', publish: 'none', createdAt: at(-30) })

      await watchRepositories(input(), h.deps)

      expect(h.ran.map((job) => job.headSha)).toEqual([B])
      expect(h.asked[0]?.map(({ source }) => source)).toEqual(['slack'])
    })

    it('reads the checks of a skipped commit again for a new request and answers only that request while they still fail', async () => {
      const h = await setup({
        listings: () => ({ status: 'ok', pulls: [pull(3)] }),
        baselineAt: BASELINE,
        ci: () => ci('failing', ['test']),
        stopWhen: ({ now }) => now >= 1 * MIN,
      })
      const id = skippedForCi(h.store, 3, at(-30))
      const result = await submitRequest(
        { repo: 'acme/shop', number: 3, source: 'mcp', publish: 'none' },
        h.deps.submit,
      )

      await watchRepositories(input(), h.deps)

      expect(result).toMatchObject({ status: 'joined', job: { id, status: 'queued' } })
      expect(h.ciReads).toEqual(['#3 @0'])
      expect(h.notified).toEqual(['skipped #3 ci-failing [mcp]'])
      expect(h.store.job(id)).toMatchObject({ status: 'skipped', reason: 'ci-failing' })
    })
  })
})
