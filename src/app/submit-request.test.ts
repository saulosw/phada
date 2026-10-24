import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { WatchSettings } from '../config/watch-settings.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import type { PullFacts } from '../watch/pull-facts.js'
import { submitRequest } from './submit-request.js'
import type { SubmitDeps } from './submit-request.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-app-submit-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0
const fresh = () => openHistoryStore(join(dir, `h${++files}`, 'history.sqlite'))

const NOW = '2026-10-23T12:00:00.000Z'
const A = 'a'.repeat(40)
const SETTINGS: WatchSettings = {
  intervalMs: 300_000,
  settleMs: 180_000,
  maxReviewsPerHour: 6,
  repos: [{ repo: 'acme/shop', publish: true, allowExternal: false }],
}
const PULL: PullFacts = {
  repo: 'acme/shop',
  number: 7,
  headSha: A,
  state: 'open',
  private: false,
  association: 'MEMBER',
}

function deps(history: HistoryStore, overrides: Partial<SubmitDeps> = {}) {
  const reads: string[] = []
  const value: SubmitDeps = {
    history,
    settings: SETTINGS,
    readPull: async (repo, number) => {
      reads.push(`${repo}#${number}`)
      return PULL
    },
    now: () => new Date(NOW),
    ...overrides,
  }
  return { deps: value, reads }
}

const REQUEST = { repo: 'acme/shop', number: 7, source: 'enqueue', publish: 'pr' } as const

describe('submitRequest', () => {
  it('queues a job with the request attached', async () => {
    const history = await fresh()
    const result = await submitRequest(REQUEST, deps(history).deps)

    expect(result).toMatchObject({
      status: 'queued',
      job: { repo: 'acme/shop', number: 7, headSha: A, notBefore: NOW, publish: 'pr' },
    })
    const [job] = history.jobs({})
    expect(history.requests([job!.id])).toMatchObject([
      { source: 'enqueue', publish: 'pr', createdAt: NOW },
    ])
    history.close()
  })

  it('joins the queued job of the same commit, makes it ready now and raises its target to pr', async () => {
    const history = await fresh()
    const id = history.addJob({
      repo: 'acme/shop',
      number: 7,
      headSha: A,
      status: 'queued',
      attempts: 0,
      notBefore: '2026-10-23T12:03:00.000Z',
      publish: 'none',
      createdAt: '2026-10-23T11:59:00.000Z',
    })

    const result = await submitRequest(
      { ...REQUEST, source: 'slack', data: { channel: 'C1', ts: '1.2' } },
      deps(history).deps,
    )

    expect(result).toMatchObject({ status: 'joined', job: { id, notBefore: NOW, publish: 'pr' } })
    expect(history.jobs({})).toHaveLength(1)
    expect(history.requests([id])).toMatchObject([
      { source: 'slack', data: { channel: 'C1', ts: '1.2' } },
    ])
    history.close()
  })

  it('refuses a repository outside watch: without reading the pull request', async () => {
    const history = await fresh()
    const { deps: d, reads } = deps(history)
    const result = await submitRequest({ ...REQUEST, repo: 'other/repo' }, d)

    expect(result).toEqual({ status: 'refused', reason: 'not-watched' })
    expect(reads).toEqual([])
    expect(history.jobs({})).toEqual([])
    history.close()
  })

  it('refuses a commit already reviewed and returns its job', async () => {
    const history = await fresh()
    const id = history.addJob({
      repo: 'acme/shop',
      number: 7,
      headSha: A,
      status: 'done',
      attempts: 0,
      notBefore: NOW,
      publish: 'pr',
      createdAt: '2026-10-23T11:00:00.000Z',
      finishedAt: '2026-10-23T11:05:00.000Z',
    })

    const result = await submitRequest(REQUEST, deps(history).deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'already-reviewed', job: { id } })
    expect(history.requests([id])).toEqual([])
    history.close()
  })

  it('refuses above the hourly limit with the time it frees', async () => {
    const history = await fresh()
    const settings = { ...SETTINGS, maxReviewsPerHour: 1 }
    history.addJob({
      repo: 'acme/shop',
      number: 8,
      headSha: A,
      status: 'done',
      attempts: 0,
      notBefore: NOW,
      createdAt: '2026-10-23T11:30:00.000Z',
    })

    const result = await submitRequest(REQUEST, deps(history, { settings }).deps)

    expect(result).toEqual({
      status: 'refused',
      reason: 'hourly-limit',
      until: '2026-10-23T12:30:00.000Z',
    })
    history.close()
  })

  it('asks the when command with the pull request and the request, and refuses with its message', async () => {
    const history = await fresh()
    const asked: unknown[] = []
    const settings = {
      ...SETTINGS,
      repos: [{ ...SETTINGS.repos[0]!, when: './team.sh' }],
    }
    const result = await submitRequest(
      { ...REQUEST, source: 'slack', data: { channel: 'C1' } },
      deps(history, {
        settings,
        checkWhen: async (command, input) => {
          asked.push([command, input])
          return 'not the payments team'
        },
      }).deps,
    )

    expect(result).toEqual({
      status: 'refused',
      reason: 'when-command',
      message: 'not the payments team',
    })
    expect(asked).toEqual([
      [
        './team.sh',
        {
          schemaVersion: 1,
          pullRequest: { ...PULL, url: 'https://github.com/acme/shop/pull/7' },
          request: { source: 'slack', publish: 'pr', data: { channel: 'C1' } },
        },
      ],
    ])
    expect(history.jobs({})).toEqual([])
    history.close()
  })

  it('does not ask the when command for a request refused before it', async () => {
    const history = await fresh()
    let asked = 0
    const settings = { ...SETTINGS, repos: [{ ...SETTINGS.repos[0]!, when: './team.sh' }] }
    const result = await submitRequest(
      REQUEST,
      deps(history, {
        settings,
        readPull: async () => ({ ...PULL, state: 'closed' }),
        checkWhen: async () => {
          asked += 1
          return undefined
        },
      }).deps,
    )

    expect(result).toEqual({ status: 'refused', reason: 'closed' })
    expect(asked).toBe(0)
    history.close()
  })

  it('joins the queued job of the commit without asking the when command', async () => {
    const history = await fresh()
    let asked = 0
    const settings = { ...SETTINGS, repos: [{ ...SETTINGS.repos[0]!, when: './team.sh' }] }
    const checkWhen = async () => {
      asked += 1
      return undefined
    }
    await submitRequest(REQUEST, deps(history, { settings, checkWhen }).deps)

    const joined = await submitRequest(REQUEST, deps(history, { settings, checkWhen }).deps)

    expect(joined.status).toBe('joined')
    expect(asked).toBe(1)
    history.close()
  })

  it('matches the repository without caring about case', async () => {
    const history = await fresh()
    const result = await submitRequest({ ...REQUEST, repo: 'Acme/Shop' }, deps(history).deps)
    expect(result.status).toBe('queued')
    history.close()
  })
})
