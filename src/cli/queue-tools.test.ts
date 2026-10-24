import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { WatchSettings } from '../config/watch-settings.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import type { PullFacts } from '../watch/pull-facts.js'
import { queueToolbox } from './queue-tools.js'
import type { QueueToolsDeps } from './queue-tools.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-queue-tools-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0
const fresh = () => openHistoryStore(join(dir, `h${++files}`, 'history.sqlite'))

const START = Date.parse('2026-10-23T12:00:00.000Z')
const A = 'a'.repeat(40)
const SETTINGS: WatchSettings = {
  intervalMs: 300_000,
  settleMs: 180_000,
  maxReviewsPerHour: 6,
  repos: [{ repo: 'acme/shop', publish: 'pr', allowExternal: false }],
}
const PULL: PullFacts = {
  repo: 'acme/shop',
  number: 7,
  headSha: A,
  state: 'open',
  private: false,
  association: 'MEMBER',
}

function setup(history: HistoryStore, overrides: Partial<QueueToolsDeps> = {}) {
  let now = START
  const sleeps: number[] = []
  const deps: QueueToolsDeps = {
    history,
    submit: {
      history,
      settings: SETTINGS,
      readPull: async () => PULL,
      now: () => new Date(now),
    },
    watchRunning: async () => true,
    now: () => new Date(now),
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
    ...overrides,
  }
  return { toolbox: queueToolbox(deps), sleeps, advance: (ms: number) => (now += ms) }
}

async function call(toolbox: ReturnType<typeof queueToolbox>, name: string, args: unknown) {
  const result = await toolbox.call(name, args)
  return { ...result, json: result.isError ? undefined : (JSON.parse(result.text) as unknown) }
}

function finish(history: HistoryStore, id: number) {
  history.updateJob(id, { status: 'done', finishedAt: '2026-10-23T12:05:00.000Z' })
  history.addRun({
    jobId: id,
    source: 'watch',
    repo: 'acme/shop',
    number: 7,
    headSha: A,
    startedAt: '2026-10-23T12:01:00.000Z',
    finishedAt: '2026-10-23T12:05:00.000Z',
    status: 'not-published',
    aiCalled: true,
    verdict: 'comments',
    resultJson: '{"schemaVersion":1,"verdict":"comments","review":{"findings":[]}}',
  })
}

