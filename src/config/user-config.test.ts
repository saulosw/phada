import { describe, expect, it } from 'vitest'
import { ConfigError } from './errors.js'
import type { LocalFileSystem } from './local-files.js'
import { expandHome, loadUserLayers, userConfigDir, userRepoDir } from './user-config.js'

function memoryFiles(files: Record<string, string>): LocalFileSystem {
  return {
    readText: async (path) => files[path] ?? null,
    exists: async (path) => path in files,
    writeNew: async () => false,
    makeDir: async () => undefined,
    listDocs: async () => null,
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
