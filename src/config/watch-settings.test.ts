import { describe, expect, it } from 'vitest'
import type { ConfigLayer } from './types.js'
import { durationMs } from './duration.js'
import { historyEnabled, resolveWatchSettings } from './watch-settings.js'

const user = (config: ConfigLayer['config']): ConfigLayer => ({
  kind: 'user',
  dir: '',
  configLabel: 'user:config.yml',
  config,
})

describe('durationMs', () => {
  it.each([
    ['90s', 90_000],
    ['5m', 300_000],
    ['1h', 3_600_000],
    ['0s', 0],
  ])('reads %s', (text, ms) => {
    expect(durationMs(text)).toBe(ms)
  })
})

describe('resolveWatchSettings', () => {
  it('is undefined without a watch block', () => {
    expect(resolveWatchSettings([user({})])).toBeUndefined()
  })

  it('fills in the defaults and lowercases repositories', () => {
    expect(resolveWatchSettings([user({ watch: { repos: ['Acme/Shop'] } })])).toEqual({
      intervalMs: 300_000,
      settleMs: 180_000,
      maxReviewsPerHour: 6,
      repos: [{ repo: 'acme/shop', publish: true, allowExternal: false }],
    })
  })

  it('keeps the filters of a repository', () => {
    const settings = resolveWatchSettings([
      user({
        watch: {
          interval: '1h',
          settle: '0s',
          maxReviewsPerHour: 2,
          repos: [
            {
              repo: 'a/b',
              publish: false,
              authors: ['Alice'],
              labels: ['x'],
              baseBranches: ['main'],
            },
          ],
        },
      }),
    ])

    expect(settings).toEqual({
      intervalMs: 3_600_000,
      settleMs: 0,
      maxReviewsPerHour: 2,
      repos: [
        {
          repo: 'a/b',
          publish: false,
          allowExternal: false,
          authors: ['Alice'],
          labels: ['x'],
          baseBranches: ['main'],
        },
      ],
    })
  })

  it('reads only the top-level user config', () => {
    const repoLayer: ConfigLayer = { ...user({ watch: { repos: ['a/b'] } }), kind: 'user-repo' }

    expect(resolveWatchSettings([repoLayer])).toBeUndefined()
  })
})

describe('historyEnabled', () => {
  it('is on unless the top-level user config turns it off', () => {
    expect(historyEnabled([])).toBe(true)
    expect(historyEnabled([user({ history: false })])).toBe(false)
    expect(historyEnabled([{ ...user({ history: false }), kind: 'repo-root' }])).toBe(true)
  })
})
