import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConfigFile } from '../config/schema.js'
import type { ConfigLayer } from '../config/types.js'
import { runCommand, runCommandBytes } from '../process/run-command.js'
import { openExistingGitMirror } from '../repository/git-mirror.js'
import type { MirrorOpening } from '../repository/git-mirror.js'
import { IndexStoreError } from '../store/index-store.js'
import type { IndexOpening, ReadOnlyIndex } from '../store/index-store.js'
import { createLocalRepository } from '../../test/support/git-repo.js'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import { readConnections } from './read-connections.js'
import type { ConnectionReaders } from './read-connections.js'

const SHA = 'a'.repeat(40)

interface FakeRepository {
  files?: Record<string, string>
  index?: 'missing' | 'empty' | 'other-version' | 'unreadable' | 'throws'
  mirror?: 'missing' | 'unreadable'
  user?: ConfigFile
  userError?: string
}

function userLayer(repo: string, config: ConfigFile): ConfigLayer {
  return { kind: 'user-repo', dir: '', configLabel: `user:repos/${repo}/config.yml`, config }
}

function fakeReaders(repos: Record<string, FakeRepository>, listed = Object.keys(repos)) {
  const closed: string[] = []
  const opened: string[] = []
  const readers: ConnectionReaders = {
    repositories: async () => listed,
    userLayers: async (repo) => {
      const fake = repos[repo]
      if (fake?.userError !== undefined) throw new Error(fake.userError)
      return fake?.user === undefined ? [] : [userLayer(repo, fake.user)]
    },
    openIndex: async (repo): Promise<IndexOpening> => {
      const fake = repos[repo]
      const path = `/cache/index/${repo}.sqlite`
      opened.push(repo)
      if (fake === undefined || fake.index === 'missing') return { status: 'missing', path }
      if (fake.index === 'throws') throw new Error('disk on fire')
      if (fake.index === 'unreadable') {
        return { status: 'unreadable', path, error: new IndexStoreError('not a Phada index') }
      }
      if (fake.index === 'other-version') {
        return {
          status: 'other-version',
          path,
          found: { schemaVersion: '3', phadaVersion: '0.9.0' },
          expected: { schemaVersion: '3', phadaVersion: '1.2.3' },
        }
      }
      const index: ReadOnlyIndex = {
        path,
        snapshot:
          fake.index === 'empty'
            ? null
            : {
                sha: SHA,
                ref: 'HEAD',
                defaultBranch: true,
                indexedAt: '2026-10-28T10:00:00.000Z',
                durationMs: 10,
              },
        summary: () => {
          throw new Error('not used')
        },
        leftOut: () => [],
        reader: () => {
          throw new Error('not used')
        },
        close: () => closed.push(repo),
      }
      return { status: 'open', index }
    },
    openMirror: async (repo): Promise<MirrorOpening> => {
      const fake = repos[repo]
      if (fake === undefined || fake.mirror === 'missing') {
        return { status: 'missing', dir: `/cache/repos/${repo}.git` }
      }
      const mirror = memoryMirror(fake.files ?? {}, { sha: SHA })
      if (fake.mirror === 'unreadable') {
        return {
          status: 'open',
          mirror: {
            ...mirror,
            listFiles: async () => {
              throw new Error('fatal: not a tree object')
            },
          },
        }
      }
      return { status: 'open', mirror }
    },
  }
  return { readers, closed, opened }
}

const SHOP = {
  'package.json': JSON.stringify({ name: '@acme/shop', dependencies: { '@acme/ui': '^1' } }),
}
const UI = {
  'package.json': JSON.stringify({ name: '@acme/ui', devDependencies: { '@acme/shop': '^2' } }),
}
const DOCS = { 'requirements.txt': 'mkdocs\n' }

