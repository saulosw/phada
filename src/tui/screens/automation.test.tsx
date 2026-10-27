import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationView } from '../../app/read-automation.js'
import {
  CONFIG_FILE,
  emptyAutomation,
  frameLines,
  KEYS,
  renderApp,
  visibleWidth,
} from '../../../test/support/tui.js'
import type { AppDeps } from '../app-context.js'
import type { TerminalSize } from '../terminal-size.js'
import { AutomationScreen } from './automation.js'

afterEach(() => cleanup())

const DEFAULT_CI: AutomationView['ci'] = [
  { key: 'ci.read', value: { kind: 'flag', on: true }, origin: 'default' },
  { key: 'ci.wait', value: { kind: 'duration', ms: 900_000 }, origin: 'default' },
  { key: 'ci.onFailure', value: { kind: 'text', text: 'review' }, origin: 'default' },
  { key: 'ci.checks', value: null, origin: 'default' },
]

function everything(): AutomationView {
  return {
    configFile: CONFIG_FILE,
    configured: true,
    configError: null,
    watch: {
      intervalMs: 120_000,
      settleMs: 180_000,
      maxReviewsPerHour: 3,
      repos: ['acme/shop', 'acme/api', 'acme/web', 'acme/mobile', 'acme/infra', 'acme/docs'],
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
        tokens: {
          bot: { variable: 'PHADA_SLACK_BOT_TOKEN', set: true },
          app: { variable: 'PHADA_SLACK_APP_TOKEN', set: false },
        },
      },
    },
    hooks: {
      events: [
        { event: 'review.started', command: null },
        { event: 'review.finished', command: './notify.sh --channel reviews' },
        { event: 'review.failed', command: './page.sh' },
        { event: 'review.skipped', command: null },
      ],
      timeoutMs: 45_000,
    },
    when: { global: './gate.sh', repos: [{ repo: 'acme/api', command: './api-gate.sh' }] },
  }
}

function openAutomation(
  deps: Partial<AppDeps>,
  options: { size?: TerminalSize; language?: string } = {},
) {
  return renderApp({
    deps: {
      ...deps,
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: options.size ?? { columns: 80, rows: 24 },
    screens: [{ id: 'automation', title: (m) => m.screens.automation, Screen: AutomationScreen }],
  })
}

const flat = (frame: string) => frame.replace(/\s+/g, ' ')

function expectFits(frame: string, size: TerminalSize) {
  const lines = frameLines(frame)
  expect(lines).toHaveLength(size.rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns)
}

describe('AutomationScreen', () => {
  it('shows the watch, the CI wait, the request sources, the hooks and the when commands', async () => {
    const view = openAutomation({ readAutomation: async () => everything() })
    await view.showing('Interval', 'ci.checks')

    const top = view.frame()
    expect(top).toMatch(/Interval\s+2m/)
    expect(top).toMatch(/Settle time\s+3m/)
    expect(top).toMatch(/Reviews per hour\s+3 at most/)
    expect(top).toMatch(/Repositories\s+6: acme\/shop, acme\/api/)
    expect(top).toMatch(/ci\.wait\s+10m\s+global/)
    expect(top).toMatch(/ci\.checks\s+build, test-\*\s+global/)
    expectFits(top, { columns: 80, rows: 24 })

    await view.press(KEYS.end)
    await view.showing('Hooks · timeout 45s', /acme\/api\s+\.\/api-gate\.sh/)
    const end = view.frame()
    expect(end).toMatch(/● \/phada review comments/)
    expect(flat(end)).toContain(
      '○ Slack not ready · 2 channels: C0123ABCD (publishes, link), C0456EFGH (Slack only, full review)',
    )
    expect(end).not.toMatch(/● Slack/)
    expect(flat(end)).toContain('PHADA_SLACK_BOT_TOKEN set · PHADA_SLACK_APP_TOKEN missing')
    expect(end).toContain('Hooks · timeout 45s')
    expect(end).toMatch(/review\.finished\s+\.\/notify\.sh --channel reviews/)
    expect(end).toMatch(/review\.started\s+–/)
    expect(end).toMatch(/every repository\s+\.\/gate\.sh/)
    expect(end).toMatch(/acme\/api\s+\.\/api-gate\.sh/)
    expectFits(end, { columns: 80, rows: 24 })
  })

  it('shows Slack on once both of its tokens are set', async () => {
    const all = everything()
    const slack = all.sources.slack
    if (slack === null) throw new Error('slack expected')
    const view = openAutomation({
      readAutomation: async () => ({
        ...all,
        sources: {
          ...all.sources,
          slack: { ...slack, tokens: { ...slack.tokens, app: { ...slack.tokens.app, set: true } } },
        },
      }),
    })
    await view.showing('Interval')
    await view.press(KEYS.end)
    await view.until(() =>
      flat(view.frame()).includes('PHADA_SLACK_BOT_TOKEN set · PHADA_SLACK_APP_TOKEN set'),
    )
    const end = view.frame()
    expect(flat(end)).toContain('● Slack 2 channels: C0123ABCD (publishes, link)')
    expect(end).not.toContain('not ready')
    expect(flat(end)).toContain('PHADA_SLACK_BOT_TOKEN set · PHADA_SLACK_APP_TOKEN set')
  })

  it('points a fresh machine to phada setup and shows everything off', async () => {
    const view = openAutomation({
      readAutomation: async () => ({ ...emptyAutomation(), ci: DEFAULT_CI }),
    })
    await view.showing('No config yet', /ci\.wait\s+15m\s+default/)

    const frame = view.frame()
    expect(frame).toContain('Create your own config with phada setup')
    expect(flat(frame)).toContain(
      `Off. Add watch.repos to ~/.config/phada/config.yml, then run phada watch.`,
    )
    expect(frame).toMatch(/ci\.wait\s+15m\s+default/)

    await view.press(KEYS.end)
    await view.showing('None: every pull request that passes the filters is reviewed.')
    const end = view.frame()
    expect(end).toMatch(/○ phada enqueue\s+needs watch/)
    expect(end).toMatch(/○ Slack\s+off/)
    expect(flat(end)).toContain(`None. Add hooks to ~/.config/phada/config.yml`)
    expect(end).toContain('None: every pull request that passes the filters is reviewed.')
  })

  it('shows an invalid config on top', async () => {
    const view = openAutomation({
      readAutomation: async () => ({
        ...emptyAutomation(),
        configured: true,
        configError: 'Invalid config /cfg/config.yml: hooks.timeout: must be 10m at most',
        ci: DEFAULT_CI,
      }),
    })
    await view.showing('Invalid config')

    expect(flat(view.frame())).toContain(
      'Invalid config: Invalid config /cfg/config.yml: hooks.timeout: must be 10m at most',
    )
  })

  it('fits a wide terminal and speaks Spanish', async () => {
    const size = { columns: 160, rows: 40 }
    const view = openAutomation(
      { readAutomation: async () => everything() },
      { size, language: 'es' },
    )
    await view.showing('Intervalo', 'Orígenes de solicitudes', 'PHADA_SLACK_APP_TOKEN falta')

    const frame = view.frame()
    expect(frame).toContain('Orígenes de solicitudes')
    expect(frame).toMatch(/Revisiones por hora\s+3 como máximo/)
    expect(frame).toContain('PHADA_SLACK_APP_TOKEN falta')
    expectFits(frame, size)
  })
})
