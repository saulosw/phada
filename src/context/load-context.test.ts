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
      {
        key: 'orm-only',
        origin: '.phada/config.yml',
        scope: ['**/*.py'],
        status: 'out-of-scope',
      },
      { key: 'no-console', origin: '.phada/config.yml', scope: ['**'], status: 'disabled' },
      {
        key: 'zod-params',
        origin: '.phada/config.yml',
        scope: ['**'],
        severity: 'P1',
        status: 'applied',
      },
      {
        key: 'src/api/.phada/rules.md',
        origin: 'src/api/.phada/rules.md',
        scope: ['src/api/**'],
        status: 'applied',
      },
    ])
    expect(loaded.report.configFiles).toEqual([
      { path: '.phada/config.yml', origin: 'repository', status: 'loaded' },
      { path: 'src/api/.phada/config.yml', origin: 'repository', status: 'loaded' },
      { path: 'src/api/.phada/rules.md', origin: 'repository', status: 'loaded' },
    ])
  })

  it('applies the rules of a subfolder whose name has glob characters', async () => {
    const sources = fakeSources({ 'app/(marketing)/.phada/rules.md': 'Use the design system.' })

    const loaded = await loadContext({
      diff: modifiedFile('app/(marketing)/page.tsx'),
      baseSha: SHA,
      userLayers: [],
      sources,
    })

    expect(loaded.report.rules).toEqual([
      {
        key: 'app/(marketing)/.phada/rules.md',
        origin: 'app/(marketing)/.phada/rules.md',
        scope: ['app/\\(marketing\\)/**'],
        status: 'applied',
      },
    ])
  })

  it('sends a file declared in a folder named like a dynamic route', async () => {
    const sources = fakeSources({
      'app/[id]/.phada/config.yml': 'context:\n  files:\n    - path: README.md',
      'app/[id]/README.md': 'Pages under [id] load the record first.',
    })

    const loaded = await loadContext({
      diff: modifiedFile('app/[id]/page.tsx'),
      baseSha: SHA,
      userLayers: [],
      sources,
    })

    expect(loaded.context.docs).toContainEqual({
      path: 'app/[id]/README.md',
      content: 'Pages under [id] load the record first.',
    })
    expect(loaded.report.warnings).toEqual([])
  })

  it('turns a rule off everywhere when the root or the user disables it', async () => {
    const sources = fakeSources({
      '.phada/config.yml': 'rules:\n  - id: no-console\n    rule: No console.log.',
    })

    const loaded = await loadContext({
      diff: modifiedFile('src/web/a.ts'),
      baseSha: SHA,
      userLayers: [userLayer({ disabledRules: ['no-console'] })],
      sources,
    })

    expect(loaded.context.rules).toEqual([])
    expect(loaded.report.rules).toEqual([
      { key: 'no-console', origin: '.phada/config.yml', scope: ['**'], status: 'disabled' },
    ])
  })

  it('turns a rule off only inside the subfolder that disables it', async () => {
    const files = {
      '.phada/config.yml': 'rules:\n  - id: no-console\n    rule: No console.log.',
      'src/api/.phada/config.yml': 'disabledRules: [no-console]',
    }

    const both = await loadContext({
      diff: modifiedFile('src/api/users.ts') + modifiedFile('src/web/a.ts'),
      baseSha: SHA,
      userLayers: [],
      sources: fakeSources(files),
    })
    const onlyApi = await loadContext({
      diff: modifiedFile('src/api/users.ts'),
      baseSha: SHA,
      userLayers: [],
      sources: fakeSources(files),
    })

    expect(both.context.rules).toEqual([
      {
        key: 'no-console',
        text: 'No console.log.',
        scope: ['**'],
        except: ['src/api/**'],
        origin: '.phada/config.yml',
      },
    ])
    expect(both.report.rules).toEqual([
      { key: 'no-console', origin: '.phada/config.yml', scope: ['**'], status: 'applied' },
    ])
    expect(onlyApi.report.rules).toEqual([
      { key: 'no-console', origin: '.phada/config.yml', scope: ['**'], status: 'disabled' },
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
    expect(loaded.ignore).toEqual(['src/gen/**'])
  })

  it('takes the options of the root config', async () => {
    const sources = fakeSources({
      '.phada/config.yml': 'language: pt-BR\nverify: true\ninvestigate: false',
    })

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.options).toEqual({ language: 'pt-BR', verify: true, investigate: false })
  })

  it('passes the related repositories and privateOnPublic on', async () => {
    const sources = fakeSources({ '.phada/config.yml': 'context:\n  repos: [acme/web]' })
    const userLayers = [userLayer({ context: { repos: ['acme/sdk'], privateOnPublic: true } })]

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers, sources })

    expect(loaded.repos).toEqual([
      { repo: 'acme/web', origin: '.phada/config.yml' },
      { repo: 'acme/sdk', origin: 'user:config.yml' },
    ])
    expect(loaded.privateOnPublic).toBe(true)
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

  it('gives back the budget of docs that turn out binary or unreadable', async () => {
    const doc = (kilobytes: number) => `${'x'.repeat(999)}\n`.repeat(kilobytes)
    const sources = fakeSources(
      {
        '.phada/config.yml': [
          'context:',
          '  defaults: false',
          '  files:',
          '    - path: a.md',
          '    - path: bin.md',
          '    - path: slow.md',
          '    - path: b.md',
          '    - path: c.md',
        ].join('\n'),
        'a.md': doc(30),
        'bin.md': `a\u0000${'x'.repeat(19_998)}`,
        'slow.md': doc(20),
        'b.md': doc(15),
        'c.md': doc(15),
      },
      { failing: ['slow.md'] },
    )

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.report.docs.map(({ path, status, reason }) => [path, status, reason])).toEqual([
      ['a.md', 'truncated', undefined],
      ['bin.md', 'omitted', 'binary'],
      ['slow.md', 'omitted', 'unreadable'],
      ['b.md', 'included', undefined],
      ['c.md', 'included', undefined],
    ])
    expect(loaded.report.budget.used).toBe(49_999)
    expect(loaded.report.warnings).toEqual([
      'Could not read slow.md at b1b2c3d: GitHub did not respond within 30s',
    ])
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

  it('sends a local file once when two configs list it', async () => {
    const doc = { path: '/home/u/notes/team.md', size: 4 }
    const sources = fakeSources(
      {},
      {
        local: { '~/notes': [doc], '~/notes/team.md': [doc] },
        localText: { '/home/u/notes/team.md': 'Team' },
      },
    )

    const loaded = await loadContext({
      diff: DIFF,
      baseSha: SHA,
      userLayers: [
        userLayer({ localFiles: ['~/notes'] }),
        { ...userLayer({ localFiles: ['~/notes/team.md'] }), kind: 'user-repo' },
      ],
      sources,
    })

    expect(loaded.context.docs).toEqual([{ path: 'local:/home/u/notes/team.md', content: 'Team' }])
    expect(loaded.report.docs).toHaveLength(1)
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
    expect(loaded.report.docs.map((entry) => entry.path)).not.toContain('.cursorrules')
  })

  describe('instruction files with a scope', () => {
    const BACKEND = '.github/instructions/backend.instructions.md'
    const backend = '---\napplyTo: "src/backend/**"\n---\nAlways use UTC.\n'

    it('sends a scoped file when a changed file matches and reports its scope', async () => {
      const sources = fakeSources({ [BACKEND]: backend })

      const loaded = await loadContext({
        diff: modifiedFile('src/backend/a.ts'),
        baseSha: SHA,
        userLayers: [],
        sources,
      })

      expect(loaded.context.docs).toEqual([{ path: BACKEND, content: backend }])
      expect(loaded.report.docs).toEqual([
        {
          path: BACKEND,
          origin: 'repository',
          category: 'agents',
          bytes: backend.length,
          status: 'included',
          scope: ['src/backend/**'],
        },
      ])
    })

    it('leaves a scoped file out when no changed file matches', async () => {
      const sources = fakeSources({ [BACKEND]: backend })

      const loaded = await loadContext({
        diff: modifiedFile('src/frontend/a.ts'),
        baseSha: SHA,
        userLayers: [],
        sources,
      })

      expect(loaded.context.docs).toEqual([])
      expect(loaded.report.docs).toEqual([
        {
          path: BACKEND,
          origin: 'repository',
          category: 'agents',
          bytes: backend.length,
          status: 'omitted',
          reason: 'out-of-scope',
          scope: ['src/backend/**'],
        },
      ])
      expect(loaded.report.budget.used).toBe(0)
    })

    it('leaves manual and excluded files out and keeps an unreadable front matter with a warning', async () => {
      const sources = fakeSources({
        '.cursor/rules/manual.mdc': '# Attach me by hand\n',
        '.cursor/rules/broken.mdc': '---\nglobs: src/**\n# no end\n',
        '.github/instructions/x.instructions.md':
          '---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\nOnly for coding.\n',
      })

      const loaded = await loadContext({
        diff: modifiedFile('src/a.ts'),
        baseSha: SHA,
        userLayers: [],
        sources,
      })

      expect(loaded.context.docs.map((doc) => doc.path)).toEqual(['.cursor/rules/broken.mdc'])
      expect(loaded.report.docs.map(({ path, status, reason }) => [path, status, reason])).toEqual([
        ['.github/instructions/x.instructions.md', 'omitted', 'excluded'],
        ['.cursor/rules/broken.mdc', 'included', undefined],
        ['.cursor/rules/manual.mdc', 'omitted', 'manual'],
      ])
      expect(loaded.report.warnings).toContain(
        '.cursor/rules/broken.mdc: could not read its front matter; included without a scope.',
      )
    })

    it('matches scopes against the changed files left after ignore', async () => {
      const sources = fakeSources({ '.cursor/rules/json.mdc': '---\nglobs: **/*.json\n---\nx\n' })

      const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

      expect(loaded.report.docs[0]).toMatchObject({ status: 'omitted', reason: 'out-of-scope' })
    })

    it('spends no budget on scoped files that do not apply', async () => {
      const outOfScope = `---\nglobs: lib/**\n---\n${'x'.repeat(18_000)}\n`
      const readme = 'r'.repeat(30_000)
      const sources = fakeSources({
        '.cursor/rules/a.mdc': outOfScope,
        '.cursor/rules/b.mdc': outOfScope,
        '.cursor/rules/c.mdc': outOfScope,
        'README.md': readme,
      })

      const loaded = await loadContext({
        diff: modifiedFile('src/a.ts'),
        baseSha: SHA,
        userLayers: [],
        sources,
      })

      expect(loaded.report.docs.find((doc) => doc.path === 'README.md')).toMatchObject({
        status: 'truncated',
      })
      expect(loaded.report.budget.used).toBeGreaterThan(19_000)
    })

    it('sends a declared instruction file whatever its scope', async () => {
      const sources = fakeSources({ '.cursor/rules/x.mdc': '---\nglobs: lib/**\n---\nx\n' })

      const loaded = await loadContext({
        diff: modifiedFile('src/a.ts'),
        baseSha: SHA,
        userLayers: [userLayer({ context: { files: [{ path: '.cursor/rules/x.mdc' }] } })],
        sources,
      })

      expect(loaded.report.docs).toEqual([
        expect.objectContaining({
          path: '.cursor/rules/x.mdc',
          category: 'declared',
          status: 'included',
        }),
      ])
    })

    it('leaves a doc out when only files its negated patterns exclude changed', async () => {
      const sources = fakeSources({
        '.cursor/rules/src.mdc': '---\nglobs: src/**, !src/**/*.test.ts\n---\nx\n',
      })

      const loaded = await loadContext({
        diff: modifiedFile('src/a.test.ts'),
        baseSha: SHA,
        userLayers: [],
        sources,
      })

      expect(loaded.report.docs[0]).toMatchObject({ status: 'omitted', reason: 'out-of-scope' })
    })

    it('makes a nested mdc file apply only inside its folder', async () => {
      const sources = fakeSources({
        'packages/web/.cursor/rules/r.mdc': '---\nglobs: *.tsx\n---\nUse hooks.\n',
      })
      const load = (path: string) =>
        loadContext({ diff: modifiedFile(path), baseSha: SHA, userLayers: [], sources })

      expect((await load('packages/web/src/a.tsx')).report.docs[0]).toMatchObject({
        status: 'included',
        category: 'module',
        scope: ['packages/web/**/*.tsx'],
      })
      expect((await load('packages/web/src/a.ts')).report.docs[0]).toMatchObject({
        status: 'omitted',
        reason: 'out-of-scope',
      })
    })
  })
})

describe('loadContext review options', () => {
  it('passes the review prompt and skills on', async () => {
    const sources = fakeSources({
      '.phada/config.yml': 'review:\n  prompt:\n    file: .phada/review.md',
    })

    const loaded = await loadContext({ diff: DIFF, baseSha: SHA, userLayers: [], sources })

    expect(loaded.options.review).toEqual({
      prompt: {
        file: '.phada/review.md',
        mode: 'append',
        origin: '.phada/config.yml',
        source: 'repository',
      },
    })
  })

  it('has no review options without review config', async () => {
    const loaded = await loadContext({
      diff: DIFF,
      baseSha: SHA,
      userLayers: [],
      sources: fakeSources({}),
    })

    expect(loaded.options).not.toHaveProperty('review')
  })
})
