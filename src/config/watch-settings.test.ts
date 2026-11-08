import { describe, expect, it } from 'vitest'
import type { ConfigLayer } from './types.js'
import { durationMs } from './duration.js'
import {
  historyEnabled,
  missBots,
  resolveHookSettings,
  resolveSlackSettings,
  resolveWatchSettings,
} from './watch-settings.js'

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
      repos: [{ repo: 'acme/shop', publish: 'pr', allowExternal: false, replies: 'auto' }],
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
          publish: 'none',
          allowExternal: false,
          replies: 'off',
          authors: ['Alice'],
          labels: ['x'],
          baseBranches: ['main'],
        },
      ],
    })
  })

  it('answers replies where the repository publishes, unless a mode is set', () => {
    const settings = resolveWatchSettings([
      user({
        watch: {
          replies: 'mention',
          repos: [
            'a/plain',
            { repo: 'a/silent', publish: false },
            { repo: 'a/own', replies: 'off' },
            { repo: 'a/asked', publish: false, replies: 'auto' },
          ],
        },
      }),
    ])

    expect(settings?.repos.map(({ repo, replies }) => [repo, replies])).toEqual([
      ['a/plain', 'mention'],
      ['a/silent', 'off'],
      ['a/own', 'off'],
      ['a/asked', 'auto'],
    ])
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

describe('missBots', () => {
  it('joins the bots of the top-level and the per-repository user config, never the repository', () => {
    const layers: ConfigLayer[] = [
      user({ misses: { bots: ['review-bot', 'lint-bot'] } }),
      { ...user({ misses: { bots: ['lint-bot', 'shop-bot'] } }), kind: 'user-repo' },
      { ...user({ misses: { bots: ['planted-bot'] } }), kind: 'repo-root' },
    ]

    expect(missBots(layers)).toEqual(['review-bot', 'lint-bot', 'shop-bot'])
    expect(missBots([user({})])).toEqual([])
  })
})

describe('resolveHookSettings', () => {
  it('is undefined without hooks', () => {
    expect(resolveHookSettings([user({})])).toBeUndefined()
  })

  it('reads the commands, runs them in the config folder and waits 30 s by default', () => {
    const layer = { ...user({ hooks: { 'review.finished': './notify.sh' } }), dir: '/cfg' }
    expect(resolveHookSettings([layer])).toEqual({
      commands: { 'review.finished': './notify.sh' },
      timeoutMs: 30_000,
      cwd: '/cfg',
    })
  })

  it('takes the timeout from the config', () => {
    expect(
      resolveHookSettings([user({ hooks: { 'review.failed': 'x', timeout: '2m' } })])?.timeoutMs,
    ).toBe(120_000)
  })
})

describe('resolveWatchSettings when', () => {
  it('gives every repository the when command of the watch, unless it has its own', () => {
    const settings = resolveWatchSettings([
      user({
        watch: {
          when: { command: './only-team.sh' },
          repos: ['a/b', { repo: 'a/c', when: { command: './c.sh' } }],
        },
      }),
    ])
    expect(settings?.repos).toEqual([
      { repo: 'a/b', publish: 'pr', allowExternal: false, replies: 'auto', when: './only-team.sh' },
      { repo: 'a/c', publish: 'pr', allowExternal: false, replies: 'auto', when: './c.sh' },
    ])
  })
})

describe('resolveSlackSettings', () => {
  it('is undefined without slack', () => {
    expect(resolveSlackSettings([user({})])).toBeUndefined()
  })

  it('fills in the target, the reply and the emojis of each channel', () => {
    expect(
      resolveSlackSettings([
        user({
          slack: {
            channels: [{ id: 'C1' }, { id: 'C2', publish: 'none', reply: 'full' }],
            emojis: { clean: 'tada' },
          },
        }),
      ]),
    ).toEqual({
      channels: [
        { id: 'C1', publish: 'pr', reply: 'link' },
        { id: 'C2', publish: 'none', reply: 'full' },
      ],
      emojis: {
        queued: 'hourglass_flowing_sand',
        clean: 'tada',
        comments: 'speech_balloon',
        blocking: 'x',
        failed: 'warning',
        skipped: 'eyes',
      },
    })
  })
})
