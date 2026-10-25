import { describe, expect, it } from 'vitest'
import {
  claudeSetup,
  configuredAutomation,
  healthyLocal,
  healthySlow,
  homeJob,
  homeRepositories,
  minutesAgo,
  providerReport,
  runningQueue,
  watchedRepository,
} from '../../test/support/home.js'
import { CONFIG_FILE, emptyAutomation, NOW } from '../../test/support/tui.js'
import { recommend } from './home-recommendation.js'
import type { HomeLocal, HomeSlow } from './read-home.js'
import type { ReportedProvider } from './read-provider.js'
import type { QueueView } from './read-queue.js'

type Change = (home: { local: HomeLocal; slow: HomeSlow }) => void

function home(...changes: Change[]) {
  const state = { local: healthyLocal(), slow: healthySlow() }
  for (const change of changes) change(state)
  return recommend(state.local, state.slow, NOW)
}

const invalidConfig: Change = ({ local }) => {
  local.automation = {
    status: 'ready',
    value: { ...emptyAutomation(), configured: true, configError: 'provider: invalid value' },
  }
}
const noToken: Change = ({ slow }) => {
  slow.github = { status: 'ready', value: { source: null } }
}
const noConfig: Change = ({ local }) => {
  local.automation = { status: 'ready', value: emptyAutomation() }
}
const claudeLoggedOut: Change = ({ slow }) => {
  slow.providers = {
    status: 'ready',
    value: providerReport([
      {
        provider: 'claude',
        install: { state: 'installed', version: '2.1.0' },
        login: { state: 'logged-out' },
        chosen: true,
        next: { kind: 'login', command: 'claude auth login' },
      },
    ]),
  }
}
const queue =
  (changes: Partial<QueueView>): Change =>
  ({ local }) => {
    const current = local.queue.status === 'ready' ? local.queue.value : runningQueue()
    local.queue = { status: 'ready', value: { ...current, ...changes } }
  }
const paused = queue({
  pause: { until: '2026-10-25T13:00:00.000Z', reason: 'usage-limit', streak: 1 },
})
const failing = queue({
  failed: [
    {
      job: homeJob(12, { status: 'failed', error: 'claude exited', finishedAt: minutesAgo(30) }),
      requests: [],
    },
    { job: homeJob(9, { status: 'failed', finishedAt: minutesAgo(90) }), requests: [] },
  ],
})
const skippedForCi = queue({
  skippedForCi: [
    {
      job: homeJob(7, { status: 'skipped', ciFailing: ['test', 'lint'] }),
      requests: [],
    },
  ],
})
const withoutIndex: Change = ({ local }) => {
  local.repositories = {
    status: 'ready',
    value: homeRepositories([
      watchedRepository('acme/shop', true),
      watchedRepository('acme/api', false),
      watchedRepository('acme/web', false),
    ]),
  }
}
const watchStopped = queue({ holder: null, nextCycle: null })

