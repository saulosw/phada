import { describe, expect, it } from 'vitest'
import type { WatchedRepoSettings } from '../config/watch-settings.js'
import type { OpenPull } from '../github/list-pull-requests.js'
import type { JobRecord, PullRecord } from '../store/history-store.js'
import { planCycle } from './plan-cycle.js'
import type { CycleInput } from './plan-cycle.js'

const NOW = '2026-10-18T12:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString()
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const REPO: WatchedRepoSettings = { repo: 'acme/shop', publish: true, allowExternal: false }

const open = (number: number, headSha = A, overrides: Partial<OpenPull> = {}): OpenPull => ({
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
const stored = (number: number, overrides: Partial<PullRecord> = {}): PullRecord => ({
  repo: 'acme/shop',
  number,
  headSha: A,
  headSeenAt: at(-60),
  eligible: true,
  state: 'open',
  ...overrides,
})
const job = (id: number, number: number, overrides: Partial<JobRecord> = {}): JobRecord => ({
  id,
  repo: 'acme/shop',
  number,
  headSha: A,
  status: 'queued',
  attempts: 0,
  notBefore: at(-1),
  createdAt: at(-5),
  ...overrides,
})
const input = (overrides: Partial<CycleInput>): CycleInput => ({
  repo: REPO,
  pulls: [],
  stored: [],
  jobs: [],
  baselineDone: true,
  backfill: false,
  now: NOW,
  settleMs: 180_000,
  ...overrides,
})
const queued = (number: number, headSha: string, notBefore: string) => ({
  kind: 'enqueue',
  job: {
    repo: 'acme/shop',
    number,
    headSha,
    status: 'queued',
    attempts: 0,
    notBefore,
    createdAt: NOW,
  },
})

describe('planCycle', () => {
  it('records the pull requests open on the first cycle as they are, without queueing', () => {
    const actions = planCycle(
      input({ baselineDone: false, pulls: [open(1), open(2, B, { draft: true })] }),
    )

    expect(actions).toEqual([
      {
        kind: 'baseline',
        pulls: [
          { ...stored(1), headSeenAt: NOW, baselineSha: A },
          { ...stored(2), headSha: B, headSeenAt: NOW, eligible: false },
        ],
      },
    ])
  })

  it('queues the open pull requests at once on the first cycle with backfill', () => {
    const actions = planCycle(
      input({ baselineDone: false, backfill: true, pulls: [open(1), open(2, B, { draft: true })] }),
    )

    expect(actions).toEqual([
      { kind: 'seen', pull: { ...stored(1), headSeenAt: NOW } },
      queued(1, A, NOW),
      { kind: 'seen', pull: { ...stored(2), headSha: B, headSeenAt: NOW, eligible: false } },
    ])
  })

  it('queues a new pull request after the settle time', () => {
    expect(planCycle(input({ pulls: [open(3)] }))).toEqual([
      { kind: 'seen', pull: { ...stored(3), headSeenAt: NOW } },
      queued(3, A, at(3)),
    ])
  })

  it('replaces the queued job of an older commit with the new one', () => {
    const actions = planCycle(
      input({ pulls: [open(3, B)], stored: [stored(3)], jobs: [job(7, 3)] }),
    )

    expect(actions).toEqual([
      { kind: 'seen', pull: { ...stored(3), headSha: B, headSeenAt: NOW } },
      { kind: 'supersede', jobId: 7 },
      queued(3, B, at(3)),
    ])
  })

  it.each(['done', 'failed', 'running'] as const)(
    'does nothing for a commit that already has a %s job',
    (status) => {
      expect(
        planCycle(input({ pulls: [open(3)], stored: [stored(3)], jobs: [job(7, 3, { status })] })),
      ).toEqual([])
    },
  )

  it('leaves a pull request of the baseline alone until it gets a new commit', () => {
    const baseline = stored(3, { baselineSha: A })

    expect(planCycle(input({ pulls: [open(3)], stored: [baseline] }))).toEqual([])
    expect(planCycle(input({ pulls: [open(3, B)], stored: [baseline] }))).toEqual([
      { kind: 'seen', pull: { ...baseline, headSha: B, headSeenAt: NOW } },
      queued(3, B, at(3)),
    ])
  })

  it('records a draft without queueing it, and queues it once it is ready', () => {
    const first = planCycle(input({ now: at(-30), pulls: [open(3, A, { draft: true })] }))
    expect(first).toEqual([
      { kind: 'seen', pull: { ...stored(3), headSeenAt: at(-30), eligible: false } },
    ])

    const ready = planCycle(
      input({ pulls: [open(3)], stored: [stored(3, { headSeenAt: at(-30), eligible: false })] }),
    )

    expect(ready).toEqual([
      { kind: 'seen', pull: { ...stored(3), headSeenAt: at(-30) } },
      queued(3, A, at(3)),
    ])
  })

  it('counts the settle time from when the commit was first seen', () => {
    const seen = stored(3, { headSha: B, headSeenAt: at(-2) })

    expect(planCycle(input({ pulls: [open(3, B)], stored: [seen] }))).toEqual([queued(3, B, at(1))])
  })

  it('marks a pull request that is no longer open as gone with its queued jobs', () => {
    const jobs = [job(7, 3), job(8, 3, { status: 'done' })]

    expect(planCycle(input({ stored: [stored(3)], jobs }))).toEqual([
      { kind: 'gone', pull: { ...stored(3), state: 'gone' }, jobIds: [7] },
    ])
    expect(planCycle(input({ stored: [stored(3, { state: 'gone' })] }))).toEqual([])
  })

  it('takes a pull request back when it opens again', () => {
    const actions = planCycle(
      input({ pulls: [open(3, B)], stored: [stored(3, { state: 'gone' })] }),
    )

    expect(actions).toEqual([
      { kind: 'seen', pull: { ...stored(3), headSha: B, headSeenAt: NOW } },
      queued(3, B, at(3)),
    ])
  })

  it('queues a pull request that was a draft at the baseline once it is ready', () => {
    const [baseline] = planCycle(
      input({ baselineDone: false, pulls: [open(3, A, { draft: true })] }),
    )
    const stored = baseline?.kind === 'baseline' ? baseline.pulls : []

    expect(stored).toEqual([{ ...stored[0], eligible: false }])
    expect(stored[0]?.baselineSha).toBeUndefined()
    expect(planCycle(input({ pulls: [open(3)], stored }))).toEqual([
      { kind: 'seen', pull: { ...stored[0], eligible: true } },
      queued(3, A, at(3)),
    ])
  })

  it('queues again a commit whose job was skipped because the pull request was closed or a draft', () => {
    const jobs = [job(7, 3, { status: 'skipped', reason: 'closed' })]

    expect(planCycle(input({ pulls: [open(3)], stored: [stored(3)], jobs }))).toEqual([
      queued(3, A, at(-57)),
    ])
  })

  it('never queues again a commit skipped because Phada already reviewed it', () => {
    const jobs = [job(7, 3, { status: 'skipped', reason: 'already-reviewed' })]

    expect(planCycle(input({ pulls: [open(3)], stored: [stored(3)], jobs }))).toEqual([])
  })
})
