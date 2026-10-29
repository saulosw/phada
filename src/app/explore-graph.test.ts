import { describe, expect, it } from 'vitest'
import type { ConfigLayer } from '../config/types.js'
import type { MirrorOpening } from '../repository/git-mirror.js'
import type { IndexOpening, ReadOnlyIndex } from '../store/index-store.js'
import type { ObservedEdge } from '../store/observed-store.js'
import { indexFixture } from '../../test/support/index-fixture.js'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import { indexedCommit, openGraphExplorer } from './explore-graph.js'
import type {
  CallerSite,
  DependencyEntry,
  ExploredSymbol,
  ExplorerReaders,
  GraphExplorer,
} from './explore-graph.js'

const SHA = '1'.repeat(40)

interface FakeRepository {
  files: Record<string, string>
  related?: string[]
  observed?: ObservedEdge[]
}

function fakeReaders(repos: Record<string, FakeRepository | 'missing'>) {
  const closed: string[] = []
  const readers: ExplorerReaders = {
    userLayers: async (repo) => {
      const fake = repos[repo]
      if (fake === undefined || fake === 'missing' || fake.related === undefined) return []
      const layer: ConfigLayer = {
        kind: 'user-repo',
        dir: '',
        configLabel: `user:repos/${repo}/config.yml`,
        config: { context: { repos: fake.related } },
      }
      return [layer]
    },
    openIndex: async (repo): Promise<IndexOpening> => {
      const fake = repos[repo]
      const path = `/cache/index/${repo}.sqlite`
      if (fake === undefined || fake === 'missing') return { status: 'missing', path }
      const { store } = await indexFixture(fake.files, { sha: SHA })
      const index: ReadOnlyIndex = {
        path,
        snapshot: {
          sha: SHA,
          ref: 'HEAD',
          defaultBranch: true,
          indexedAt: '2026-10-28T10:00:00.000Z',
          durationMs: 10,
        },
        summary: (sha) => store.summary(sha),
        leftOut: () => [],
        reader: (sha) => store.reader(sha),
        close: () => {
          closed.push(repo)
          store.close()
        },
      }
      return { status: 'open', index }
    },
    openMirror: async (repo): Promise<MirrorOpening> => {
      const fake = repos[repo]
      if (fake === undefined || fake === 'missing') {
        return { status: 'missing', dir: `/cache/repos/${repo}.git` }
      }
      return { status: 'open', mirror: memoryMirror(fake.files, { sha: SHA }) }
    },
    readObserved: async (repo) => {
      const fake = repos[repo]
      return fake === undefined || fake === 'missing' ? [] : (fake.observed ?? [])
    },
  }
  return { readers, closed }
}

const CORE = {
  'package.json': JSON.stringify({ name: '@acme/core', main: 'dist/index.js' }),
  'src/index.ts': "export * from './users.js'\n",
  'src/users.ts': [
    "import { normalize } from './normalize.js'",
    'export function getUser(id: string) {',
    '  return normalize(id)',
    '}',
  ].join('\n'),
  'src/normalize.ts': 'export function normalize(id: string) {\n  return id.trim()\n}\n',
  'src/admin.ts': "import { getUser } from './users.js'\nexport const admin = getUser('root')\n",
}

const WEB = {
  'package.json': JSON.stringify({ name: 'web', dependencies: { '@acme/core': '^1' } }),
  'src/page.ts': [
    "import { getUser } from '@acme/core'",
    'export function load(id: string) {',
    '  return getUser(id)',
    '}',
  ].join('\n'),
  'src/main.ts': [
    "import { load } from './page.js'",
    'export function main() {',
    "  return load('1')",
    '}',
  ].join('\n'),
  'src/legacy.ts': 'function load() {\n  return 0\n}\nexport const legacy = load()\n',
}

const site = (item: CallerSite) =>
  `${item.repo}:${item.path}:${item.line}${item.in === undefined ? '' : ` in ${item.in.name}`}${item.how === 'resolved' ? '' : ` ${item.how}`}`
const dependency = (item: DependencyEntry) =>
  item.target === undefined
    ? `${item.name} ${item.module ?? '?'}`
    : `${item.name} → ${item.target.repo}:${item.target.path}:${item.target.line}`

async function opened(
  repo: string,
  repos: Record<string, FakeRepository | 'missing'>,
): Promise<{ explorer: GraphExplorer; closed: string[] }> {
  const { readers, closed } = fakeReaders(repos)
  const opening = await openGraphExplorer(repo, readers)
  if (opening.state !== 'open') throw new Error(`not open: ${JSON.stringify(opening)}`)
  return { explorer: opening.explorer, closed }
}

function only(definitions: readonly ExploredSymbol[], path: string): ExploredSymbol {
  const found = definitions.find((item) => item.path === path)
  if (found === undefined) throw new Error(`no definition in ${path}`)
  return found
}

