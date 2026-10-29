import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { QueueJob, QueueView } from '../../app/read-queue.js'
import {
  emptyQueue,
  frameLines,
  KEYS,
  minutesFrom,
  NOW,
  renderApp,
  visibleWidth,
} from '../../../test/support/tui.js'
import type { TerminalSize } from '../terminal-size.js'
import { SCREENS } from '../screens.js'
import { QueueScreen } from './queue.js'

afterEach(() => cleanup())

const at = (minutes: number) => minutesFrom(NOW, minutes)
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'

function job(
  id: number,
  changes: Partial<QueueJob['job']> = {},
  requests: QueueJob['requests'] = [],
): QueueJob {
  return {
    job: {
      id,
      repo: 'acme/shop',
      number: id,
      headSha: SHA,
      status: 'queued',
      attempts: 0,
      notBefore: at(-1),
      createdAt: at(-5),
      ...changes,
    },
    requests,
  }
}

function busyQueue(): QueueView {
  return {
    ...emptyQueue(),
    recorded: true,
    holder: { pid: 4242 },
    pause: { until: at(12), reason: 'usage-limit', streak: 2 },
    hourly: { count: 2, max: 6 },
    lastCycleAt: at(-2),
    nextCycle: { at: at(3), estimated: true },
    running: [
      job(12, { status: 'running', startedAt: at(-3) }, [
        { id: 1, jobId: 12, source: 'watch', publish: 'pr', createdAt: at(-6) },
        {
          id: 2,
          jobId: 12,
          source: 'pr-command',
          publish: 'pr',
          data: {
            author: 'ana',
            url: 'https://github.com/acme/shop/pull/12#issuecomment-9',
            commentId: 9,
          },
          createdAt: at(-4),
        },
        {
          id: 3,
          jobId: 12,
          source: 'slack',
          publish: 'none',
          data: { channel: 'C0123', ts: '1.2', thread: '1.2' },
          createdAt: at(-2),
        },
      ]),
    ],
    queue: [
      job(14, { notBefore: at(2), attempts: 1 }),
      job(15, {
        repo: 'acme/api',
        status: 'waiting',
        ciDeadline: at(14),
        ciPending: ['build', 'test'],
      }),
    ],
    skippedForCi: [
      job(7, { repo: 'acme/api', status: 'skipped', ciFailing: ['lint'], ciCheckedAt: at(-5) }),
    ],
    failed: [
      job(2, {
        repo: 'acme/web',
        status: 'failed',
        finishedAt: at(-120),
        errorKind: 'definitive',
        error: 'The pull request diff is too large',
      }),
    ],
  }
}

