import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SLACK_EMOJIS } from '../config/watch-settings.js'
import type { SlackSettings, WatchSettings } from '../config/watch-settings.js'
import type { SlackWebApi } from '../slack/web-api.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import type { PullFacts } from '../watch/request-policy.js'
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
  repos: [{ repo: 'acme/shop', publish: true, allowExternal: false }],
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

function setup(history: HistoryStore, pull: PullFacts = PULL) {
  const calls: string[] = []
  const warnings: string[] = []
  const api: SlackWebApi = {
    postMessage: async (channel, thread, text) => {
      calls.push(`post ${channel} ${thread} ${text}`)
    },
    addReaction: async (channel, ts, name) => {
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
    const { port, calls } = setup(history, { ...PULL, state: 'closed' })

    await port.onMessage(message())

    expect(calls).toEqual([
      'post C1 100.1 :no_entry_sign: Not reviewed: the pull request is closed.',
    ])
    history.close()
  })

  it('answers a commit already reviewed with its verdict and review at once', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)
    await port.onMessage(message())
    history.updateJob(1, { status: 'done', finishedAt: '2026-10-23T12:05:00.000Z' })
    history.addRun({
      jobId: 1,
      source: 'watch',
      repo: 'acme/shop',
      number: 7,
      headSha: A,
      startedAt: '2026-10-23T12:01:00.000Z',
      finishedAt: '2026-10-23T12:05:00.000Z',
      status: 'published',
      url: 'https://github.com/acme/shop/pull/7#r1',
      aiCalled: true,
      verdict: 'clean',
      resultJson: '{"review":{"findings":[],"worthChecking":[]}}',
    })
    calls.length = 0

    await port.onMessage(message({ ts: '200.1' }))

    expect(calls).toEqual([
      '+white_check_mark C1 200.1',
      'post C1 200.1 :white_check_mark: *No findings* · <https://github.com/acme/shop/pull/7|acme/shop#7> at `aaaaaaa` · <https://github.com/acme/shop/pull/7#r1|review on GitHub>',
    ])
    history.close()
  })

  it('swaps the queued mark for the verdict and replies in the format of the channel when the job ends', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)
    await port.onMessage(message({ channel: 'C2' }))
    calls.length = 0
    const job = { ...history.job(1)!, status: 'done' as const }
    const run = {
      jobId: 1,
      source: 'watch' as const,
      repo: 'acme/shop',
      number: 7,
      headSha: A,
      startedAt: '2026-10-23T12:01:00.000Z',
      finishedAt: '2026-10-23T12:05:00.000Z',
      status: 'not-published' as const,
      aiCalled: true,
      verdict: 'comments' as const,
      resultJson: JSON.stringify({
        review: {
          summary: 'Adds a spend endpoint.',
          findings: [{ severity: 'P2', file: 'a.ts', line: 2, title: 'Name', why: 'Why.' }],
          worthChecking: [],
        },
      }),
    }
    const requests = history.requests([1])

    await port.onJobEvent(reviewEvent({ kind: 'finished', job, requests }, run))

    expect(calls[0]).toBe('-hourglass_flowing_sand C2 100.1')
    expect(calls[1]).toBe('+speech_balloon C2 100.1')
    expect(calls[2]).toContain(`post C2 100.1 :speech_balloon: *Comments*`)
    expect(calls[2]).toContain(`<https://github.com/acme/shop/blob/${A}/a.ts#L2|a.ts:2> Name`)
    expect(calls).toHaveLength(3)
    history.close()
  })

  it('does nothing for a job event no Slack message asked for, nor when it starts', async () => {
    const history = await fresh()
    const { port, calls } = setup(history)
    await port.onMessage(message())
    calls.length = 0
    const job = history.job(1)!

    await port.onJobEvent(
      reviewEvent({ kind: 'started', job, requests: history.requests([1]) }, undefined),
    )
    await port.onJobEvent(reviewEvent({ kind: 'finished', job, requests: [] }, undefined))

    expect(calls).toEqual([])
    history.close()
  })

  it('warns and goes on when Slack refuses a call', async () => {
    const history = await fresh()
    const { port, warnings } = setup(history)
    const failing = slackPort({
      settings: SLACK,
      history,
      submit: {
        history,
        settings: WATCH,
        readPull: async () => PULL,
        now: () => new Date('2026-10-23T12:00:00.000Z'),
      },
      api: {
        postMessage: async () => undefined,
        addReaction: async () => {
          throw new Error('Slack reactions.add failed: not_in_channel')
        },
        removeReaction: async () => undefined,
        openConnection: async () => 'wss://x',
      },
      warning: (text) => warnings.push(text),
    })
    void port

    await failing.onMessage(message())

    expect(warnings).toEqual(['Slack: Slack reactions.add failed: not_in_channel'])
    history.close()
  })
})
