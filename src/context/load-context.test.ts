import { describe, expect, it } from 'vitest'
import { modifiedFile } from '../../test/support/diff-sections.js'
import type { ConfigLayer } from '../config/types.js'
import type { RepositoryTree } from '../github/repository-files.js'
import { loadContext } from './load-context.js'
import type { ContextSources, LocalDocEntry } from './types.js'

const SHA = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const DIFF = modifiedFile('src/api/users.ts') + modifiedFile('package-lock.json')

interface FakeSources extends ContextSources {
  repoReads: string[]
  localLists: string[]
}

function fakeSources(
  files: Record<string, string>,
  options: {
    tree?: RepositoryTree | Error
    local?: Record<string, LocalDocEntry[]>
    localText?: Record<string, string>
    failing?: string[]
  } = {},
): FakeSources {
  const repoReads: string[] = []
  const localLists: string[] = []
  const tree = options.tree ?? {
    entries: Object.entries(files).map(([path, text]) => ({
      path,
      size: new TextEncoder().encode(text).length,
    })),
    truncated: false,
  }
  return {
    repoReads,
    localLists,
    readTree: async () => {
      if (tree instanceof Error) throw tree
      return tree
    },
    readRepoFile: async (path) => {
      repoReads.push(path)
      if (options.failing?.includes(path)) throw new Error('GitHub did not respond within 30s')
      return files[path] ?? null
    },
    readLocalFile: async (path) => options.localText?.[path] ?? null,
    listLocalDocs: async (path) => {
      localLists.push(path)
      return options.local?.[path] ?? null
    },
  }
}

const userLayer = (config: ConfigLayer['config']): ConfigLayer => ({
  kind: 'user',
  dir: '',
  configLabel: 'user:config.yml',
  config,
})

