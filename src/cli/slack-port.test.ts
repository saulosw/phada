import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SLACK_EMOJIS } from '../config/watch-settings.js'
import type { SlackSettings, WatchSettings } from '../config/watch-settings.js'
import type { SlackWebApi } from '../slack/web-api.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore, RunRecord } from '../store/history-store.js'
import type { PullFacts } from '../watch/pull-facts.js'
import type { JobRecord } from '../watch/types.js'
import { reviewEvent } from './review-event.js'
import { slackPort } from './slack-port.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-slack-port-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0
const fresh = () => openHistoryStore(join(dir, `h${++files}`, 'history.sqlite'))

const A = 'a'.repeat(40)
const WATCH: WatchSettings = {
  intervalMs: 300_000,
  settleMs: 180_000,
  maxReviewsPerHour: 6,
  repos: [{ repo: 'acme/shop', publish: 'pr', allowExternal: false }],
}
const SLACK: SlackSettings = {
  channels: [
    { id: 'C1', publish: 'pr', reply: 'link' },
    { id: 'C2', publish: 'none', reply: 'full' },
  ],
  emojis: DEFAULT_SLACK_EMOJIS,
}
const PULL: PullFacts = {
  repo: 'acme/shop',
  number: 7,
  headSha: A,
  state: 'open',
  private: false,
  association: 'MEMBER',
}
const message = (overrides: Record<string, unknown> = {}) => ({
  type: 'message',
  channel: 'C1',
  ts: '100.1',
  user: 'U1',
  text: 'please <https://github.com/acme/shop/pull/7>',
  ...overrides,
})

interface Setup {
  pull?: PullFacts
  failing?: string
}

function setup(history: HistoryStore, { pull = PULL, failing }: Setup = {}) {
  const calls: string[] = []
  const warnings: string[] = []
  const api: SlackWebApi = {
    postMessage: async (channel, thread, text) => {
      calls.push(`post ${channel} ${thread} ${text}`)
    },
    addReaction: async (channel, ts, name) => {
      if (failing !== undefined) throw new Error(failing)
      calls.push(`+${name} ${channel} ${ts}`)
    },
    removeReaction: async (channel, ts, name) => {
      calls.push(`-${name} ${channel} ${ts}`)
    },
    openConnection: async () => 'wss://x',
  }
  const port = slackPort({
    settings: SLACK,
    history,
    submit: {
      history,
      settings: WATCH,
      readPull: async () => pull,
      now: () => new Date('2026-10-23T12:00:00.000Z'),
    },
    api,
    warning: (text) => warnings.push(text),
  })
  return { port, calls, warnings }
}

const STARTED = '2026-10-23T12:01:00.000Z'
const FINISHED = '2026-10-23T12:05:00.000Z'

function slackJob(history: HistoryStore, job: Partial<JobRecord> = {}, channel = 'C1'): JobRecord {
  const record: Omit<JobRecord, 'id'> = {
    repo: 'acme/shop',
    number: 7,
    headSha: A,
    status: 'queued',
    attempts: 0,
    notBefore: STARTED,
    publish: 'pr',
    createdAt: STARTED,
    ...job,
  }
  const id = history.addJob(record)
  history.addRequest({
    jobId: id,
    source: 'slack',
    publish: record.publish ?? 'pr',
    data: { channel, ts: '100.1', thread: '100.1' },
    createdAt: STARTED,
  })
  return { ...record, id }
}

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    jobId: 1,
    source: 'watch',
    repo: 'acme/shop',
    number: 7,
    headSha: A,
    startedAt: STARTED,
    finishedAt: FINISHED,
    status: 'published',
    aiCalled: true,
    ...overrides,
  }
}

