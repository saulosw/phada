import { describe, expect, it } from 'vitest'
import { modifiedFile } from '../../test/support/diff-sections.js'
import type { ConfigLayer } from '../config/types.js'
import { loadContext } from '../context/load-context.js'
import type { ContextSources } from '../context/types.js'
import { localRules, readRules } from './read-rules.js'
import type { RulesReaders } from './read-rules.js'

const BASE = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const DIFF = modifiedFile('src/frontend/a.ts')
const FILES: Record<string, string> = {
  '.github/instructions/backend.instructions.md': '---\napplyTo: "src/backend/**"\n---\nUTC.\n',
  'AGENTS.md': 'Agents.',
}

function sourcesOf(files: Record<string, string>): ContextSources {
  return {
    readTree: async () => ({
      entries: Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
      truncated: false,
    }),
    readRepoFile: async (path) => files[path] ?? null,
    readLocalFile: async () => null,
    listLocalDocs: async () => null,
  }
}

function readers(
  options: {
    files?: Record<string, string>
    repository?: Awaited<ReturnType<RulesReaders['fetchRepository']>>
    readTree?: ContextSources['readTree']
  } = {},
) {
  const refs: string[] = []
  const pulls: number[] = []
  const value: RulesReaders = {
    fetchPullRequest: async (number) => {
      pulls.push(number)
      return { diff: DIFF, baseSha: BASE }
    },
    fetchRepository: async () => options.repository ?? { empty: false, defaultBranch: 'trunk' },
    sourcesAt: (ref) => {
      refs.push(ref)
      const sources = sourcesOf(options.files ?? FILES)
      return options.readTree === undefined ? sources : { ...sources, readTree: options.readTree }
    },
  }
  return { readers: value, refs, pulls }
}

const user = (config: ConfigLayer['config']): ConfigLayer => ({
  kind: 'user',
  dir: '',
  configLabel: 'user:config.yml',
  config,
})

describe('readRules', () => {
  it('reads the context the review of a pull request gets, at its base', async () => {
    const h = readers()

    const read = await readRules({
      target: { kind: 'pull-request', number: 12 },
      userLayers: [],
      readers: h.readers,
    })

    const loaded = await loadContext({
      diff: DIFF,
      baseSha: BASE,
      userLayers: [],
      sources: sourcesOf(FILES),
    })
    expect(read).toMatchObject({
      status: 'read',
      target: { kind: 'pull-request', number: 12, baseSha: BASE },
      report: loaded.report,
      lens: { kind: 'built-in' },
    })
    expect(read.status === 'read' && read.ignore).toContain('**/package-lock.json')
    expect(h.pulls).toEqual([12])
    expect(h.refs).toEqual([BASE])
  })

  it('lists the context of the default branch without evaluating scopes', async () => {
    const h = readers()

    const read = await readRules({
      target: { kind: 'default-branch' },
      userLayers: [user({ ignore: ['dist/**'] })],
      readers: h.readers,
    })

    expect(read.status).toBe('read')
    if (read.status !== 'read') return
    expect(read.target).toEqual({ kind: 'default-branch', ref: 'trunk' })
    expect(read.report.docs.map(({ path, status, scope }) => [path, status, scope])).toEqual([
      ['AGENTS.md', 'listed', undefined],
      ['.github/instructions/backend.instructions.md', 'listed', ['src/backend/**']],
    ])
    expect(read.ignore.at(-1)).toBe('dist/**')
    expect(h.refs).toEqual(['trunk'])
    expect(h.pulls).toEqual([])
  })

  it('says the repository is empty instead of reading a branch', async () => {
    const h = readers({ repository: { empty: true } })

    expect(
      await readRules({ target: { kind: 'default-branch' }, userLayers: [], readers: h.readers }),
    ).toEqual({ status: 'empty' })
    expect(h.refs).toEqual([])
  })

  it('fails when the repository tree cannot be read', async () => {
    const h = readers({ readTree: () => Promise.reject(new Error('Resource not accessible')) })

    await expect(
      readRules({ target: { kind: 'default-branch' }, userLayers: [], readers: h.readers }),
    ).rejects.toThrow('Resource not accessible')
  })

  it('gives the own prompt of the repository as the lens, with its mode and origin', async () => {
    const h = readers({
      files: {
        '.phada/config.yml': 'review:\n  prompt:\n    file: .phada/lens.md\n    mode: replace\n',
      },
    })

    const read = await readRules({
      target: { kind: 'pull-request', number: 12 },
      userLayers: [],
      readers: h.readers,
    })

    expect(read.status === 'read' && read.lens).toEqual({
      kind: 'prompt',
      prompt: {
        file: '.phada/lens.md',
        mode: 'replace',
        origin: '.phada/config.yml',
        source: 'repository',
      },
      setBy: { kind: 'repository-file', name: '.phada/config.yml' },
    })
  })

  it('gives the skills of the user config as the lens', async () => {
    const h = readers()

    const read = await readRules({
      target: { kind: 'default-branch' },
      userLayers: [
        user({ review: { skills: ['security', { name: 'phada', paths: ['src/**'] }] } }),
      ],
      readers: h.readers,
    })

    expect(read.status === 'read' && read.lens).toEqual({
      kind: 'skills',
      skills: {
        entries: [{ name: 'security' }, { name: 'phada', paths: ['src/**'] }],
        origin: 'user:config.yml',
        source: 'local',
      },
      prompt: null,
      setBy: { kind: 'global', name: 'config.yml' },
    })
  })
})

describe('localRules', () => {
  const userRepo = (config: ConfigLayer['config']): ConfigLayer => ({
    kind: 'user-repo',
    dir: '',
    configLabel: 'user:repos/acme/shop/config.yml',
    config,
  })

  it('gives the built-in lens and no rules without user config', () => {
    expect(localRules([])).toEqual({ lens: { kind: 'built-in' }, rules: [], warnings: [] })
  })

  it('gives the lens of the user layers and their rules, global or of the repository', () => {
    const read = localRules([
      user({
        rules: [{ id: 'utc', rule: 'Store times in UTC.' }],
        review: { prompt: { file: '/home/ana/lens.md' } },
      }),
      {
        ...userRepo({ rules: [{ rule: 'Money in cents.' }] }),
        rulesMarkdown: { label: 'user:repos/acme/shop/rules.md', text: 'No floats.' },
      },
    ])

    expect(read.lens).toEqual({
      kind: 'prompt',
      prompt: {
        file: '/home/ana/lens.md',
        mode: 'append',
        origin: 'user:config.yml',
        source: 'local',
      },
      setBy: { kind: 'global', name: 'config.yml' },
    })
    expect(read.rules).toEqual([
      { key: 'utc', name: 'utc', text: 'Store times in UTC.', origin: 'global' },
      {
        key: 'user:repos/acme/shop/config.yml#1',
        name: 'config.yml#1',
        text: 'Money in cents.',
        origin: 'repository',
      },
      {
        key: 'user:repos/acme/shop/rules.md',
        name: 'rules.md',
        text: 'No floats.',
        origin: 'repository',
      },
    ])
  })
})
