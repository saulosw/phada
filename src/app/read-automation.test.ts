import { describe, expect, it } from 'vitest'
import { ConfigError } from '../config/errors.js'
import { parseConfigText } from '../config/parse-config.js'
import type { ConfigLayer } from '../config/types.js'
import { readAutomation } from './read-automation.js'
import type { AutomationReaders } from './read-automation.js'

const CONFIG_FILE = '/cfg/config.yml'

function topLevel(yaml: string): ConfigLayer[] {
  const parsed = parseConfigText(yaml)
  if (!parsed.ok) throw new Error(parsed.message)
  return [{ kind: 'user', dir: '', configLabel: 'user:config.yml', config: parsed.config }]
}

function readers(changes: Partial<AutomationReaders> = {}): AutomationReaders {
  return {
    configFile: CONFIG_FILE,
    topLevelLayers: async () => [],
    slackTokens: () => ({ bot: false, app: false }),
    ...changes,
  }
}

const EVERYTHING = [
  'ci:',
  '  wait: 10m',
  '  onFailure: skip',
  '  checks: [build, "test-*"]',
  'watch:',
  '  interval: 2m',
  '  maxReviewsPerHour: 3',
  '  when:',
  '    command: ./gate.sh',
  '  repos:',
  '    - acme/shop',
  '    - repo: acme/api',
  '      when:',
  '        command: ./api-gate.sh',
  'hooks:',
  '  review.finished: ./notify.sh',
  '  review.failed: ./page.sh',
  '  timeout: 45s',
  'slack:',
  '  channels:',
  '    - C0123ABCD',
  '    - id: C0456EFGH',
  '      publish: none',
  '      reply: full',
  '',
].join('\n')

describe('readAutomation', () => {
  it('shows the watch, the CI wait, the request sources, the hooks and the when commands', async () => {
    const view = await readAutomation(
      readers({
        topLevelLayers: async () => topLevel(EVERYTHING),
        slackTokens: () => ({ bot: true, app: false }),
      }),
    )

    expect(view).toEqual({
      configFile: CONFIG_FILE,
      configured: true,
      configError: null,
      watch: {
        intervalMs: 120_000,
        settleMs: 180_000,
        maxReviewsPerHour: 3,
        repos: ['acme/shop', 'acme/api'],
      },
      ci: [
        { key: 'ci.read', value: { kind: 'flag', on: true }, origin: 'default' },
        { key: 'ci.wait', value: { kind: 'duration', ms: 600_000 }, origin: 'global' },
        { key: 'ci.onFailure', value: { kind: 'text', text: 'skip' }, origin: 'global' },
        { key: 'ci.checks', value: { kind: 'list', items: ['build', 'test-*'] }, origin: 'global' },
      ],
      sources: {
        prComments: true,
        enqueue: true,
        mcp: true,
        slack: {
          channels: [
            { id: 'C0123ABCD', publish: 'pr', reply: 'link' },
            { id: 'C0456EFGH', publish: 'none', reply: 'full' },
          ],
          tokens: { bot: true, app: false },
        },
      },
      hooks: {
        events: [
          { event: 'review.started', command: null },
          { event: 'review.finished', command: './notify.sh' },
          { event: 'review.failed', command: './page.sh' },
          { event: 'review.skipped', command: null },
        ],
        timeoutMs: 45_000,
      },
      when: { global: './gate.sh', repos: [{ repo: 'acme/api', command: './api-gate.sh' }] },
    })
  })

  it('has every automation off without a config', async () => {
    expect(await readAutomation(readers())).toEqual({
      configFile: CONFIG_FILE,
      configured: false,
      configError: null,
      watch: null,
      ci: [
        { key: 'ci.read', value: { kind: 'flag', on: true }, origin: 'default' },
        { key: 'ci.wait', value: { kind: 'duration', ms: 900_000 }, origin: 'default' },
        { key: 'ci.onFailure', value: { kind: 'text', text: 'review' }, origin: 'default' },
        { key: 'ci.checks', value: null, origin: 'default' },
      ],
      sources: { prComments: false, enqueue: false, mcp: false, slack: null },
      hooks: null,
      when: { global: null, repos: [] },
    })
  })

  it('turns an invalid config into a message', async () => {
    const view = await readAutomation(
      readers({
        topLevelLayers: async () => {
          throw new ConfigError(
            'Invalid config /cfg/config.yml: hooks.timeout: must be 10m at most',
          )
        },
      }),
    )

    expect(view).toMatchObject({
      configured: true,
      configError: 'Invalid config /cfg/config.yml: hooks.timeout: must be 10m at most',
      watch: null,
      hooks: null,
      sources: { prComments: false, enqueue: false, mcp: false, slack: null },
    })
  })
})
