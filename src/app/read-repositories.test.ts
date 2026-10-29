import { describe, expect, it } from 'vitest'
import { ConfigError } from '../config/errors.js'
import { parseConfigText } from '../config/parse-config.js'
import type { ConfigLayer } from '../config/types.js'
import type { HistoryStatus, ListedRun, RunRecord } from '../store/history-store.js'
import { readRepositories, readRepository } from './read-repositories.js'
import type { RepositoryHistory, RepositoryReaders } from './read-repositories.js'

const CONFIG_FILE = '/cfg/config.yml'

function layer(kind: 'user' | 'user-repo', yaml: string, repo = 'acme/shop'): ConfigLayer {
  const parsed = parseConfigText(yaml)
  if (!parsed.ok) throw new Error(parsed.message)
  return {
    kind,
    dir: '',
    configLabel: kind === 'user' ? 'user:config.yml' : `user:repos/${repo}/config.yml`,
    config: parsed.config,
  }
}

function run(repo: string, changes: Partial<RunRecord> = {}): ListedRun {
  return {
    id: 1,
    source: 'watch',
    repo,
    number: 7,
    headSha: 'a1b2c3d',
    startedAt: '2026-10-25T11:00:00.000Z',
    finishedAt: '2026-10-25T11:02:00.000Z',
    status: 'published',
    aiCalled: true,
    verdict: 'comments',
    ...changes,
  }
}

function history(status: Partial<HistoryStatus>, runs: ListedRun[] = []): RepositoryHistory {
  return {
    status: () => ({ repos: [], queued: [], running: [], failed: [], lastRuns: [], ...status }),
    runs: (filter) => {
      const matching = runs.filter((entry) => entry.repo === filter.repo)
      return { runs: matching.slice(0, filter.limit), total: matching.length }
    },
  }
}

function readers(changes: Partial<RepositoryReaders> = {}): RepositoryReaders {
  return {
    configFile: CONFIG_FILE,
    topLevelLayers: async () => [],
    userLayers: async () => [],
    userRepoConfigs: async () => [],
    history: async () => undefined,
    indexFile: async () => null,
    ...changes,
  }
}

