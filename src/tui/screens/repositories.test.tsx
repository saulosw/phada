import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { ListedRun } from '../../app/read-history.js'
import type { RepositoryDetail, RepositoryList } from '../../app/read-repositories.js'
import {
  CONFIG_FILE,
  emptyRepositories,
  emptyRepository,
  frameLines,
  KEYS,
  minutesFrom,
  NOW,
  renderApp,
  visibleWidth,
  waitFor,
} from '../../../test/support/tui.js'
import type { AppDeps } from '../app-context.js'
import type { TerminalSize } from '../terminal-size.js'
import { RepositoriesScreen } from './repositories.js'

afterEach(() => cleanup())

const at = (minutes: number) => minutesFrom(NOW, minutes)

function review(repo: string, changes: Partial<ListedRun> = {}): ListedRun {
  return {
    id: 9,
    source: 'watch',
    repo,
    number: 42,
    headSha: 'a1b2c3d4e5f6',
    startedAt: at(-120),
    finishedAt: at(-118),
    status: 'published',
    aiCalled: true,
    verdict: 'comments',
    score: 3,
    findings: 2,
    title: 'Add the checkout flow',
    ...changes,
  }
}

function busyList(): RepositoryList {
  return {
    configFile: CONFIG_FILE,
    configured: true,
    configError: null,
    watching: true,
    repositories: [
      {
        repo: 'acme/api',
        origins: ['watched'],
        index: { file: null, indexedSha: null, checkedAt: null },
        lastReview: null,
      },
      {
        repo: 'acme/shop',
        origins: ['watched', 'own-config', 'history'],
        index: {
          file: { path: '/home/ana/.cache/phada/index/acme/shop.sqlite', bytes: 12_900_000 },
          indexedSha: 'f00dbabe1234',
          checkedAt: at(-30),
        },
        lastReview: review('acme/shop'),
      },
      {
        repo: 'old-organization-with-a-long-name/legacy-monolith-service',
        origins: ['history'],
        index: { file: null, indexedSha: null, checkedAt: null },
        lastReview: review('old-organization-with-a-long-name/legacy-monolith-service', {
          verdict: 'blocking',
          startedAt: at(-60 * 24 * 3),
        }),
      },
    ],
  }
}

function shopDetail(): RepositoryDetail {
  return {
    ...emptyRepository('acme/shop'),
    origins: ['watched', 'own-config', 'history'],
    config: {
      status: 'read',
      settings: [
        { key: 'provider', value: { kind: 'text', text: 'codex' }, origin: 'global' },
        { key: 'model', value: null, origin: 'default' },
        { key: 'verify', value: { kind: 'flag', on: false }, origin: 'repository' },
        { key: 'ci.wait', value: { kind: 'duration', ms: 300_000 }, origin: 'global' },
        { key: 'ci.checks', value: null, origin: 'default' },
        {
          key: 'ignore',
          value: { kind: 'list', items: ['dist/**', 'vendor/**'] },
          origin: 'repository',
        },
      ],
      rules: [{ key: 'no-any', text: 'Avoid any in new code.', origin: 'global' }],
      warnings: [],
    },
    watch: {
      repo: 'acme/shop',
      publish: 'none',
      allowExternal: false,
      authors: ['ana', 'bruno'],
      labels: ['review-me'],
      baseBranches: ['main'],
      when: './gate.sh',
    },
    index: busyList().repositories[1]?.index ?? emptyRepository('x').index,
    related: [{ repo: 'acme/api', description: 'The API it calls', origin: 'repository' }],
    reviews: { runs: [review('acme/shop'), review('acme/shop', { id: 8, number: 41 })], total: 7 },
  }
}

