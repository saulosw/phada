import { describe, expect, it } from 'vitest'
import type { ConfigLayer } from '../config/types.js'
import { listContext } from './list-context.js'
import type { ContextSources } from './types.js'

function sources(files: Record<string, string>, truncated = false): ContextSources {
  return {
    readTree: async () => ({
      entries: truncated
        ? []
        : Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
      truncated,
    }),
    readRepoFile: async (path) => files[path] ?? null,
    readLocalFile: async () => null,
    listLocalDocs: async () => null,
  }
}

const REF = 'main'

const userLayer = (config: ConfigLayer['config']): ConfigLayer => ({
  kind: 'user',
  dir: '',
  configLabel: 'user:config.yml',
  config,
})

describe('listContext', () => {
  it('lists the rules of every .phada folder with their scope, severity and disabled state', async () => {
    const { report } = await listContext({
      ref: REF,
      userLayers: [],
      sources: sources({
        '.phada/config.yml': [
          'disabledRules: [old]',
          'rules:',
          '  - id: paginate',
          '    rule: Paginate lists.',
          '    scope: ["src/**"]',
          '    severity: P1',
          '  - id: old',
          '    rule: Old rule.',
        ].join('\n'),
        'api/.phada/rules.md': 'Use transactions.',
        'api/x.ts': 'x',
      }),
    })

    expect(report.rules).toEqual([
      {
        key: 'paginate',
        origin: '.phada/config.yml',
        scope: ['src/**'],
        severity: 'P1',
        status: 'listed',
      },
      { key: 'old', origin: '.phada/config.yml', scope: ['**'], status: 'disabled' },
      {
        key: 'api/.phada/rules.md',
        origin: 'api/.phada/rules.md',
        scope: ['api/**'],
        status: 'listed',
      },
    ])
    expect(report.configFiles).toEqual([
      { path: '.phada/config.yml', origin: 'repository', status: 'loaded' },
      { path: 'api/.phada/rules.md', origin: 'repository', status: 'loaded' },
    ])
  })

  it('lists the .claude/rules as rules with their paths, not as docs', async () => {
    const { report } = await listContext({
      ref: REF,
      userLayers: [userLayer({ disabledRules: ['.claude/rules/old.md'] })],
      sources: sources({
        '.claude/rules/sql.md': '---\npaths:\n  - "db/**/*.sql"\n---\nUse parameterized queries.\n',
        '.claude/rules/style.md': 'Prefer small functions.\n',
        '.claude/rules/old.md': 'Old.\n',
      }),
    })

    expect(report.rules).toEqual([
      {
        key: '.claude/rules/old.md',
        origin: '.claude/rules/old.md',
        scope: ['**'],
        status: 'disabled',
      },
      {
        key: '.claude/rules/sql.md',
        origin: '.claude/rules/sql.md',
        scope: ['db/**/*.sql'],
        status: 'listed',
      },
      {
        key: '.claude/rules/style.md',
        origin: '.claude/rules/style.md',
        scope: ['**'],
        status: 'listed',
      },
    ])
    expect(report.docs).toEqual([])
  })

  it('lists the docs with the scope of instruction files, without a budget', async () => {
    const big = 'x'.repeat(20_000)
    const { report } = await listContext({
      ref: REF,
      userLayers: [],
      sources: sources({
        'AGENTS.md': 'Agents.',
        'README.md': 'Readme.',
        '.cursor/rules/a.mdc': '---\nglobs: src/**\n---\nA\n',
        '.cursor/rules/m.mdc': '# manual\n',
        'web/README.md': 'Web.',
        'web/a.ts': 'x',
        'api/GEMINI.md': 'Gemini.',
        'api/README.md': 'Api.',
        ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`docs/d${i}.md`, big])),
      }),
    })

    const docs = report.docs.map(({ path, category, status, reason, scope }) => [
      path,
      category,
      status,
      reason,
      scope,
    ])
    expect(docs.slice(0, 7)).toEqual([
      ['api/README.md', 'module', 'listed', undefined, undefined],
      ['api/GEMINI.md', 'module', 'listed', undefined, undefined],
      ['AGENTS.md', 'agents', 'listed', undefined, undefined],
      ['.cursor/rules/a.mdc', 'agents', 'listed', undefined, ['src/**']],
      ['.cursor/rules/m.mdc', 'agents', 'omitted', 'manual', undefined],
      ['README.md', 'contributing', 'listed', undefined, undefined],
      ['docs/d0.md', 'other', 'listed', undefined, undefined],
    ])
    expect(report.docs.map((doc) => doc.path)).not.toContain('web/README.md')
    expect(report.docs.filter((doc) => doc.status === 'listed')).toHaveLength(15)
    expect(report.budget.used).toBe(0)
  })

  it('returns the effective ignore patterns and the user config files', async () => {
    const user: ConfigLayer = {
      kind: 'user',
      dir: '',
      configLabel: 'user:config.yml',
      config: { ignore: ['dist/**'] },
    }

    const { report, ignore } = await listContext({
      ref: REF,
      userLayers: [user],
      sources: sources({ '.phada/config.yml': 'ignore: ["gen/**"]' }),
    })

    expect(ignore).toContain('**/package-lock.json')
    expect(ignore.slice(-2)).toEqual(['dist/**', 'gen/**'])
    expect(report.configFiles[0]).toEqual({
      path: 'user:config.yml',
      origin: 'user',
      status: 'loaded',
    })
    expect(report.ignored).toEqual([])
  })

  it('returns the review settings of the branch, the repository over the user', async () => {
    const user: ConfigLayer = {
      kind: 'user',
      dir: '',
      configLabel: 'user:config.yml',
      config: { review: { skills: ['security'] } },
    }

    const { review } = await listContext({
      ref: REF,
      userLayers: [user],
      sources: sources({
        '.phada/config.yml': 'review:\n  prompt:\n    file: .phada/prompt.md\n    mode: replace\n',
      }),
    })

    expect(review).toEqual({
      prompt: {
        file: '.phada/prompt.md',
        mode: 'replace',
        origin: '.phada/config.yml',
        source: 'repository',
      },
      skills: { entries: [{ name: 'security' }], origin: 'user:config.yml', source: 'local' },
    })
  })

  it('probes the known docs when the tree is too large and skips the missing ones quietly', async () => {
    const { report } = await listContext({
      ref: REF,
      userLayers: [],
      sources: sources({ 'AGENTS.md': 'Agents.', '.phada/rules.md': 'Rule.' }, true),
    })

    expect(report.docs.map((doc) => [doc.path, doc.status, doc.bytes])).toEqual([
      ['AGENTS.md', 'listed', 7],
    ])
    expect(report.rules.map((rule) => rule.key)).toEqual(['.phada/rules.md'])
    expect(report.warnings[0]).toContain('too large to list')
  })
})