describe('readRepositories', () => {
  it('lists watched, own-config and history repositories once, each with its origins', async () => {
    const lastRun = run('old/lib', { startedAt: '2026-10-20T10:00:00.000Z' })
    const list = await readRepositories(
      readers({
        topLevelLayers: async () => [
          layer('user', 'watch:\n  repos: [acme/shop, { repo: Acme/API, publish: false }]\n'),
        ],
        userRepoConfigs: async () => ['acme/shop', 'zeta/web'],
        history: async () =>
          history({
            repos: [
              {
                repo: 'acme/shop',
                indexedSha: 'f00dbabe',
                branchCheckedAt: '2026-10-25T10:00:00.000Z',
              },
            ],
            lastRuns: [lastRun],
          }),
        indexFile: async (repo) =>
          repo === 'acme/shop' ? { path: '/cache/index/acme/shop.sqlite', bytes: 2048 } : null,
      }),
    )

    expect(list).toEqual({
      configFile: CONFIG_FILE,
      configured: true,
      configError: null,
      watching: true,
      repositories: [
        {
          repo: 'acme/api',
          origins: ['watched'],
          publish: 'none',
          index: { file: null, indexedSha: null, checkedAt: null },
          lastReview: null,
        },
        {
          repo: 'acme/shop',
          origins: ['watched', 'own-config', 'history'],
          publish: 'pr',
          index: {
            file: { path: '/cache/index/acme/shop.sqlite', bytes: 2048 },
            indexedSha: 'f00dbabe',
            checkedAt: '2026-10-25T10:00:00.000Z',
          },
          lastReview: null,
        },
        {
          repo: 'zeta/web',
          origins: ['own-config'],
          publish: null,
          index: { file: null, indexedSha: null, checkedAt: null },
          lastReview: null,
        },
        {
          repo: 'old/lib',
          origins: ['history'],
          publish: null,
          index: { file: null, indexedSha: null, checkedAt: null },
          lastReview: lastRun,
        },
      ],
    })
  })

  it('lists the watched repositories first, then those with their own config, then the history, each by name', async () => {
    const list = await readRepositories(
      readers({
        topLevelLayers: async () => [layer('user', 'watch:\n  repos: [zeta/app, beta/api]\n')],
        userRepoConfigs: async () => ['alpha/own', 'omega/own', 'zeta/app'],
        history: async () =>
          history({ lastRuns: [run('aaa/old'), run('beta/api'), run('mid/old')] }),
      }),
    )

    expect(list.repositories.map(({ repo }) => repo)).toEqual([
      'beta/api',
      'zeta/app',
      'alpha/own',
      'omega/own',
      'aaa/old',
      'mid/old',
    ])
  })

  it('keeps listing the folders and the history when the top-level config is invalid', async () => {
    const list = await readRepositories(
      readers({
        topLevelLayers: async () => {
          throw new ConfigError('Invalid config /cfg/config.yml: watch.repos: list at least one')
        },
        userRepoConfigs: async () => ['acme/shop'],
        history: async () => history({ lastRuns: [run('old/lib')] }),
      }),
    )

    expect(list.configError).toBe('Invalid config /cfg/config.yml: watch.repos: list at least one')
    expect(list.configured).toBe(true)
    expect(list.watching).toBe(false)
    expect(list.repositories.map(({ repo, origins }) => [repo, origins])).toEqual([
      ['acme/shop', ['own-config']],
      ['old/lib', ['history']],
    ])
  })

  it('says there is no config and nothing to list on a fresh machine', async () => {
    expect(await readRepositories(readers())).toEqual({
      configFile: CONFIG_FILE,
      configured: false,
      configError: null,
      watching: false,
      repositories: [],
    })
  })

  it('reports a configured user who watches nothing', async () => {
    const list = await readRepositories(
      readers({ topLevelLayers: async () => [layer('user', 'language: pt\n')] }),
    )

    expect(list).toMatchObject({ configured: true, watching: false, repositories: [] })
  })
})

