import { describe, expect, it } from 'vitest'
import {
  claudeSetup,
  configuredAutomation,
  healthySlow,
  homeRepositories,
  homeRun,
  runningQueue,
  watchedRepository,
} from '../../test/support/home.js'
import { emptyAutomation, emptyQueue, emptyRepositories, NOW } from '../../test/support/tui.js'
import { HOME_REVIEWS, homeSnapshot, readHomeLocal } from './read-home.js'
import type { HomeReaders } from './read-home.js'

class HistoryVersionError extends Error {}

function readers(overrides: Partial<HomeReaders> = {}) {
  const calls: string[] = []
  const slowCalls: string[] = []
  const base: HomeReaders = {
    readAutomation: async () => {
      calls.push('automation')
      return configuredAutomation()
    },
    readQueue: async () => {
      calls.push('queue')
      return runningQueue()
    },
    readRepositories: async () => {
      calls.push('repositories')
      return homeRepositories([watchedRepository('acme/shop', true)])
    },
    readReviews: async (filter) => {
      calls.push(`reviews ${JSON.stringify(filter)}`)
      return { runs: [homeRun(1)], total: 9 }
    },
    readProviderSetup: async () => {
      calls.push('setup')
      return claudeSetup()
    },
  }
  const slow = {
    readGitHub: async () => {
      slowCalls.push('github')
      throw new Error('slow')
    },
    readProviders: async () => {
      slowCalls.push('providers')
      throw new Error('slow')
    },
  }
  return { readers: { ...base, ...slow, ...overrides }, calls, slowCalls }
}

describe('readHomeLocal', () => {
  it('reads the config, the queue, the repositories, the last reviews and the chosen AI', async () => {
    const { readers: home, calls } = readers()
    const local = await readHomeLocal(home)
    expect(calls.sort()).toEqual(
      ['automation', 'queue', 'repositories', `reviews {"limit":${HOME_REVIEWS}}`, 'setup'].sort(),
    )
    expect(local.reviews).toEqual({ status: 'ready', value: { runs: [homeRun(1)], total: 9 } })
    expect(local.queue).toEqual({ status: 'ready', value: runningQueue() })
  })

  it('never calls a slow reader, however often it runs', async () => {
    const { readers: home, slowCalls } = readers()
    for (let cycle = 0; cycle < 5; cycle += 1) await readHomeLocal(home)
    expect(slowCalls).toEqual([])
  })

  it('keeps each failed read as its own error, like a history file of a newer Phada', async () => {
    const newer = async () => {
      throw new HistoryVersionError('The history file was written by a newer Phada')
    }
    const { readers: home } = readers({
      readQueue: newer,
      readReviews: newer,
      readRepositories: newer,
    })
    const local = await readHomeLocal(home)
    expect(local.queue).toEqual({
      status: 'failed',
      error: 'The history file was written by a newer Phada',
    })
    expect(local.reviews.status).toBe('failed')
    expect(local.repositories.status).toBe('failed')
    expect(local.automation.status).toBe('ready')
    expect(local.setup.status).toBe('ready')
  })
})

describe('homeSnapshot', () => {
  it('opens without config, history or token and says what is missing first', async () => {
    const { readers: home } = readers({
      readAutomation: async () => emptyAutomation(),
      readQueue: async () => emptyQueue(),
      readRepositories: async () => emptyRepositories(),
      readReviews: async () => ({ runs: [], total: 0 }),
    })
    const snapshot = homeSnapshot(
      await readHomeLocal(home),
      { ...healthySlow(), github: { status: 'ready', value: { source: null } } },
      NOW,
    )
    expect(snapshot.recommendation).toEqual({ kind: 'github-token', command: 'gh auth login' })
    expect(snapshot.reviews).toEqual({ status: 'ready', value: { runs: [], total: 0 } })
    expect(snapshot.github).toEqual({ status: 'ready', value: { source: null } })
  })

  it('names the config file and its error when it is invalid', async () => {
    const { readers: home } = readers({
      readAutomation: async () => ({
        ...emptyAutomation(),
        configured: true,
        configError: 'watch.interval: expected a duration',
      }),
      readProviderSetup: async () => {
        throw new Error('watch.interval: expected a duration')
      },
    })
    const snapshot = homeSnapshot(await readHomeLocal(home), healthySlow(), NOW)
    expect(snapshot.recommendation).toMatchObject({
      kind: 'fix-config',
      error: 'watch.interval: expected a duration',
    })
    expect(snapshot.setup.status).toBe('failed')
  })

  it('asks to start the watch when the lock holder is gone', async () => {
    const { readers: home } = readers({
      readQueue: async () => ({ ...runningQueue(), holder: null, nextCycle: null }),
    })
    const snapshot = homeSnapshot(await readHomeLocal(home), healthySlow(), NOW)
    expect(snapshot.recommendation).toEqual({ kind: 'watch', command: 'phada watch' })
  })

  it('asks to index a watched repository whose index file is missing', async () => {
    const { readers: home } = readers({
      readRepositories: async () => homeRepositories([watchedRepository('acme/shop', false)]),
    })
    const snapshot = homeSnapshot(await readHomeLocal(home), healthySlow(), NOW)
    expect(snapshot.recommendation).toEqual({
      kind: 'index',
      repo: 'acme/shop',
      count: 1,
      command: 'phada index acme/shop',
    })
  })
})