function openRepositories(
  deps: Partial<AppDeps>,
  options: { size?: TerminalSize; language?: string } = {},
) {
  return renderApp({
    deps: {
      ...deps,
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: options.size ?? { columns: 80, rows: 24 },
    screens: [
      { id: 'repositories', title: (m) => m.screens.repositories, Screen: RepositoriesScreen },
    ],
  })
}

function expectFits(frame: string, size: TerminalSize) {
  const lines = frameLines(frame)
  expect(lines).toHaveLength(size.rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns)
}

describe('RepositoriesScreen', () => {
  it('lists each repository with its origins, index and last review within 80×24', async () => {
    const view = openRepositories({ readRepositories: async () => busyList() })
    await waitFor(() => view.frame().includes('acme/shop'))

    const frame = view.frame()
    expect(frame).toContain('3 repositories · 2 watched')
    expect(frame).toMatch(
      /acme\/shop\s+watched, own config, history\s+12\.3 MB\s+comments · 2h ago/,
    )
    expect(frame).toMatch(/acme\/api\s+watched\s+none/)
    expect(frame).toMatch(/…\S*monolith-service/)
    expect(frame).toContain('blocking · 3d ago')
    expectFits(frame, { columns: 80, rows: 24 })
  })

  it('opens the detail of the selected repository and goes back with Esc', async () => {
    const asked: string[] = []
    const view = openRepositories({
      readRepositories: async () => busyList(),
      readRepository: async (repo) => {
        asked.push(repo)
        return shopDetail()
      },
    })
    await waitFor(() => view.frame().includes('acme/shop'))

    await view.press(KEYS.down, KEYS.enter)
    await waitFor(() => view.frame().includes('Your config'))

    expect(asked).toEqual(['acme/shop'])
    const frame = view.frame()
    expect(frame).toContain('acme/shop · watched, own config, history')
    expect(frame).toMatch(/Publish\s+not published/)
    expect(frame).toMatch(/Authors\s+ana, bruno/)
    expect(frame).toMatch(/When\s+\.\/gate\.sh/)
    expect(frame).toMatch(/Commit\s+f00dbab · checked 30m ago/)
    expect(frame).toMatch(/provider\s+codex\s+global/)
    expect(frame).toMatch(/model\s+the AI CLI's own\s+default/)
    expect(frame).toMatch(/verify\s+off\s+this repo/)
    expect(frame).toMatch(/ci\.wait\s+5m\s+global/)
    expectFits(frame, { columns: 80, rows: 24 })

    await view.press(KEYS.end)
    const end = view.frame()
    expect(end).toContain('see the Rules')
    expect(end).toContain('acme/api — The API it calls')
    expect(end).toContain('Last reviews (2 of 7)')
    expect(end).toMatch(/#42\s+comments\s+3\/5\s+2h ago\s+Add the checkout flow/)

    await view.press(KEYS.escape)
    await waitFor(() => view.frame().includes('3 repositories'))
    expect(view.exits).toEqual([])
  })

  it('tells how to build a missing index and shows an invalid config as a message', async () => {
    const view = openRepositories({
      readRepositories: async () => busyList(),
      readRepository: async () => ({
        ...emptyRepository('acme/api'),
        origins: ['watched'],
        config: {
          status: 'invalid',
          error: 'Invalid config /cfg/config.yml: verify: expected boolean',
        },
      }),
    })
    await waitFor(() => view.frame().includes('acme/api'))

    await view.press(KEYS.enter)
    await waitFor(() => view.frame().includes('phada index acme/api'))

    const frame = view.frame()
    expect(frame).toContain('No index yet. Build it with phada index acme/api')
    expect(frame).toContain(
      'Invalid config: Invalid config /cfg/config.yml: verify: expected boolean',
    )
    expect(frame).toContain(`Not watched. Add it to watch.repos in ${CONFIG_FILE}.`)
  })

  it('points a fresh machine to phada init --global', async () => {
    const view = openRepositories({ readRepositories: async () => emptyRepositories() })
    await waitFor(() => view.frame().includes('No config yet'))

    expect(view.frame()).toContain('Create your own config with phada init --global')
  })

  it('tells a configured user how to watch a repository', async () => {
    const view = openRepositories({
      readRepositories: async () => ({ ...emptyRepositories(), configured: true }),
    })
    await waitFor(() => view.frame().includes('No repository yet'))

    const frame = view.frame()
    expect(frame).toContain(`Add watch.repos to ${CONFIG_FILE}, then run phada watch`)
    expect(frame).toContain('phada review owner/repo#N')
  })

  it('keeps the list when the config is invalid, with the error on top', async () => {
    const view = openRepositories({
      readRepositories: async () => ({
        ...busyList(),
        watching: false,
        configError: 'Invalid config /cfg/config.yml: watch.repos: list at least one owner/repo',
      }),
    })
    await waitFor(() => view.frame().includes('acme/shop'))

    expect(view.frame()).toContain('Invalid config: Invalid config /cfg/config.yml')
  })

  it('fits a wide terminal and speaks Portuguese', async () => {
    const size = { columns: 160, rows: 40 }
    const view = openRepositories(
      { readRepositories: async () => busyList() },
      { size, language: 'pt' },
    )
    await waitFor(() => view.frame().includes('acme/shop'))

    const frame = view.frame()
    expect(frame).toContain('3 repositórios · 2 observados')
    expect(frame).toContain('old-organization-with-a-long-name/legacy-monolith-service')
    expect(frame).toContain('observado, config própria, histórico')
    expectFits(frame, size)
  })
})