describe('readRepository', () => {
  const globalYaml = [
    'provider: codex',
    'model: gpt-x',
    'minConfidence: 70',
    'review:',
    '  debt: comments',
    'ci:',
    '  wait: 5m',
    'ignore: ["dist/**"]',
    'rules:',
    '  - id: no-any',
    '    rule: Avoid any.',
    'context:',
    '  repos: [acme/lib]',
    'watch:',
    '  when:',
    '    command: ./gate.sh',
    '  repos:',
    '    - repo: acme/shop',
    '      authors: [ana]',
    '      labels: [review-me]',
    '      baseBranches: [main]',
    '      publish: false',
    '',
  ].join('\n')
  const repoYaml = [
    'model: gpt-y',
    'verify: false',
    'ci:',
    '  onFailure: skip',
    '  checks: [build]',
    'ignore: ["fixtures/**"]',
    'context:',
    '  repos:',
    '    - repo: acme/api',
    '      description: The API it calls',
    '',
  ].join('\n')

  it('shows the effective user config with where each value comes from', async () => {
    const detail = await readRepository(
      readers({
        topLevelLayers: async () => [layer('user', globalYaml)],
        userLayers: async () => [layer('user', globalYaml), layer('user-repo', repoYaml)],
        userRepoConfigs: async () => ['acme/shop'],
      }),
      'Acme/Shop',
    )

    expect(detail.repo).toBe('acme/shop')
    expect(detail.origins).toEqual(['watched', 'own-config'])
    if (detail.config.status !== 'read') throw new Error('config not read')
    const byKey = new Map(
      detail.config.settings.map((setting) => [`${setting.key}@${setting.origin}`, setting.value]),
    )
    expect(byKey.get('provider@global')).toEqual({ kind: 'text', text: 'codex' })
    expect(byKey.get('model@global')).toEqual({ kind: 'text', text: 'gpt-x' })
    expect(byKey.get('minConfidence@global')).toEqual({ kind: 'number', value: 70 })
    expect(byKey.get('verify@repository')).toEqual({ kind: 'flag', on: false })
    expect(byKey.get('investigate@default')).toEqual({ kind: 'flag', on: true })
    expect(byKey.get('language@default')).toEqual({ kind: 'text', text: 'en' })
    expect(byKey.get('ci.read@default')).toEqual({ kind: 'flag', on: true })
    expect(byKey.get('ci.wait@global')).toEqual({ kind: 'duration', ms: 300_000 })
    expect(byKey.get('ci.onFailure@repository')).toEqual({ kind: 'text', text: 'skip' })
    expect(byKey.get('ci.checks@repository')).toEqual({ kind: 'list', items: ['build'] })
    expect(byKey.get('review.debt@global')).toEqual({ kind: 'text', text: 'comments' })
    expect(byKey.get('ignore@global')).toEqual({ kind: 'list', items: ['dist/**'] })
    expect(byKey.get('ignore@repository')).toEqual({ kind: 'list', items: ['fixtures/**'] })
    expect(detail.config.rules).toEqual([
      { key: 'no-any', name: 'no-any', text: 'Avoid any.', origin: 'global' },
    ])
    expect(detail.related).toEqual([
      { repo: 'acme/api', description: 'The API it calls', origin: 'repository' },
      { repo: 'acme/lib', origin: 'global' },
    ])
    expect(detail.watch).toEqual({
      repo: 'acme/shop',
      publish: 'none',
      allowExternal: false,
      authors: ['ana'],
      labels: ['review-me'],
      baseBranches: ['main'],
      when: './gate.sh',
    })
  })

  it('shows the index facts and the last reviews of the repository', async () => {
    const runs = [run('acme/shop', { id: 3 }), run('acme/shop', { id: 2 }), run('acme/api')]
    const detail = await readRepository(
      readers({
        history: async () =>
          history(
            {
              repos: [{ repo: 'acme/shop', indexedSha: 'f00dbabe' }],
              lastRuns: [runs[0] as ListedRun],
            },
            runs,
          ),
        indexFile: async () => ({ path: '/cache/index/acme/shop.sqlite', bytes: 4096 }),
      }),
      'acme/shop',
    )

    expect(detail.origins).toEqual(['history'])
    expect(detail.index).toEqual({
      file: { path: '/cache/index/acme/shop.sqlite', bytes: 4096 },
      indexedSha: 'f00dbabe',
      checkedAt: null,
    })
    expect(detail.reviews.total).toBe(2)
    expect(detail.reviews.runs.map(({ id }) => id)).toEqual([3, 2])
    expect(detail.watch).toBeNull()
  })

  it('turns an invalid config into a message instead of failing', async () => {
    const detail = await readRepository(
      readers({
        topLevelLayers: async () => [layer('user', globalYaml)],
        userLayers: async () => {
          throw new ConfigError(
            'Invalid config /cfg/repos/acme/shop/config.yml: verify: expected boolean',
          )
        },
      }),
      'acme/shop',
    )

    expect(detail.config).toEqual({
      status: 'invalid',
      error: 'Invalid config /cfg/repos/acme/shop/config.yml: verify: expected boolean',
    })
    expect(detail.related).toEqual([])
    expect(detail.watch).toMatchObject({ repo: 'acme/shop', when: './gate.sh' })
  })

  it('shows the defaults when there is no user config at all', async () => {
    const detail = await readRepository(readers(), 'acme/shop')

    if (detail.config.status !== 'read') throw new Error('config not read')
    expect(detail.config.settings.every((setting) => setting.origin === 'default')).toBe(true)
    expect(detail.config.settings.find(({ key }) => key === 'provider')?.value).toEqual({
      kind: 'text',
      text: 'claude',
    })
    expect(detail.config.rules).toEqual([])
    expect(detail.origins).toEqual([])
  })
})