describe('openGraphExplorer', () => {
  it('finds every definition of an ambiguous name with where it is and what it is', async () => {
    const { explorer } = await opened('acme/web', { 'acme/web': { files: WEB } })

    const found = explorer.search('load')

    expect(found.more).toBe(0)
    expect(found.definitions).toEqual([
      expect.objectContaining({
        repo: 'acme/web',
        path: 'src/page.ts',
        line: 2,
        kind: 'function',
        name: 'load',
        exported: true,
        signature: expect.stringContaining('load(id: string)'),
      }),
      expect.objectContaining({ repo: 'acme/web', path: 'src/legacy.ts', exported: false }),
    ])
  })

  it('finds nothing for a name the index does not know', async () => {
    const { explorer } = await opened('acme/web', { 'acme/web': { files: WEB } })

    expect(explorer.search('nowhere')).toEqual({ definitions: [], more: 0 })
  })

  it('follows the dependencies into a declared related repository and on from there', async () => {
    const { explorer } = await opened('acme/web', {
      'acme/web': { files: WEB, related: ['acme/core'] },
      'acme/core': { files: CORE },
    })
    expect(explorer.linked).toEqual(['acme/core'])

    const load = only(explorer.search('load').definitions, 'src/page.ts')
    const dependencies = explorer.dependencies(load)
    expect(dependencies.dependencies.map(dependency)).toEqual([
      'getUser → acme/core:src/users.ts:2',
    ])

    const getUser = dependencies.dependencies[0]?.target
    if (getUser === undefined) throw new Error('getUser was not resolved')
    expect(explorer.dependencies(getUser).dependencies.map(dependency)).toEqual([
      'normalize → acme/core:src/normalize.ts:1',
    ])
  })

  it('follows the callers into the consumers and on into their own callers', async () => {
    const { explorer } = await opened('acme/core', {
      'acme/core': { files: CORE, related: ['acme/web'] },
      'acme/web': { files: WEB },
    })

    const getUser = only(explorer.search('getUser').definitions, 'src/users.ts')
    const callers = explorer.callers(getUser)
    expect(callers.sites.map(site)).toEqual([
      'acme/core:src/admin.ts:2',
      'acme/web:src/page.ts:3 in load',
    ])
    expect(callers).toMatchObject({ more: 0, capped: false })

    const load = callers.sites[1]?.in
    if (load === undefined) throw new Error('no enclosing symbol')
    expect(explorer.callers(load).sites.map(site)).toEqual(['acme/web:src/main.ts:3 in main'])
  })

  it('reaches back into the explored repository from a related one', async () => {
    const { explorer } = await opened('acme/web', {
      'acme/web': { files: WEB, related: ['acme/core'] },
      'acme/core': { files: CORE },
    })
    const load = only(explorer.search('load').definitions, 'src/page.ts')
    const getUser = explorer.dependencies(load).dependencies[0]?.target
    if (getUser === undefined) throw new Error('getUser was not resolved')

    expect(explorer.callers(getUser).sites.map(site)).toEqual([
      'acme/core:src/admin.ts:2',
      'acme/web:src/page.ts:3 in load',
    ])
  })

  it('links only the declared related repositories that have an index and a link', async () => {
    const { explorer } = await opened('acme/web', {
      'acme/web': { files: WEB, related: ['acme/core', 'acme/docs', 'acme/gone'] },
      'acme/core': { files: CORE },
      'acme/docs': { files: { 'requirements.txt': 'mkdocs\n' } },
      'acme/gone': 'missing',
    })

    expect(explorer.linked).toEqual(['acme/core'])
  })

  it('keeps 20 items of a level and counts the rest', async () => {
    const callers = Array.from(
      { length: 25 },
      (_, n) => `export function caller${n}() {\n  return target()\n}`,
    )
    const { explorer } = await opened('acme/many', {
      'acme/many': {
        files: {
          'src/target.ts': 'export function target() {\n  return 1\n}\n',
          'src/callers.ts': ["import { target } from './target.js'", ...callers].join('\n'),
        },
      },
    })

    const target = only(explorer.search('target').definitions, 'src/target.ts')
    const found = explorer.callers(target)
    expect(found.sites).toHaveLength(20)
    expect(found.more).toBe(5)

    const many = await opened('acme/loads', {
      'acme/loads': {
        files: Object.fromEntries(
          Array.from({ length: 25 }, (_, n) => [
            `src/load${n}.ts`,
            `export function load() {\n  return ${n}\n}\n`,
          ]),
        ),
      },
    })
    expect(many.explorer.search('load')).toMatchObject({ more: 5 })
    expect(many.explorer.search('load').definitions).toHaveLength(20)
  })

  it('shows the relations learned from reviews as observed', async () => {
    const { explorer } = await opened('acme/core', {
      'acme/core': {
        files: CORE,
        observed: [
          {
            from: { path: 'src/admin.ts' },
            to: { path: 'src/normalize.ts', kind: 'function', name: 'normalize' },
            pullRequest: 7,
            commit: SHA,
          },
        ],
      },
    })
    const normalize = only(explorer.search('normalize').definitions, 'src/normalize.ts')

    expect(explorer.callers(normalize).sites.map(site)).toContain(
      'acme/core:src/admin.ts:1 observed',
    )
  })

  it('says the repository is not indexed, without opening anything else', async () => {
    const { readers } = fakeReaders({ 'acme/web': 'missing' })

    expect(await openGraphExplorer('acme/web', readers)).toEqual({
      state: 'not-indexed',
      why: { reason: 'no-index' },
    })
  })

  it('closes the index of the explored repository and of each related one', async () => {
    const { explorer, closed } = await opened('acme/web', {
      'acme/web': { files: WEB, related: ['acme/core'] },
      'acme/core': { files: CORE },
    })

    explorer.close()

    expect(closed.sort()).toEqual(['acme/core', 'acme/web'])
  })
})

describe('indexedCommit', () => {
  it('reads the commit of the index snapshot, or none without an index', async () => {
    const { readers } = fakeReaders({ 'acme/web': { files: WEB }, 'acme/gone': 'missing' })

    expect(await indexedCommit('acme/web', readers)).toBe(SHA)
    expect(await indexedCommit('acme/gone', readers)).toBeUndefined()
  })
})