describe('queueToolbox', () => {
  it('has the four tools, and only the request one writes', () => {
    const { toolbox } = setup({} as HistoryStore)
    expect(toolbox.definitions.map(({ name, annotations }) => [name, annotations])).toEqual([
      ['review_pull_request', { readOnlyHint: false, openWorldHint: true }],
      ['job_status', { readOnlyHint: true, openWorldHint: false }],
      ['wait_for_job', { readOnlyHint: true, openWorldHint: false }],
      ['list_queue', { readOnlyHint: true, openWorldHint: false }],
    ])
  })

  it('queues a review asked for by the AI, with the target it asked for', async () => {
    const history = await fresh()
    const { toolbox } = setup(history)

    const result = await call(toolbox, 'review_pull_request', {
      pr: 'https://github.com/acme/shop/pull/7',
      publish: 'none',
    })

    expect(result.json).toEqual({
      status: 'queued',
      job: { id: 1, repo: 'acme/shop', number: 7, headSha: A, status: 'queued', publish: 'none' },
      watchRunning: true,
    })
    expect(history.requests([1])).toMatchObject([{ source: 'mcp', publish: 'none' }])
    history.close()
  })

  it('says no watch runs when the job has to wait for one', async () => {
    const history = await fresh()
    const { toolbox } = setup(history, { watchRunning: async () => false })

    expect((await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })).json).toMatchObject({
      status: 'queued',
      watchRunning: false,
      note: 'No phada watch is running: the job waits in the queue until one starts.',
    })
    history.close()
  })

  it('says a refused request was refused and why', async () => {
    const history = await fresh()
    const { toolbox } = setup(history, { watchRunning: async () => false })

    const result = await call(toolbox, 'review_pull_request', { pr: 'other/repo#3' })

    expect(result.json).toEqual({
      status: 'refused',
      reason: 'not-watched',
      message: 'the repository is not listed under watch: in your config',
      watchRunning: false,
    })
    history.close()
  })

  it('gives the review of a commit already reviewed at once', async () => {
    const history = await fresh()
    const { toolbox } = setup(history)
    await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })
    finish(history, 1)

    const result = await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })

    expect(result.json).toMatchObject({
      status: 'refused',
      reason: 'already-reviewed',
      event: { event: 'review.finished', verdict: 'comments', review: { verdict: 'comments' } },
    })
    history.close()
  })

  it('answers an error for a pull request reference it cannot read', async () => {
    const history = await fresh()
    expect(
      await call(setup(history).toolbox, 'review_pull_request', { pr: 'not a pr' }),
    ).toMatchObject({ isError: true })
    history.close()
  })

  it('answers an error without a watch config', async () => {
    const history = await fresh()
    const { toolbox } = setup(history, { submit: undefined })
    expect(await toolbox.call('review_pull_request', { pr: 'acme/shop#7' })).toMatchObject({
      isError: true,
      text: expect.stringContaining('Nothing to watch'),
    })
    history.close()
  })

  it('tells the status and the place in the queue of a job', async () => {
    const history = await fresh()
    const { toolbox } = setup(history)
    await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })

    expect((await call(toolbox, 'job_status', { job: 1 })).json).toEqual({
      job: {
        id: 1,
        repo: 'acme/shop',
        number: 7,
        headSha: A,
        status: 'queued',
        publish: 'pr',
        sources: ['mcp'],
      },
      position: 1,
    })
    expect(await call(toolbox, 'job_status', { job: 9 })).toMatchObject({ isError: true })
    history.close()
  })

  it('waits for a job and returns its event with the full review', async () => {
    const history = await fresh()
    const { toolbox, sleeps } = setup(history, {
      sleep: async (ms) => {
        sleeps.push(ms)
        if (sleeps.length === 2) finish(history, 1)
      },
    })
    await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })

    const result = await call(toolbox, 'wait_for_job', { job: 1 })

    expect(result.json).toMatchObject({
      timedOut: false,
      event: {
        event: 'review.finished',
        verdict: 'comments',
        publication: { status: 'not-published' },
        review: { review: { findings: [] } },
      },
    })
    history.close()
  })

  it('stops waiting at the deadline and says where the job is', async () => {
    const history = await fresh()
    const { toolbox, sleeps } = setup(history)
    await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })

    const result = await call(toolbox, 'wait_for_job', { job: 1, timeoutSeconds: 10 })

    expect(result.json).toMatchObject({ timedOut: true, job: { status: 'queued' }, position: 1 })
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(10_000)
    history.close()
  })

  it('never waits longer than 30 minutes', async () => {
    const history = await fresh()
    const { toolbox, sleeps } = setup(history)
    await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })

    await call(toolbox, 'wait_for_job', { job: 1, timeoutSeconds: 99_999 })

    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(1_800_000)
    history.close()
  })

  it('points at the newer job when the commit was superseded', async () => {
    const history = await fresh()
    const { toolbox } = setup(history)
    await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })
    history.updateJob(1, { status: 'superseded', finishedAt: '2026-10-23T12:02:00.000Z' })
    const newer = history.addJob({
      repo: 'acme/shop',
      number: 7,
      headSha: 'b'.repeat(40),
      status: 'queued',
      attempts: 0,
      notBefore: '2026-10-23T12:02:00.000Z',
      createdAt: '2026-10-23T12:02:00.000Z',
    })

    expect((await call(toolbox, 'wait_for_job', { job: 1 })).json).toMatchObject({
      timedOut: false,
      event: { event: 'review.skipped', reason: 'superseded' },
      newerJob: newer,
    })
    history.close()
  })

  it('lists the queue and what runs now', async () => {
    const history = await fresh()
    const { toolbox } = setup(history)
    await call(toolbox, 'review_pull_request', { pr: 'acme/shop#7' })

    expect((await call(toolbox, 'list_queue', {})).json).toEqual({
      watchRunning: true,
      queued: [expect.objectContaining({ id: 1, sources: ['mcp'] })],
      running: [],
    })
    history.close()
  })
})
