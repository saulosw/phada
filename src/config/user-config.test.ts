import { describe, expect, it } from 'vitest'
import { memoryFiles as sharedMemoryFiles } from '../../test/support/memory-files.js'
import { ConfigError } from './errors.js'
import type { LocalFileSystem } from './local-files.js'
import {
  expandHome,
  listUserRepoConfigs,
  loadTopLevelUserLayers,
  loadUserLayers,
  userConfigDir,
  userRepoDir,
} from './user-config.js'

function memoryFiles(files: Record<string, string>): LocalFileSystem {
  return {
    readText: async (path) => files[path] ?? null,
    exists: async (path) => path in files,
    writeNew: async () => false,
    makeDir: async () => undefined,
    listDocs: async () => null,
    listDir: async () => null,
  }
}

describe('userConfigDir', () => {
  it.each([
    [{ PHADA_CONFIG_HOME: '/cfg', XDG_CONFIG_HOME: '/xdg' }, '/cfg'],
    [{ XDG_CONFIG_HOME: '/xdg' }, '/xdg/phada'],
    [{}, '/home/u/.config/phada'],
    [{ PHADA_CONFIG_HOME: '  ', XDG_CONFIG_HOME: '' }, '/home/u/.config/phada'],
  ])('resolves %o', (env, dir) => {
    expect(userConfigDir(env, '/home/u')).toBe(dir)
  })

  it('lowercases the per-repository folder', () => {
    expect(userRepoDir({}, '/home/u', 'Acme', 'Shop')).toBe('/home/u/.config/phada/repos/acme/shop')
  })
})

describe('expandHome', () => {
  it.each([
    ['~/notes', '/home/u/notes'],
    ['~', '/home/u'],
    ['/srv/~x', '/srv/~x'],
    ['~other/x', '~other/x'],
  ])('expands %s', (path, expanded) => {
    expect(expandHome(path, '/home/u')).toBe(expanded)
  })
})

describe('loadUserLayers', () => {
  const base = { env: { PHADA_CONFIG_HOME: '/cfg' }, home: '/home/u', owner: 'Acme', repo: 'shop' }

  it('loads the global and per-repository layers that exist', async () => {
    const files = memoryFiles({
      '/cfg/config.yml': 'language: pt-BR',
      '/cfg/repos/acme/shop/rules.md': 'Use the ORM.',
    })

    expect(await loadUserLayers({ ...base, files })).toEqual([
      { kind: 'user', dir: '', configLabel: 'user:config.yml', config: { language: 'pt-BR' } },
      {
        kind: 'user-repo',
        dir: '',
        configLabel: 'user:repos/acme/shop/config.yml',
        config: {},
        rulesMarkdown: { label: 'user:repos/acme/shop/rules.md', text: 'Use the ORM.' },
      },
    ])
  })

  it('resolves relative local files against the folder of the config', async () => {
    const files = memoryFiles({
      '/cfg/config.yml': 'localFiles: ["notes/rules.md", "~/team", "/srv/docs"]',
      '/cfg/repos/acme/shop/config.yml': 'localFiles: ["../../../shared.md"]',
    })

    const layers = await loadUserLayers({ ...base, files })

    expect(layers.map((layer) => layer.config.localFiles)).toEqual([
      ['/cfg/notes/rules.md', '~/team', '/srv/docs'],
      ['/cfg/shared.md'],
    ])
  })

  it('returns no layers without config', async () => {
    expect(await loadUserLayers({ ...base, files: memoryFiles({}) })).toEqual([])
  })

  it('fails with the file path and the key of an invalid config', async () => {
    const files = memoryFiles({ '/cfg/repos/acme/shop/config.yml': 'minConfidence: 10' })

    const error = await loadUserLayers({ ...base, files }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).toMatch(
      /^Invalid config \/cfg\/repos\/acme\/shop\/config\.yml: minConfidence: /,
    )
  })
})

describe('loadTopLevelUserLayers', () => {
  it('reads only the top-level user config', async () => {
    const files = memoryFiles({ '/cfg/config.yml': 'watch:\n  repos: [a/b]\n' })

    const layers = await loadTopLevelUserLayers({
      env: { PHADA_CONFIG_HOME: '/cfg' },
      home: '/h',
      files,
    })

    expect(layers).toEqual([
      expect.objectContaining({ kind: 'user', config: { watch: { repos: ['a/b'] } } }),
    ])
  })

  it('is empty without a config', async () => {
    const layers = await loadTopLevelUserLayers({ env: {}, home: '/h', files: memoryFiles({}) })

    expect(layers).toEqual([])
  })
})

describe('loadUserLayers review prompt', () => {
  const base = { env: { PHADA_CONFIG_HOME: '/cfg' }, home: '/home/u', owner: 'Acme', repo: 'shop' }

  it('resolves a relative review prompt against the folder of the config', async () => {
    const files = memoryFiles({
      '/cfg/config.yml': 'review:\n  prompt:\n    file: review.md',
      '/cfg/repos/acme/shop/config.yml': 'review:\n  prompt:\n    file: ~/team.md',
    })

    const layers = await loadUserLayers({ ...base, files })

    expect(layers.map((layer) => layer.config.review?.prompt?.file)).toEqual([
      '/cfg/review.md',
      '~/team.md',
    ])
  })
})

describe('loadUserLayers review readDirs', () => {
  it('resolves readDirs against the folder of the config', async () => {
    const files = memoryFiles({
      '/cfg/config.yml': 'review:\n  readDirs: [rules, "~/x", /abs]',
    })

    const layers = await loadUserLayers({
      env: { PHADA_CONFIG_HOME: '/cfg' },
      home: '/home/u',
      owner: 'acme',
      repo: 'shop',
      files,
    })

    expect(layers[0]?.config.review?.readDirs).toEqual(['/cfg/rules', '~/x', '/abs'])
  })
})

describe('listUserRepoConfigs', () => {
  it('lists the repositories with a config or rules in their own user folder', async () => {
    const files = sharedMemoryFiles(
      {
        '/cfg/config.yml': 'language: pt',
        '/cfg/repos/acme/shop/config.yml': 'verify: true',
        '/cfg/repos/acme/api/rules.md': 'Use the ORM.',
        '/cfg/repos/acme/notes.txt': 'not a folder',
        '/cfg/repos/zeta/web/README': 'nothing Phada reads',
      },
      ['/cfg/repos/acme/empty'],
    )

    expect(
      await listUserRepoConfigs({ env: { PHADA_CONFIG_HOME: '/cfg' }, home: '/h', files }),
    ).toEqual(['acme/api', 'acme/shop'])
  })

  it('is empty without a repos folder', async () => {
    expect(
      await listUserRepoConfigs({ env: {}, home: '/h', files: sharedMemoryFiles({}) }),
    ).toEqual([])
  })
})