describe('loadContext', () => {
  it('reads rules from the root and from subfolders, applying scope and disabled ids', async () => {
    const sources = fakeSources({
      '.phada/config.yml': [
        'rules:',
        '  - id: orm-only',
        '    rule: Use the ORM.',
        '    scope: ["**/*.py"]',
        '  - id: no-console',
        '    rule: No console.log.',
        '  - id: zod-params',
        '    rule: Validate params with zod.',
        '    severity: P1',
      ].join('\n'),
      'src/api/.phada/config.yml': 'disabledRules: [no-console]',
      'src/api/.phada/rules.md': 'Log with request.log.',
      'src/api/users.ts': 'x',
    })

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.context.rules).toEqual([
      {
        key: 'zod-params',
        text: 'Validate params with zod.',
        scope: ['**'],
        severity: 'P1',
        origin: '.phada/config.yml',
      },
      {
        key: 'src/api/.phada/rules.md',
        text: 'Log with request.log.',
        scope: ['src/api/**'],
        origin: 'src/api/.phada/rules.md',
      },
    ])
    expect(loaded.report.rules).toEqual([
      { key: 'orm-only', origin: '.phada/config.yml', status: 'out-of-scope' },
      { key: 'no-console', origin: '.phada/config.yml', status: 'disabled' },
      { key: 'zod-params', origin: '.phada/config.yml', status: 'applied' },
      { key: 'src/api/.phada/rules.md', origin: 'src/api/.phada/rules.md', status: 'applied' },
    ])
    expect(loaded.report.configFiles).toEqual([
      { path: '.phada/config.yml', origin: 'repository', status: 'loaded' },
      { path: 'src/api/.phada/config.yml', origin: 'repository', status: 'loaded' },
      { path: 'src/api/.phada/rules.md', origin: 'repository', status: 'loaded' },
    ])
  })

  it('reads only the .phada files that exist in the tree', async () => {
    const sources = fakeSources({ 'src/api/users.ts': 'x' })

    await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(sources.repoReads).toEqual([])
  })

  it('warns about an invalid config and still uses the rules.md next to it', async () => {
    const sources = fakeSources({
      '.phada/config.yml': 'colour: red',
      '.phada/rules.md': 'Use the ORM.',
    })

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.report.configFiles[0]).toMatchObject({
      path: '.phada/config.yml',
      status: 'invalid',
    })
    expect(loaded.report.warnings[0]).toMatch(/^Ignoring \.phada\/config\.yml at b1b2c3d: colour: /)
    expect(loaded.context.rules.map((rule) => rule.key)).toEqual(['.phada/rules.md'])
  })

  it('ignores lockfiles and configured paths before the review', async () => {
    const diff = DIFF + modifiedFile('src/gen/types.ts')
    const sources = fakeSources({ '.phada/config.yml': 'ignore: ["src/gen/**"]' })

    const loaded = await loadContext({ diff, baseSha: SHA, userLayers: [], sources })

    expect(loaded.diff).toBe(modifiedFile('src/api/users.ts'))
    expect(loaded.context.ignored).toEqual(['package-lock.json', 'src/gen/types.ts'])
    expect(loaded.report.ignored).toEqual(['package-lock.json', 'src/gen/types.ts'])
  })

  it('takes the options of the root config', async () => {
    const sources = fakeSources({ '.phada/config.yml': 'language: pt-BR\nverify: true' })

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.options).toEqual({ language: 'pt-BR', verify: true })
  })

  it('keeps the user rules when the repository cannot be read', async () => {
    const sources = fakeSources({}, { tree: new Error('GitHub rejected the token (HTTP 403)') })

    const loaded = await loadContext({
      diff: DIFF,
      baseSha: SHA,
      userLayers: [userLayer({ rules: [{ id: 'early', rule: 'Prefer early returns.' }] })],
      sources,
    })

    expect(loaded.report.warnings).toEqual([
      'Could not read the repository at b1b2c3d (GitHub rejected the token (HTTP 403)): reviewing without its rules and docs. Reading them needs a token with Contents: read.',
    ])
    expect(loaded.context.rules.map((rule) => rule.key)).toEqual(['early'])
    expect(loaded.context.docs).toEqual([])
    expect(loaded.diff).toBe(modifiedFile('src/api/users.ts'))
  })

  it('fills the budget in priority order, cutting large docs and omitting what does not fit', async () => {
    const doc = (kilobytes: number) => `${'x'.repeat(999)}\n`.repeat(kilobytes)
    const sources = fakeSources({
      '.phada/config.yml': [
        'context:',
        '  defaults: false',
        '  files:',
        '    - path: a.md',
        '    - path: b.md',
        '    - path: c.md',
        '    - path: d.md',
      ].join('\n'),
      'a.md': doc(30),
      'b.md': doc(25),
      'c.md': doc(10),
      'd.md': doc(25),
    })

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.report.docs.map(({ path, status, reason }) => [path, status, reason])).toEqual([
      ['a.md', 'truncated', undefined],
      ['b.md', 'truncated', undefined],
      ['c.md', 'included', undefined],
      ['d.md', 'omitted', 'budget'],
    ])
    expect(loaded.context.docs.map((entry) => entry.path)).toEqual(['a.md', 'b.md', 'c.md'])
    expect(loaded.context.docs[0]?.content).toMatch(/\[truncated by Phada: 19999 of 30000 bytes\]$/)
    expect(loaded.report.budget).toEqual({ limit: 60_000, used: 49_998 })
    expect(sources.repoReads).not.toContain('d.md')
  })

  it('reports binary, unreadable and missing docs', async () => {
    const sources = fakeSources(
      {
        '.phada/config.yml':
          'context:\n  defaults: false\n  files:\n    - path: bin.md\n    - path: slow.md\n    - path: gone.md',
        'bin.md': 'a\u0000b',
        'slow.md': 'text',
      },
      { failing: ['slow.md'] },
    )

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.report.docs.map(({ path, status, reason }) => [path, status, reason])).toEqual([
      ['bin.md', 'omitted', 'binary'],
      ['slow.md', 'omitted', 'unreadable'],
      ['gone.md', 'omitted', 'not-found'],
    ])
    expect(loaded.report.warnings).toEqual([
      '.phada/config.yml: gone.md matches no file at b1b2c3d.',
      'Could not read slow.md at b1b2c3d: GitHub did not respond within 30s',
    ])
  })

  it('adds local files from the user config after the repository files it declares', async () => {
    const sources = fakeSources(
      { '.phada/config.yml': 'context:\n  files:\n    - path: docs/a.md', 'docs/a.md': 'A' },
      {
        local: { '~/notes': [{ path: '/home/u/notes/rules.md', size: 5 }] },
        localText: { '/home/u/notes/rules.md': 'Rules' },
      },
    )

    const loaded = await loadContext({
      diff: DIFF,
      baseSha: SHA,
      userLayers: [userLayer({ localFiles: ['~/notes', '/missing'] })],
      sources,
    })

    expect(sources.localLists).toEqual(['~/notes', '/missing'])
    expect(loaded.context.docs).toEqual([
      { path: 'docs/a.md', content: 'A' },
      { path: 'local:/home/u/notes/rules.md', content: 'Rules' },
    ])
    expect(loaded.report.docs[2]).toEqual({
      path: 'local:/missing',
      origin: 'local',
      category: 'declared',
      bytes: 0,
      status: 'omitted',
      reason: 'not-found',
    })
    expect(loaded.report.warnings).toEqual(['user:config.yml: /missing does not exist.'])
  })

  it('probes known paths when the tree is too large to list', async () => {
    const sources = fakeSources(
      { 'AGENTS.md': 'Be careful.', '.phada/rules.md': 'Use the ORM.' },
      { tree: { entries: [], truncated: true } },
    )

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.report.warnings[0]).toBe(
      'The repository tree at b1b2c3d is too large to list: only known paths were read.',
    )
    expect(loaded.context.rules.map((rule) => rule.key)).toEqual(['.phada/rules.md'])
    expect(loaded.context.docs).toEqual([{ path: 'AGENTS.md', content: 'Be careful.' }])
    expect(loaded.report.docs.filter((entry) => entry.status !== 'omitted')).toHaveLength(1)
  })
})
