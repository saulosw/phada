import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { IndexingOptions, IndexingResult } from '../../app/index-repository.js'
import type { ListedRun } from '../../app/read-history.js'
import type {
  ListedRepository,
  RepositoryDetail,
  RepositoryList,
} from '../../app/read-repositories.js'
import type { UserRepoFile } from '../../config/user-config.js'
import type {
  UserConfigChange,
  UserConfigPlan,
  ValueChange,
} from '../../config/user-config-edit.js'
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
  CONFIG_ERROR_REASON,
  flatFrame,
  LONG_CONFIG_ERROR,
} from '../../../test/support/tui.js'
import type { AppDeps, HandOffResult, HandOffTarget } from '../app-context.js'
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
        publish: 'pr',
        index: { file: null, indexedSha: null, checkedAt: null },
        lastReview: null,
      },
      {
        repo: 'acme/shop',
        origins: ['watched', 'own-config', 'history'],
        publish: 'none',
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
        publish: null,
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
      rules: [
        { key: 'no-any', name: 'no-any', text: 'Avoid any in new code.', origin: 'global' },
        {
          key: 'user:repos/acme/shop/rules.md',
          name: 'rules.md',
          text: 'Prefer small functions.',
          origin: 'repository',
        },
      ],
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
    await view.showing('3 repositories · 2 watched', 'blocking · 3d ago')

    const frame = view.frame()
    expect(frame).toContain('3 repositories · 2 watched')
    expect(frame).toMatch(/acme\/shop\s+watched, …\s+12\.3 MB\s+comments · 2h ago/)
    expect(frame).toMatch(/acme\/api\s+watched\s+none/)
    expect(frame).toMatch(/…\S*\/legacy-monolith-service/)
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
    await view.showing('acme/shop', 'Enter open')

    await view.press(KEYS.down, KEYS.enter)
    await view.showing('Your config', 'Esc back')

    expect(asked).toEqual(['acme/shop'])
    const frame = view.frame()
    expect(frame).toContain('acme/shop · watched, own config, history')
    expect(frame).toMatch(/Publish\s+not published/)
    expect(frame).toMatch(/Authors\s+ana, bruno/)
    expect(frame).toMatch(/When\s+\.\/gate\.sh/)
    expect(frame).toMatch(/File\s+~\/\.cache\/phada\/index\/acme\/shop\.sqlite · 12\.3 MB/)
    expect(frame).toMatch(/Commit\s+f00dbab · checked 30m ago/)
    expect(frame).toMatch(/provider\s+codex\s+global/)
    expect(frame).toMatch(/model\s+the AI CLI's own\s+default/)
    expect(frame).toMatch(/verify\s+off\s+this repo/)
    expect(frame).toMatch(/ci\.wait\s+5m\s+global/)
    expectFits(frame, { columns: 80, rows: 24 })

    await view.press(KEYS.end)
    await view.showing('Last reviews (2 of 7)')
    const end = view.frame()
    expect(end).toMatch(/no-any\s+Avoid any in new code\.\s+global/)
    expect(end).toMatch(/rules\.md\s+Prefer small functions\.\s+this repo/)
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
    await view.showing('acme/api', 'Enter open')

    await view.press(KEYS.enter)
    await view.showing('phada index acme/api', 'Not watched', 'Esc back')

    const frame = view.frame()
    expect(frame).toContain('No index yet. Build it with phada index acme/api')
    expect(frame).toContain(
      'Could not load: Invalid config /cfg/config.yml: verify: expected boolean',
    )
    expect(frame).toContain(`Not watched. Add it to watch.repos in ~/.config/phada/config.yml.`)
  })

  it('points a fresh machine to phada setup', async () => {
    const view = openRepositories({ readRepositories: async () => emptyRepositories() })
    await waitFor(() => view.frame().includes('No config yet'))

    expect(view.frame()).toContain('Create your own config with phada setup')
  })

  it('tells a configured user how to watch a repository', async () => {
    const view = openRepositories({
      readRepositories: async () => ({ ...emptyRepositories(), configured: true }),
    })
    await waitFor(() => view.frame().includes('No repository yet'))

    const frame = view.frame()
    expect(frame).toContain(`Add watch.repos to ~/.config/phada/config.yml, then run phada watch`)
    expect(frame).toContain('phada review owner/repo#N')
  })

  it('shows a long config error whole and once, and no hint to add watch.repos', async () => {
    const view = openRepositories({
      readRepositories: async () => ({
        ...emptyRepositories(),
        configured: true,
        configError: LONG_CONFIG_ERROR,
      }),
    })
    await view.showing('Invalid config')

    const frame = view.frame()
    expect(flatFrame(frame)).toContain(CONFIG_ERROR_REASON)
    expect(frame).not.toContain('Invalid config: Invalid config')
    expect(frame).not.toContain('watch.repos')
    expect(frame).not.toContain('No repository yet')
    expectFits(frame, { columns: 80, rows: 24 })
  })

  it('keeps the list when the config is invalid, with the error on top', async () => {
    const view = openRepositories({
      readRepositories: async () => ({
        ...busyList(),
        watching: false,
        configError: 'Invalid config /cfg/config.yml: watch.repos: list at least one owner/repo',
      }),
    })
    await view.showing('acme/shop', 'Invalid config')

    expect(view.frame()).toContain('Could not load: Invalid config /cfg/config.yml')
  })

  it('fits a wide terminal and speaks Portuguese', async () => {
    const size = { columns: 160, rows: 40 }
    const view = openRepositories(
      { readRepositories: async () => busyList() },
      { size, language: 'pt' },
    )
    await view.showing('3 repositórios · 2 observados', 'observado, config própria, histórico')

    const frame = view.frame()
    expect(frame).toContain('3 repositórios · 2 observados')
    expect(frame).toContain('old-organization-with-a-long-name/legacy-monolith-service')
    expect(frame).toContain('observado, config própria, histórico')
    expectFits(frame, size)
  })

  describe('changing the repositories', () => {
    interface Watched {
      repo: string
      publish: boolean
    }

    function editable(
      options: {
        watched?: Watched[]
        others?: string[]
        configError?: string
        configured?: boolean
        handOff?: (target: HandOffTarget) => Promise<HandOffResult>
        size?: TerminalSize
        language?: string
      } = {},
    ) {
      let watched = options.watched ?? [
        { repo: 'acme/api', publish: true },
        { repo: 'acme/shop', publish: false },
      ]
      const others = options.others ?? ['old/blog']
      const plans: (readonly UserConfigChange[])[] = []
      const writes: UserConfigPlan[] = []
      const ensured: [string, UserRepoFile][] = []
      const targets: HandOffTarget[] = []
      let reads = 0
      const listed = (repo: string, publish: boolean | null): ListedRepository => ({
        repo,
        origins: publish === null ? ['history'] : ['watched'],
        publish: publish === null ? null : publish ? 'pr' : 'none',
        index: { file: null, indexedSha: null, checkedAt: null },
        lastReview: null,
      })
      const planOf = (changes: readonly UserConfigChange[]): UserConfigPlan => {
        const values: ValueChange[] = changes.flatMap((change): ValueChange[] => {
          if (change.kind === 'watch')
            return [{ key: 'watch.repos', added: [change.repo], removed: [] }]
          if (change.kind === 'unwatch')
            return [{ key: 'watch.repos', added: [], removed: [change.repo] }]
          if (change.kind === 'publish') {
            const before = watched.find(({ repo }) => repo === change.repo)?.publish ?? true
            return [{ key: 'publish', repo: change.repo, before, after: change.publish }]
          }
          return []
        })
        return {
          path: CONFIG_FILE,
          exists: true,
          before: '# mine\n',
          text: '# mine\n',
          changes: values,
        }
      }
      const view = openRepositories(
        {
          readRepositories: async () => {
            reads++
            return {
              ...emptyRepositories(),
              configured: options.configured ?? true,
              configError: options.configError ?? null,
              watching: watched.length > 0,
              repositories: [
                ...watched.map(({ repo, publish }) => listed(repo, publish)),
                ...others
                  .filter((repo) => !watched.some((entry) => entry.repo === repo))
                  .map((repo) => listed(repo, null)),
              ],
            }
          },
          readUserRepositories: async () => ({
            status: 'listed',
            repositories: ['ana/ink', ...watched.map(({ repo }) => repo)].map((name) => ({
              name,
              private: false,
              fork: false,
              pushedAt: null,
              listed: true as const,
              watched: watched.some((entry) => entry.repo === name),
            })),
          }),
          planConfig: async (changes) => {
            plans.push(changes)
            return { ok: true, plan: planOf(changes) }
          },
          applyConfig: async (plan) => {
            writes.push(plan)
            for (const change of plan.changes) {
              if (change.key === 'watch.repos') {
                watched = [
                  ...watched.filter(({ repo }) => !change.removed.includes(repo)),
                  ...change.added.map((repo) => ({ repo, publish: true })),
                ]
              }
              if (change.key === 'publish') {
                watched = watched.map((entry) =>
                  entry.repo === change.repo ? { ...entry, publish: change.after } : entry,
                )
              }
            }
            return { ok: true, written: true }
          },
          ensureRepositoryFile: async (repo, file) => {
            ensured.push([repo, file])
            return `/home/ana/.config/phada/repos/${repo}/${file}`
          },
          handOff: async (target) => {
            targets.push(target)
            return options.handOff === undefined
              ? { kind: 'exited', exitCode: 0 }
              : options.handOff(target)
          },
        },
        {
          ...(options.size === undefined ? {} : { size: options.size }),
          ...(options.language === undefined ? {} : { language: options.language }),
        },
      )
      return { ...view, plans, writes, ensured, targets, reads: () => reads }
    }

    it('stops watching the selected repository with w after its before and after, and lists it again', async () => {
      const { footer, frame, press, showing, writes } = editable()
      await showing('3 repositories · 2 watched', 'acme/api')
      expect(footer()).toContain('w unwatch')
      await press('w')
      await showing('Save ~/.config/phada/config.yml?')
      expect(frame()).toMatch(/watch\.repos +− acme\/api/)
      expect(footer()).toContain('Enter save')
      expectFits(frame(), { columns: 80, rows: 24 })
      await press(KEYS.enter)
      await showing('2 repositories · 1 watched')
      expect(frame()).toContain('2 repositories · 1 watched')
      expect(writes).toHaveLength(1)
      expect(selectedRow(frame())).toContain('acme/shop')
    })

    it('watches a repository it does not watch with w', async () => {
      const { footer, frame, plans, press, showing } = editable()
      await showing('3 repositories · 2 watched', 'old/blog')
      await press(KEYS.end)
      await showing('w watch')
      expect(footer()).not.toContain('publish')
      await press('w')
      await showing('Save ~/.config/phada/config.yml?')
      expect(plans).toEqual([[{ kind: 'watch', repo: 'old/blog' }]])
      expect(frame()).toMatch(/watch\.repos +\+ old\/blog/)
      await press(KEYS.enter)
      await showing('3 repositories · 3 watched')
      expect(frame()).toContain('3 repositories · 3 watched')
    })

    it('turns publishing off and on with p for a watched repository', async () => {
      const { frame, plans, press, showing, writes } = editable()
      await showing('3 repositories · 2 watched', 'p publish off')
      await press('p')
      await showing('Save ~/.config/phada/config.yml?')
      expect(plans).toEqual([[{ kind: 'publish', repo: 'acme/api', publish: false }]])
      expect(frame()).toMatch(/acme\/api +publishes → does not publish/)
      await press(KEYS.enter)
      await showing('p publish on')
      await press('p')
      await showing('does not publish → publishes')
      await press(KEYS.enter)
      await showing('p publish off')
      expect(writes).toHaveLength(2)
    })

    it('cancels a change with Esc without writing or leaving the list', async () => {
      const { exits, frame, press, showing, writes } = editable()
      await showing('3 repositories · 2 watched', 'acme/api')
      await press('w')
      await showing('− acme/api')
      await press(KEYS.escape)
      await showing('w unwatch')
      expect(frame()).not.toContain('− acme/api')
      expect(frame()).toContain('3 repositories · 2 watched')
      expect(writes).toEqual([])
      expect(exits).toEqual([])
    })

    it('adds repositories with a from the list of GitHub, back on the screen once saved', async () => {
      const { footer, frame, press, showing, writes } = editable()
      await showing('3 repositories · 2 watched', 'a add')
      await press('a')
      await showing('[ ] ana/ink', '[x] acme/api')
      expect(footer()).toContain('Space mark')
      expectFits(frame(), { columns: 80, rows: 24 })
      await press(' ', KEYS.enter)
      await showing('+ ana/ink')
      await press(KEYS.enter)
      await showing('4 repositories · 3 watched', 'ana/ink')
      expect(frame()).toContain('4 repositories · 3 watched')
      expect(writes).toHaveLength(1)
    })

    it('goes back from adding with Esc without writing', async () => {
      const { exits, frame, press, showing, writes } = editable()
      await showing('3 repositories · 2 watched')
      await press('a')
      await showing('[ ] ana/ink')
      await press(KEYS.escape)
      await showing('3 repositories · 2 watched')
      expect(frame()).toContain('3 repositories · 2 watched')
      expect(writes).toEqual([])
      expect(exits).toEqual([])
    })

    it('opens the config.yml of the repository with e and its rules.md with R in the editor, created first', async () => {
      const { ensured, footer, press, reads, showing, targets, until } = editable()
      await showing('3 repositories · 2 watched', 'acme/api')
      expect(footer()).toContain('e config')
      const before = reads()
      await press('e')
      await until(() => targets.length === 1 && reads() > before)
      expect(ensured).toEqual([['acme/api', 'config.yml']])
      expect(targets).toEqual([
        { kind: 'editor', file: '/home/ana/.config/phada/repos/acme/api/config.yml' },
      ])
      expect(reads()).toBeGreaterThan(before)
      await press(KEYS.down, 'R')
      await until(() => targets.length === 2)
      expect(ensured).toEqual([
        ['acme/api', 'config.yml'],
        ['acme/shop', 'rules.md'],
      ])
      expect(targets[1]).toEqual({
        kind: 'editor',
        file: '/home/ana/.config/phada/repos/acme/shop/rules.md',
      })
    })

    it('says when the editor ended with an error or was not found', async () => {
      const outcomes: HandOffResult[] = [
        { kind: 'exited', exitCode: 1 },
        { kind: 'not-found', command: 'nvim' },
      ]
      const { frame, press, showing } = editable({
        handOff: async () => outcomes.shift() ?? { kind: 'exited', exitCode: 0 },
      })
      await showing('3 repositories · 2 watched')
      await press('e')
      await showing('The editor ended with exit code 1.')
      expect(frame()).toContain('The editor ended with exit code 1.')
      expectFits(frame(), { columns: 80, rows: 24 })
      await press('e')
      await showing('nvim was not found.')
      expect(frame()).toContain('nvim was not found.')
      expect(frame()).not.toContain('exit code 1')
    })

    it('offers no change of the config while it is invalid, only the files of the repository', async () => {
      const { footer, frame, plans, press, showing } = editable({
        configError: 'Invalid config /cfg/config.yml: watch.interval: expected 5m',
      })
      await showing('Invalid config', 'acme/api')
      expect(footer()).not.toContain('watch')
      expect(footer()).not.toContain('publish')
      expect(footer()).not.toContain('a add')
      expect(footer()).toContain('e config')
      await press('w', 'p', 'a')
      await showing('Invalid config', 'acme/api')
      expect(frame()).not.toContain('Save')
      expect(frame()).not.toContain('ana/ink')
      expect(plans).toEqual([])
    })

    it('offers to add the first repository on a fresh machine, and points to phada setup', async () => {
      const { footer, frame, press, showing } = editable({
        watched: [],
        others: [],
        configured: false,
      })
      await showing('No config yet', 'a add')
      expect(frame()).toContain('Create your own config with phada setup')
      expect(footer()).not.toContain('watch')
      await press('a')
      await showing('[ ] ana/ink')
      expect(frame()).toContain('[ ] ana/ink')
    })

    it('speaks Portuguese', async () => {
      const { footer, frame, press, showing } = editable({ language: 'pt' })
      await showing('3 repositórios · 2 observados', 'w não observar')
      expect(footer()).toContain('w não observar')
      await press('p')
      await showing('publica → não publica')
      expectFits(frame(), { columns: 80, rows: 24 })
    })
  })
})

