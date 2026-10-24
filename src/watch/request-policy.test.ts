import { describe, expect, it } from 'vitest'
import type { WatchedRepoSettings } from '../config/watch-settings.js'
import type { JobRecord } from './types.js'
import { decideRequest } from './request-policy.js'
import type { PolicyInput } from './request-policy.js'

const NOW = '2026-10-23T12:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString()
const A = 'a'.repeat(40)
const REPO: WatchedRepoSettings = { repo: 'acme/shop', publish: true, allowExternal: false }

const job = (id: number, overrides: Partial<JobRecord> = {}): JobRecord => ({
  id,
  repo: 'acme/shop',
  number: 7,
  headSha: A,
  status: 'queued',
  attempts: 0,
  notBefore: at(2),
  createdAt: at(-5),
  ...overrides,
})

const input = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  request: { source: 'enqueue', publish: 'pr' },
  repo: REPO,
  pull: {
    repo: 'acme/shop',
    number: 7,
    headSha: A,
    state: 'open',
    private: false,
    association: 'MEMBER',
  },
  jobs: [],
  createdLastHour: [],
  maxPerHour: 6,
  now: NOW,
  ...overrides,
})

describe('decideRequest', () => {
  it('creates a job ready now for a request on a watched pull request', () => {
    expect(decideRequest(input())).toEqual({
      action: 'create',
      job: {
        repo: 'acme/shop',
        number: 7,
        headSha: A,
        status: 'queued',
        attempts: 0,
        notBefore: NOW,
        publish: 'pr',
        createdAt: NOW,
      },
    })
    const silent = decideRequest(input({ request: { source: 'slack', publish: 'none' } }))
    expect(silent.action === 'create' && silent.job.publish).toBe('none')
  })

  it('refuses a repository that is not under watch:', () => {
    expect(decideRequest(input({ repo: undefined }))).toEqual({
      action: 'refuse',
      reason: 'not-watched',
    })
  })

  it('refuses a closed pull request', () => {
    const pull = { ...input().pull, state: 'closed' as const }
    expect(decideRequest(input({ pull }))).toEqual({ action: 'refuse', reason: 'closed' })
  })

  it('refuses an outside author on a public repository unless the repository allows them', () => {
    const pull = { ...input().pull, association: 'CONTRIBUTOR' }
    expect(decideRequest(input({ pull }))).toEqual({ action: 'refuse', reason: 'external' })
    expect(decideRequest(input({ pull, repo: { ...REPO, allowExternal: true } })).action).toBe(
      'create',
    )
    expect(decideRequest(input({ pull: { ...pull, private: true } })).action).toBe('create')
  })

  it('refuses what the when command refused, before joining or counting the hour', () => {
    expect(decideRequest(input({ whenRefusal: 'not the payments team', jobs: [job(3)] }))).toEqual({
      action: 'refuse',
      reason: 'when-command',
      message: 'not the payments team',
    })
    const pull = { ...input().pull, association: 'NONE' }
    expect(decideRequest(input({ pull, whenRefusal: 'x' }))).toEqual({
      action: 'refuse',
      reason: 'external',
    })
  })

  it('joins a queued job of the same commit and makes it ready now', () => {
    const queued = job(3, { publish: 'none' })
    expect(decideRequest(input({ jobs: [queued] }))).toEqual({
      action: 'join',
      jobId: 3,
      readyNow: true,
    })
  })

  it('joins a running job that already publishes, or when the request does not publish', () => {
    const running = job(3, { status: 'running', publish: 'pr' })
    expect(decideRequest(input({ jobs: [running] }))).toEqual({
      action: 'join',
      jobId: 3,
      readyNow: false,
    })
    const silent = job(3, { status: 'running', publish: 'none' })
    expect(
      decideRequest(input({ jobs: [silent], request: { source: 'slack', publish: 'none' } })),
    ).toEqual({ action: 'join', jobId: 3, readyNow: false })
  })

  it('refuses a commit already reviewed and points at its job', () => {
    for (const done of [
      job(3, { status: 'done', publish: 'pr' }),
      job(3, { status: 'skipped', reason: 'already-reviewed', publish: 'pr' }),
      job(3, { status: 'skipped', reason: 'same-diff', publish: 'pr' }),
    ]) {
      expect(decideRequest(input({ jobs: [done] }))).toEqual({
        action: 'refuse',
        reason: 'already-reviewed',
        jobId: 3,
      })
    }
  })

  it('creates a new job when the commit was only reviewed without publishing and the request publishes', () => {
    const silent = job(3, { status: 'done', publish: 'none' })
    expect(decideRequest(input({ jobs: [silent] })).action).toBe('create')
    expect(
      decideRequest(input({ jobs: [silent], request: { source: 'mcp', publish: 'none' } })),
    ).toEqual({ action: 'refuse', reason: 'already-reviewed', jobId: 3 })
  })

  it('treats an older job without a target as the target of its repository', () => {
    const legacy = job(3, { status: 'done' })
    expect(decideRequest(input({ jobs: [legacy] })).action).toBe('refuse')
    expect(decideRequest(input({ jobs: [legacy], repo: { ...REPO, publish: false } })).action).toBe(
      'create',
    )
  })

  it('ignores failed, superseded and closed jobs of the commit', () => {
    const jobs = [
      job(1, { status: 'failed' }),
      job(2, { status: 'superseded' }),
      job(3, { status: 'skipped', reason: 'closed' }),
    ]
    expect(decideRequest(input({ jobs })).action).toBe('create')
  })

  it('refuses a new job once the hour already has the most jobs allowed, and says when it frees', () => {
    const createdLastHour = [at(-50), at(-40), at(-30)]
    expect(decideRequest(input({ createdLastHour, maxPerHour: 3 }))).toEqual({
      action: 'refuse',
      reason: 'hourly-limit',
      until: at(10),
    })
    expect(decideRequest(input({ createdLastHour, maxPerHour: 4 })).action).toBe('create')
  })

  it('never counts the hourly limit against joining a job', () => {
    const createdLastHour = [at(-50), at(-40), at(-30)]
    expect(decideRequest(input({ createdLastHour, maxPerHour: 3, jobs: [job(3)] })).action).toBe(
      'join',
    )
  })
})