describe('readConnections', () => {
  it('links each declared related repository by the packages one publishes and the other uses', async () => {
    const { readers, closed } = fakeReaders({
      'acme/shop': {
        files: SHOP,
        user: { context: { repos: ['acme/ui', { repo: 'acme/docs', description: 'The docs' }] } },
      },
      'acme/ui': { files: UI },
      'acme/docs': { files: DOCS },
    })
    const { repositories } = await readConnections(readers)
    const shop = repositories.find(({ repo }) => repo === 'acme/shop')
    expect(shop).toEqual({
      repo: 'acme/shop',
      source: { state: 'read', commit: SHA },
      declared: {
        status: 'read',
        configError: null,
        warnings: [],
        related: [
          {
            repo: 'acme/ui',
            link: {
              state: 'linked',
              publishes: [{ ecosystem: 'npm', name: '@acme/shop' }],
              uses: [{ ecosystem: 'npm', name: '@acme/ui' }],
            },
          },
          { repo: 'acme/docs', description: 'The docs', link: { state: 'no-link' } },
        ],
      },
    })
    expect(closed.sort()).toEqual(['acme/docs', 'acme/shop', 'acme/ui'])
  })

  it('shows only the declared related repositories, even when another one is linked', async () => {
    const { readers } = fakeReaders({
      'acme/shop': { files: SHOP, user: { context: { repos: ['acme/docs'] } } },
      'acme/ui': { files: UI },
      'acme/docs': { files: DOCS },
    })
    const { repositories } = await readConnections(readers)
    const related = (repo: string) => {
      const found = repositories.find((entry) => entry.repo === repo)?.declared
      return found?.status === 'read' ? found.related.map((entry) => entry.repo) : undefined
    }
    expect(related('acme/shop')).toEqual(['acme/docs'])
    expect(related('acme/ui')).toEqual([])
  })

  it("adds the repositories the repository's own .phada/config.yml declares at its snapshot, in the review's order", async () => {
    const { readers } = fakeReaders({
      'acme/shop': {
        files: {
          ...SHOP,
          '.phada/config.yml': 'context:\n  repos:\n    - acme/ui\n    - acme/shop\n',
        },
        user: { context: { repos: ['acme/docs'] } },
      },
      'acme/ui': { files: UI },
      'acme/docs': { files: DOCS },
    })
    const [shop] = (await readConnections(readers)).repositories
    expect(shop?.declared).toMatchObject({
      status: 'read',
      configError: null,
      related: [
        { repo: 'acme/docs', link: { state: 'no-link' } },
        { repo: 'acme/ui', link: { state: 'linked' } },
      ],
    })
  })

  it('ignores an invalid .phada/config.yml and says why', async () => {
    const { readers } = fakeReaders({
      'acme/shop': {
        files: { ...SHOP, '.phada/config.yml': 'context:\n  repos: [not a repo name]\n' },
        user: { context: { repos: ['acme/ui'] } },
      },
      'acme/ui': { files: UI },
    })
    const [shop] = (await readConnections(readers)).repositories
    expect(shop?.declared.status === 'read' && shop.declared.configError).toMatch(/owner\/repo/)
    expect(shop?.declared).toMatchObject({ related: [{ repo: 'acme/ui' }] })
  })

  it.each([
    [{ index: 'missing' }, { reason: 'no-index' }],
    [{ index: 'empty' }, { reason: 'empty' }],
    [
      { index: 'other-version' },
      {
        reason: 'other-version',
        found: { schemaVersion: '3', phadaVersion: '0.9.0' },
        expected: { schemaVersion: '3', phadaVersion: '1.2.3' },
      },
    ],
    [{ index: 'unreadable' }, { reason: 'unreadable', error: 'not a Phada index' }],
    [{ index: 'throws' }, { reason: 'unreadable', error: 'disk on fire' }],
    [{ mirror: 'missing' }, { reason: 'no-mirror' }],
    [{ mirror: 'unreadable' }, { reason: 'mirror-unreadable', error: 'fatal: not a tree object' }],
  ] as const)('says a related repository is not indexed (%o)', async (fake, why) => {
    const { readers } = fakeReaders(
      {
        'acme/shop': { files: SHOP, user: { context: { repos: ['acme/ui'] } } },
        'acme/ui': { files: UI, ...fake },
      },
      ['acme/shop'],
    )
    const [shop] = (await readConnections(readers)).repositories
    expect(shop?.declared).toMatchObject({
      related: [{ repo: 'acme/ui', link: { state: 'not-indexed', why } }],
    })
  })

  it('reads a declared repository that is not in the list by its own index and mirror', async () => {
    const { readers, opened } = fakeReaders(
      {
        'acme/shop': { files: SHOP, user: { context: { repos: ['Acme/UI'] } } },
        'acme/ui': { files: UI },
      },
      ['acme/shop'],
    )
    const [shop] = (
      await readConnections({
        ...readers,
        openIndex: (repo) => readers.openIndex(repo.toLowerCase()),
        openMirror: (repo) => readers.openMirror(repo.toLowerCase()),
      })
    ).repositories
    expect(shop?.declared).toMatchObject({
      related: [{ repo: 'Acme/UI', link: { state: 'linked' } }],
    })
    expect(opened).toEqual(['acme/shop', 'acme/ui'])
  })

  it('keeps the declared repositories of one that is not indexed, without their links', async () => {
    const { readers } = fakeReaders({
      'acme/shop': { index: 'missing', user: { context: { repos: ['acme/ui', 'acme/docs'] } } },
      'acme/ui': { files: UI },
      'acme/docs': { mirror: 'missing' },
    })
    const [shop] = (await readConnections(readers)).repositories
    expect(shop).toMatchObject({
      source: { state: 'not-indexed', why: { reason: 'no-index' } },
      declared: {
        status: 'read',
        related: [
          { repo: 'acme/ui', link: { state: 'unknown' } },
          { repo: 'acme/docs', link: { state: 'not-indexed', why: { reason: 'no-mirror' } } },
        ],
      },
    })
  })

  it('reads each repository once however many declare it', async () => {
    const { readers, opened } = fakeReaders({
      'acme/shop': { files: SHOP, user: { context: { repos: ['acme/ui'] } } },
      'acme/web': { files: SHOP, user: { context: { repos: ['acme/ui'] } } },
      'acme/ui': { files: UI },
    })
    await readConnections(readers)
    expect(opened.sort()).toEqual(['acme/shop', 'acme/ui', 'acme/web'])
  })

  it('says when the user config of a repository cannot be read', async () => {
    const { readers } = fakeReaders({
      'acme/shop': {
        files: SHOP,
        userError: 'Invalid config.yml: context.repos.0: use owner/repo',
      },
    })
    const [shop] = (await readConnections(readers)).repositories
    expect(shop?.declared).toEqual({
      status: 'invalid',
      error: 'Invalid config.yml: context.repos.0: use owner/repo',
    })
  })

  it('reads the manifests and the config from a real mirror without fetching, and creates no mirror', async () => {
    const shop = createLocalRepository({
      'package.json': JSON.stringify({ name: '@acme/shop', dependencies: { '@acme/ui': '^1' } }),
      '.phada/config.yml': 'context:\n  repos:\n    - acme/ui\n    - acme/docs\n',
    })
    const ui = createLocalRepository({
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
    })
    const cache = mkdtempSync(join(tmpdir(), 'phada-connections-'))
    try {
      const mirrorOf = (repo: string) => join(cache, 'repos', `${repo}.git`)
      for (const [repo, source] of [
        ['acme/shop', shop],
        ['acme/ui', ui],
      ] as const) {
        execFileSync('git', ['clone', '--bare', '-q', source.dir, mirrorOf(repo)])
        source.remove()
      }
      const commits: Record<string, string> = {
        'acme/shop': shop.sha,
        'acme/ui': ui.sha,
        'acme/docs': 'd'.repeat(40),
      }
      const git: string[][] = []
      const { readers } = fakeReaders({ 'acme/shop': {}, 'acme/ui': {}, 'acme/docs': {} }, [
        'acme/shop',
      ])
      const { repositories } = await readConnections({
        ...readers,
        userLayers: async () => [],
        openIndex: async (repo) => {
          const opening = await readers.openIndex(repo)
          if (opening.status !== 'open' || opening.index.snapshot === null) return opening
          const snapshot = { ...opening.index.snapshot, sha: commits[repo] ?? '' }
          return { status: 'open', index: { ...opening.index, snapshot } }
        },
        openMirror: (repo) =>
          openExistingGitMirror({
            dir: mirrorOf(repo),
            env: process.env,
            run: (command, args, options) => {
              git.push([...args])
              return runCommand(command, args, options)
            },
            runBytes: (command, args, options) => {
              git.push([...args])
              return runCommandBytes(command, args, options)
            },
          }),
      })
      expect(repositories).toEqual([
        {
          repo: 'acme/shop',
          source: { state: 'read', commit: shop.sha },
          declared: {
            status: 'read',
            configError: null,
            warnings: [],
            related: [
              {
                repo: 'acme/ui',
                link: {
                  state: 'linked',
                  publishes: [],
                  uses: [{ ecosystem: 'npm', name: '@acme/ui' }],
                },
              },
              { repo: 'acme/docs', link: { state: 'not-indexed', why: { reason: 'no-mirror' } } },
            ],
          },
        },
      ])
      expect(new Set(git.map((args) => args[2]))).toEqual(new Set(['ls-tree', 'cat-file']))
      expect(existsSync(mirrorOf('acme/docs'))).toBe(false)
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  })
})