describe('indexing from the Repositories screen', () => {
  function indexing(deps: Partial<AppDeps> = {}) {
    const calls: (IndexingOptions & { repo: string; finish(result: IndexingResult): void })[] = []
    const view = openRepositories({
      readRepositories: async () => busyList(),
      readRepository: async () => shopDetail(),
      indexRepository: (repo, options) =>
        new Promise<IndexingResult>((finish) => calls.push({ repo, ...options, finish })),
      ...deps,
    })
    const call = (index: number) => {
      const found = calls[index]
      if (found === undefined) throw new Error(`no indexing call ${index}`)
      return found
    }
    return { ...view, calls, call }
  }

  it('indexes the selected repository with i, with its progress, and Esc stops it', async () => {
    const { call, calls, footer, frame, press, showing, until } = indexing()
    await showing('acme/api')
    await press('i')
    await until(() => calls.length === 1)
    expect(call(0).repo).toBe('acme/api')
    call(0).onProgress({ phase: 'extracting', done: 5, total: 50 })
    await showing(/acme\/api · 5 of 50 files/)
    expect(footer()).toContain('Esc stop indexing')
    expectFits(frame(), { columns: 80, rows: 24 })
    await press(KEYS.escape)
    await until(() => call(0).signal.aborted)
    call(0).finish({ kind: 'cancelled', extracted: 5, total: 50 })
    await showing(/acme\/api · stopped at 5 of 50 files/)
    expect(frame()).toContain('3 repositories')
    expect(footer()).not.toContain('Esc stop indexing')
  })

  it('indexes the open repository with i', async () => {
    const { call, calls, footer, frame, press, showing, until } = indexing()
    await showing('acme/shop')
    await press(KEYS.down, KEYS.enter)
    await showing('Your config')
    expect(footer()).toContain('i index')
    await press('i')
    await until(() => calls.length === 1)
    expect(call(0).repo).toBe('acme/shop')
    call(0).finish({ kind: 'indexed', files: 1240 })
    await showing(/acme\/shop · 1,240 files indexed/)
    expect(frame()).toContain('Your config')
    expectFits(frame(), { columns: 80, rows: 24 })
  })
})

function selectedRow(frame: string): string {
  return frameLines(frame).find((line) => line.includes('❯')) ?? ''
}