describe('recommend', () => {
  it('says to fix an invalid config, naming its file and the error', () => {
    expect(home(invalidConfig, noToken)).toEqual({
      kind: 'fix-config',
      file: CONFIG_FILE,
      error: 'provider: invalid value',
    })
  })

  it('asks for a GitHub token before anything but the config', () => {
    expect(home(noToken, noConfig, claudeLoggedOut, paused)).toEqual({
      kind: 'github-token',
      command: 'gh auth login',
    })
  })

  it('says GitHub refused the token, naming where it came from', () => {
    expect(
      home(({ slow }) => {
        slow.github = {
          status: 'ready',
          value: { source: 'GH_TOKEN', account: { state: 'refused' } },
        }
      }, noConfig),
    ).toEqual({ kind: 'github-refused', source: 'GH_TOKEN', command: 'gh auth login' })
  })

  it('asks for the user config after the token', () => {
    expect(home(noConfig, claudeLoggedOut, paused)).toEqual({
      kind: 'init',
      command: 'phada init --global',
    })
  })

  it('gives the next step of the chosen AI', () => {
    expect(home(claudeLoggedOut, paused, failing)).toEqual({
      kind: 'ai',
      provider: 'claude',
      step: { kind: 'login', command: 'claude auth login' },
      command: 'claude auth login',
    })
  })

  it('reads the chosen AI from the config read now, not from the last check', () => {
    const ollama: ReportedProvider = {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      server: { state: 'running', version: '0.5.0', models: ['llama3:latest'] },
      chosen: false,
      next: null,
    }
    expect(
      home(
        ({ local }) => {
          local.setup = {
            status: 'ready',
            value: {
              ...claudeSetup(),
              choice: { ...claudeSetup().choice, provider: 'ollama', model: 'qwen3' },
            },
          }
        },
        ({ slow }) => {
          slow.providers = {
            status: 'ready',
            value: providerReport([
              {
                provider: 'claude',
                install: { state: 'installed', version: null },
                login: { state: 'logged-out' },
                chosen: true,
                next: { kind: 'login', command: 'claude auth login' },
              },
              ollama,
            ]),
          }
        },
      ),
    ).toEqual({
      kind: 'ai',
      provider: 'ollama',
      step: { kind: 'pull', command: 'ollama pull qwen3' },
      command: 'ollama pull qwen3',
    })
  })

  it('names a paused watch with when it resumes', () => {
    expect(home(paused, failing, skippedForCi)).toEqual({
      kind: 'paused',
      until: '2026-10-25T13:00:00.000Z',
      reason: 'usage-limit',
      command: 'phada watch --status',
    })
  })

  it('offers to retry the latest failed job of the last day', () => {
    expect(home(failing, skippedForCi, withoutIndex)).toEqual({
      kind: 'failed-jobs',
      count: 2,
      ref: 'acme/shop#12',
      error: 'claude exited',
      command: 'phada review acme/shop#12',
    })
  })

  it('leaves out jobs that failed more than a day ago', () => {
    expect(
      home(
        queue({
          failed: [
            {
              job: homeJob(3, { status: 'failed', finishedAt: minutesAgo(25 * 60) }),
              requests: [],
            },
          ],
        }),
      ),
    ).toEqual({ kind: 'review', command: 'phada review owner/repo#N' })
  })

  it('names the jobs skipped for failing CI with their checks', () => {
    expect(home(skippedForCi, withoutIndex, watchStopped)).toEqual({
      kind: 'ci-skipped',
      count: 1,
      ref: 'acme/shop#7',
      failing: ['test', 'lint'],
      command: 'phada review acme/shop#7',
    })
  })

  it('asks to index the first watched repository without an index', () => {
    expect(home(withoutIndex, watchStopped)).toEqual({
      kind: 'index',
      repo: 'acme/api',
      count: 2,
      command: 'phada index acme/api',
    })
  })

  it('asks to start a configured watch that is not running', () => {
    expect(home(watchStopped)).toEqual({ kind: 'watch', command: 'phada watch' })
  })

  it('suggests a review when all is well, or when no watch is configured', () => {
    expect(home()).toEqual({ kind: 'review', command: 'phada review owner/repo#N' })
    expect(
      home(watchStopped, ({ local }) => {
        local.automation = {
          status: 'ready',
          value: { ...configuredAutomation(), watch: null },
        }
      }),
    ).toEqual({ kind: 'review', command: 'phada review owner/repo#N' })
  })

  describe('while a slow check has not answered', () => {
    const githubLoading: Change = ({ slow }) => {
      slow.github = { status: 'loading' }
    }
    const aiLoading: Change = ({ slow }) => {
      slow.providers = { status: 'loading' }
    }

    it('never says all is well', () => {
      expect(home(aiLoading)).toEqual({ kind: 'checking', github: false, ai: true })
      expect(home(githubLoading, aiLoading)).toEqual({ kind: 'checking', github: true, ai: true })
    })

    it('gives no advice the check could outrank', () => {
      expect(home(githubLoading, noConfig)).toEqual({ kind: 'checking', github: true, ai: false })
      expect(home(aiLoading, paused, withoutIndex)).toEqual({
        kind: 'checking',
        github: false,
        ai: true,
      })
    })

    it('still gives the advice it outranks', () => {
      expect(home(githubLoading, aiLoading, invalidConfig)).toMatchObject({ kind: 'fix-config' })
      expect(home(aiLoading, noToken)).toMatchObject({ kind: 'github-token' })
      expect(home(aiLoading, noConfig)).toMatchObject({ kind: 'init' })
    })
  })

  it('goes on past checks that failed, which show their own error', () => {
    expect(
      home(({ slow }) => {
        slow.github = { status: 'failed', error: 'gh crashed' }
        slow.providers = { status: 'failed', error: 'config unreadable' }
      }, watchStopped),
    ).toEqual({ kind: 'watch', command: 'phada watch' })
    expect(
      home(({ slow }) => {
        slow.github = {
          status: 'ready',
          value: { source: 'gh', account: { state: 'failed', error: 'offline' } },
        }
      }),
    ).toEqual({ kind: 'review', command: 'phada review owner/repo#N' })
  })

  it('goes on past local reads that failed, like a newer history file', () => {
    expect(
      home(({ local }) => {
        local.queue = { status: 'failed', error: 'history is newer' }
        local.repositories = { status: 'failed', error: 'history is newer' }
      }),
    ).toEqual({ kind: 'review', command: 'phada review owner/repo#N' })
  })
})