describe('slackPort', () => {
  it('turns a pull request link in a listed channel into a request and marks it queued', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)

    await port.onMessage(message())

    expect(calls).toEqual(['+hourglass_flowing_sand C1 100.1'])
    expect(history.requests([1])).toMatchObject([
      { source: 'slack', publish: 'pr', data: { channel: 'C1', ts: '100.1', thread: '100.1' } },
    ])
    history.close()
  })

  it('uses the publish target of the channel and answers in the thread a message is in', async () => {
    const history = await fresh()
    const { port } = setup(history)

    await port.onMessage(message({ channel: 'C2', ts: '100.5', thread_ts: '100.0' }))

    expect(history.jobs({})[0]?.publish).toBe('none')
    expect(history.requests([1])[0]?.data).toEqual({ channel: 'C2', ts: '100.5', thread: '100.0' })
    history.close()
  })

  it.each([
    ['a channel that is not listed', message({ channel: 'C9' })],
    ['a bot', message({ bot_id: 'B1' })],
    ['an edited message', message({ subtype: 'message_changed' })],
    ['a repository outside watch:', message({ text: '<https://github.com/other/repo/pull/1>' })],
    ['a message without a link', message({ text: 'hello' })],
  ])('stays quiet for %s', async (_case, event) => {
    const history = await fresh()
    const { port, calls } = setup(history)

    await port.onMessage(event)

    expect(calls).toEqual([])
    expect(history.jobs({})).toEqual([])
    history.close()
  })

  it('says in the thread why a request was refused', async () => {
    const history = await fresh()
    const { port, calls } = setup(history, { pull: { ...PULL, state: 'closed' } })

    await port.onMessage(message())

    expect(calls).toEqual([
      'post C1 100.1 :no_entry_sign: Not reviewed: the pull request is closed.',
    ])
    history.close()
  })

  it('answers a commit already reviewed with its verdict and review at once', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)
    slackJob(history, { status: 'done', finishedAt: FINISHED })
    history.addRun(
      run({
        url: 'https://github.com/acme/shop/pull/7#r1',
        verdict: 'clean',
        resultJson: '{"review":{"findings":[],"worthChecking":[]}}',
      }),
    )

    await port.onMessage(message({ ts: '200.1' }))

    expect(calls).toEqual([
      '+white_check_mark C1 200.1',
      'post C1 200.1 :white_check_mark: *No findings* · <https://github.com/acme/shop/pull/7|acme/shop#7> at `aaaaaaa` · <https://github.com/acme/shop/pull/7#r1|review on GitHub>',
    ])
    history.close()
  })

  it('swaps the queued and skipped marks for the verdict and replies in the format of the channel when the job ends', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)
    const job = slackJob(history, { status: 'done', publish: 'none' }, 'C2')
    const finished = run({
      status: 'not-published',
      verdict: 'comments',
      resultJson: JSON.stringify({
        review: {
          summary: 'Adds a spend endpoint.',
          findings: [{ severity: 'P2', file: 'a.ts', line: 2, title: 'Name', why: 'Why.' }],
          worthChecking: [],
        },
      }),
    })

    await port.onJobEvent(
      reviewEvent({ kind: 'finished', job, requests: history.requests([job.id]) }, finished),
    )

    expect(calls).toEqual([
      '-hourglass_flowing_sand C2 100.1',
      '-eyes C2 100.1',
      '+speech_balloon C2 100.1',
      expect.stringContaining(`<https://github.com/acme/shop/blob/${A}/a.ts#L2|a.ts:2> Name`),
    ])
    expect(calls[3]).toMatch(/^post C2 100\.1 :speech_balloon: \*Comments\*/)
    history.close()
  })

  it('marks a commit skipped for failing CI and names the checks that fail in the thread', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)
    const job = slackJob(history, { status: 'skipped', reason: 'ci-failing' })
    const checks = [
      { name: 'build', state: 'passing' },
      { name: 'test', state: 'failing' },
      { name: 'lint', state: 'failing' },
    ]
    const skipped = run({
      status: 'skipped',
      aiCalled: false,
      verdict: 'skipped',
      reason: 'ci-failing',
      resultJson: JSON.stringify({ ci: { state: 'failing', checks } }),
    })

    await port.onJobEvent(
      reviewEvent(
        { kind: 'skipped', job, requests: history.requests([job.id]), reason: 'ci-failing' },
        skipped,
      ),
    )

    expect(calls).toEqual([
      '-hourglass_flowing_sand C1 100.1',
      '+eyes C1 100.1',
      'post C1 100.1 :eyes: *Skipped* · <https://github.com/acme/shop/pull/7|acme/shop#7> at `aaaaaaa`\nCI failing: test, lint. It is reviewed once these checks pass.',
    ])
    history.close()
  })

  it('does nothing when a job of a Slack message starts', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)
    const job = slackJob(history, { status: 'running' })

    await port.onJobEvent(
      reviewEvent({ kind: 'started', job, requests: history.requests([job.id]) }, undefined),
    )

    expect(calls).toEqual([])
    history.close()
  })

  it('does nothing for a job no Slack message asked for', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)
    const job = slackJob(history, { status: 'done' })

    await port.onJobEvent(reviewEvent({ kind: 'finished', job, requests: [] }, undefined))

    expect(calls).toEqual([])
    history.close()
  })

  it('warns and goes on when Slack refuses a call', async () => {
    const history = await fresh()
    const { port, warnings } = setup(history, {
      failing: 'Slack reactions.add failed: not_in_channel',
    })

    await port.onMessage(message())

    expect(warnings).toEqual(['Slack: Slack reactions.add failed: not_in_channel'])
    history.close()
  })
})