function openQueue(
  read: () => Promise<QueueView>,
  options: { size?: TerminalSize; language?: string } = {},
) {
  return renderApp({
    deps: {
      readQueue: read,
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: options.size ?? { columns: 80, rows: 24 },
    screens: [{ id: 'queue', title: (m) => m.screens.queue, Screen: QueueScreen }],
  })
}

function expectFits(frame: string, size: TerminalSize) {
  const lines = frameLines(frame)
  expect(lines).toHaveLength(size.rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns)
}

describe('the Queue screen', () => {
  it('is the Queue tab of the app', () => {
    expect(SCREENS.find(({ id }) => id === 'queue')?.Screen).toBe(QueueScreen)
  })

  it('says how to start a watch when none ever ran', async () => {
    const { frame, showing } = openQueue(async () => emptyQueue())
    await showing('No watch has run here yet.')
    expect(frame()).toContain('Watch not running')
    expect(frame()).toContain('No watch has run here yet.')
    expect(frame()).toContain('Watch not running · w starts it')
  })

  it('says the watch is not configured and how to set it up, never to start it', async () => {
    const { frame, showing } = openQueue(async () => ({ ...emptyQueue(), watchConfigured: false }))
    await showing('Watch not configured')
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(text).toContain('Watch not configured')
    expect(text).toContain('Add watch.repos to ~/.config/phada/config.yml, then run phada watch')
    expect(text).not.toContain('w starts it')
  })

  it('shows the running watch, its cycles, pause, hourly count and every kind of job in 80×24', async () => {
    const { frame, showing } = openQueue(async () => busyQueue())
    await showing('Watch running', 'acme/web#2', 'Enter open')
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(text).toContain(
      'Watch running in another terminal · PID 4242 · last cycle 2m ago · next in ~3m',
    )
    expect(text).toMatch(/Paused until \S+ \S+ \(in 12m\): the AI provider's usage limit/)
    expect(text).toContain('Reviews in the last hour: 2 of 6')
    const rows = frameLines(text)
    const row = (ref: string) => rows.find((line) => line.includes(ref)) ?? ''
    expect(row('acme/shop#12')).toMatch(
      /❯ running\s+acme\/shop#12\s+a1b2c3d\s+started 3m ago · asked from \/phada review/,
    )
    expect(row('acme/api#15')).toMatch(
      /waiting\s+acme\/api#15\s+a1b2c3d\s+CI until in 14m · 2 pending: build, test/,
    )
    expect(row('acme/shop#14')).toMatch(
      /queued\s+acme\/shop#14\s+a1b2c3d\s+starts in 2m · attempt 2/,
    )
    expect(row('acme/api#7')).toMatch(
      /CI failing\s+acme\/api#7\s+a1b2c3d\s+failing: lint · checked 5m ago/,
    )
    expect(row('acme/web#2')).toMatch(
      /failed\s+acme\/web#2\s+a1b2c3d\s+2h ago · definitive: The pull/,
    )
    expect(rows.indexOf(row('#12'))).toBeLessThan(rows.indexOf(row('#15')))
    expect(rows.indexOf(row('#15'))).toBeLessThan(rows.indexOf(row('#14')))
    expect(rows.indexOf(row('#14'))).toBeLessThan(rows.indexOf(row('#7')))
    expect(rows.indexOf(row('#7'))).toBeLessThan(rows.indexOf(row('#2')))
  })

  it('shows a watch whose lock is gone as stopped, with its leftover jobs and how to start it', async () => {
    const { frame, showing } = openQueue(async () => ({
      ...busyQueue(),
      holder: null,
      nextCycle: null,
      pause: null,
    }))
    await showing('Watch not running', 'acme/shop#12')
    expect(frame()).toContain('Watch not running · last cycle 2m ago · w starts it')
    expect(frame()).not.toContain('Paused')
    expect(frame()).toContain('acme/shop#12')
  })

  it('says the queue is empty while the watch runs', async () => {
    const { frame, showing } = openQueue(async () => ({
      ...emptyQueue(),
      recorded: true,
      holder: { pid: 1000 },
      lastCycleAt: at(-1),
      nextCycle: { at: at(-1), estimated: true },
    }))
    await showing('next any moment', 'Nothing in the queue.')
    expect(frame()).toContain('next any moment')
    expect(frame()).toContain('Nothing in the queue.')
  })

  it('opens a job with its requests, where they came from and when, and goes back with Esc', async () => {
    const { frame, press, showing, exits } = openQueue(async () => busyQueue())
    await showing('acme/shop#12', 'Enter open')
    await press(KEYS.enter)
    await showing('Requests (3)', 'Esc back')
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(text).toContain('acme/shop#12 · a1b2c3d · running')
    expect(text).toMatch(/Started\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(3m ago\)/)
    expect(text).toContain('Requests (3)')
    expect(text).toMatch(/watch\s+on the pull request · 6m ago/)
    expect(text).toMatch(/\/phada review\s+@ana · on the pull request · 4m ago/)
    expect(text).toContain('https://github.com/acme/shop/pull/12#issuecomment-9')
    expect(text).toMatch(/Slack\s+channel C0123 · not published · 2m ago/)
    await press(KEYS.escape)
    await showing('Watch running')
    expect(frame()).toContain('Watch running')
    expect(exits).toEqual([])
  })

  it('opens a waiting job with its deadline, its pending checks and a failed one with its error', async () => {
    const { frame, press, showing } = openQueue(async () => busyQueue())
    await showing('acme/api#15', 'Enter open')
    await press(KEYS.down, KEYS.enter)
    await showing('acme/api#15 · a1b2c3d · waiting for CI', 'Esc back')
    expect(frame()).toContain('acme/api#15 · a1b2c3d · waiting for CI')
    expect(frame()).toMatch(/CI deadline\s+\S+ \S+ \(in 14m\)/)
    expect(frame()).toMatch(/Pending\s+build, test/)
    await press(KEYS.escape)
    await showing('Enter open')
    await press(KEYS.down, KEYS.down, KEYS.down, KEYS.enter)
    await showing('acme/web#2 · a1b2c3d · failed', 'Esc back')
    expect(frame()).toContain('acme/web#2 · a1b2c3d · failed')
    expect(frame()).toMatch(/Error\s+definitive: The pull request diff is too large/)
  })

  it('scrolls a long queue within 80×24', async () => {
    const queue = Array.from({ length: 40 }, (_, index) => job(100 + index))
    const { frame, press, showing } = openQueue(async () => ({ ...busyQueue(), queue }))
    await showing(/1–\d+ of 43/, 'Enter open')
    expectFits(frame(), { columns: 80, rows: 24 })
    expect(frame()).toMatch(/1–\d+ of 43/)
    await press(KEYS.end)
    await showing('❯ failed')
    expect(frame()).toMatch(/\d+–43 of 43/)
    expect(frame()).toContain('❯ failed')
    expectFits(frame(), { columns: 80, rows: 24 })
  })

  it('reads the queue again every 2 seconds', async () => {
    let view = emptyQueue()
    const { frame, clock, showing } = openQueue(async () => view)
    await showing('No watch has run here yet.')
    expect(frame()).toContain('No watch has run here yet.')
    view = busyQueue()
    clock.advance(2000)
    await showing('acme/shop#12')
    expect(frame()).toContain('acme/shop#12')
  })

  it('fits a wide terminal', async () => {
    const size = { columns: 160, rows: 40 }
    const { frame, showing } = openQueue(async () => busyQueue(), { size })
    await showing('Watch running', 'acme/web#2')
    expectFits(frame(), size)
    expect(frame()).toContain('definitive: The pull request diff is too large')
    expect(frame()).toContain('asked from /phada review, Slack')
  })

  it('is translated', async () => {
    const { frame, showing } = openQueue(async () => busyQueue(), { language: 'pt' })
    await showing('Watch rodando', 'Reviews na última hora')
    expect(frame()).toContain('Watch rodando em outro terminal · PID 4242 · último ciclo há 2m')
    expect(frame()).toContain('Reviews na última hora: 2 de 6')
  })

  it('shows a history it cannot read as one line', async () => {
    const { frame, showing } = openQueue(async () => {
      throw new Error('history.sqlite was written by a newer Phada')
    })
    await showing('Could not load')
    expect(frame()).toContain('Could not load: history.sqlite was written by a newer Phada')
  })
})
