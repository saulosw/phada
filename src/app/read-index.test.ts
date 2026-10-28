import { describe, expect, it } from 'vitest'
import { IndexStoreError } from '../store/index-store.js'
import type {
  IndexOpening,
  IndexSummary,
  LeftOutPath,
  ReadOnlyIndex,
} from '../store/index-store.js'
import { extensionCounts, readIndexes } from './read-index.js'
import type { IndexReaders } from './read-index.js'

const SHA = 'a'.repeat(40)

const SUMMARY: IndexSummary = {
  files: {
    indexed: 40,
    ignored: 2,
    'no-grammar': 5,
    'too-large': 1,
    binary: 0,
    'parse-timeout': 0,
    'parse-failed': 0,
    missing: 0,
    symlink: 0,
    submodule: 0,
  },
  languages: { typescript: 30, python: 10 },
  symbols: { function: 120, class: 8 },
  imports: 90,
  exports: 60,
  calls: 400,
  references: 210,
  parseErrors: 1,
}

const LEFT_OUT: LeftOutPath[] = [
  { path: 'README.md', status: 'no-grammar' },
  { path: 'docs/a.md', status: 'no-grammar' },
  { path: 'docs/b.MD', status: 'no-grammar' },
  { path: 'data/x.json', status: 'no-grammar' },
  { path: 'Makefile', status: 'no-grammar' },
  { path: 'dist/big.js', status: 'too-large' },
  { path: 'package-lock.json', status: 'ignored' },
  { path: 'yarn.lock', status: 'ignored' },
]

function openIndex(path: string, snapshot: ReadOnlyIndex['snapshot'], closed: string[]) {
  const index: ReadOnlyIndex = {
    path,
    snapshot,
    summary: (sha) => {
      if (sha !== SHA) throw new Error(`unexpected ${sha}`)
      return SUMMARY
    },
    leftOut: () => LEFT_OUT,
    reader: () => {
      throw new Error('not used')
    },
    close: () => closed.push(path),
  }
  return index
}

function readers(
  openings: Record<string, IndexOpening | Error>,
  repos = Object.keys(openings),
): IndexReaders {
  return {
    repositories: async () => repos,
    indexPath: (repo) => `/cache/${repo}/index.sqlite`,
    openIndex: async (path) => {
      const repo = path.slice('/cache/'.length, -'/index.sqlite'.length)
      const opening = openings[repo]
      if (opening === undefined) return { status: 'missing', path }
      if (opening instanceof Error) throw opening
      return opening
    },
    fileSize: async () => 2048,
  }
}

describe('readIndexes', () => {
  it('sums up the latest snapshot of each repository and closes its index', async () => {
    const closed: string[] = []
    const path = '/cache/acme/shop/index.sqlite'
    const snapshot = {
      sha: SHA,
      ref: 'HEAD',
      defaultBranch: true,
      indexedAt: '2026-10-25T11:00:00.000Z',
      durationMs: 5300,
    }

    const indexes = await readIndexes(
      readers({ 'acme/shop': { status: 'open', index: openIndex(path, snapshot, closed) } }),
    )

    expect(indexes).toEqual({
      repositories: [
        {
          repo: 'acme/shop',
          index: {
            state: 'indexed',
            path,
            bytes: 2048,
            snapshot,
            summary: SUMMARY,
            leftOut: [
              {
                reason: 'no-grammar',
                files: 5,
                extensions: [
                  { extension: '.md', files: 3 },
                  { extension: '', files: 1 },
                  { extension: '.json', files: 1 },
                ],
              },
              {
                reason: 'ignored',
                files: 2,
                extensions: [
                  { extension: '.json', files: 1 },
                  { extension: '.lock', files: 1 },
                ],
              },
              { reason: 'too-large', files: 1, extensions: [{ extension: '.js', files: 1 }] },
            ],
          },
        },
      ],
    })
    expect(closed).toEqual([path])
  })

  it('tells apart a missing index, one of another version, an unreadable one and one without snapshots', async () => {
    const closed: string[] = []
    const found = { schemaVersion: '3', phadaVersion: '0.9.0' }
    const expected = { schemaVersion: '3', phadaVersion: '1.0.0' }
    const indexes = await readIndexes(
      readers({
        'acme/empty': {
          status: 'open',
          index: openIndex('/cache/acme/empty/index.sqlite', null, closed),
        },
        'acme/old': {
          status: 'other-version',
          path: '/cache/acme/old/index.sqlite',
          found,
          expected,
        },
        'acme/broken': {
          status: 'unreadable',
          path: '/cache/acme/broken/index.sqlite',
          error: new IndexStoreError('Cannot read the index: it is not a Phada index'),
        },
        'acme/odd': new Error('disk I/O error'),
        'acme/none': { status: 'missing', path: '/cache/acme/none/index.sqlite' },
      }),
    )

    expect(indexes.repositories.map(({ repo, index }) => [repo, index])).toEqual([
      ['acme/empty', { state: 'empty', path: '/cache/acme/empty/index.sqlite', bytes: 2048 }],
      [
        'acme/old',
        {
          state: 'other-version',
          path: '/cache/acme/old/index.sqlite',
          bytes: 2048,
          found,
          expected,
        },
      ],
      [
        'acme/broken',
        {
          state: 'unreadable',
          path: '/cache/acme/broken/index.sqlite',
          error: 'Cannot read the index: it is not a Phada index',
        },
      ],
      [
        'acme/odd',
        { state: 'unreadable', path: '/cache/acme/odd/index.sqlite', error: 'disk I/O error' },
      ],
      ['acme/none', { state: 'missing', path: '/cache/acme/none/index.sqlite' }],
    ])
    expect(closed).toEqual(['/cache/acme/empty/index.sqlite'])
  })

  it('reads an index that fails while summing up as unreadable and still closes it', async () => {
    const closed: string[] = []
    const path = '/cache/acme/shop/index.sqlite'
    const index = openIndex(
      path,
      {
        sha: SHA,
        ref: 'HEAD',
        defaultBranch: true,
        indexedAt: '2026-10-25T11:00:00.000Z',
        durationMs: 1,
      },
      closed,
    )
    index.summary = () => {
      throw new Error('database disk image is malformed')
    }

    const indexes = await readIndexes(readers({ 'acme/shop': { status: 'open', index } }))

    expect(indexes.repositories[0]?.index).toEqual({
      state: 'unreadable',
      path,
      error: 'database disk image is malformed',
    })
    expect(closed).toEqual([path])
  })
})

describe('extensionCounts', () => {
  it('counts the extensions of paths, most first, then by name, with an empty one for none', () => {
    expect(extensionCounts(['a.md', 'b/.env', 'c.MD', 'd.ts', 'Makefile'])).toEqual([
      { extension: '', files: 2 },
      { extension: '.md', files: 2 },
      { extension: '.ts', files: 1 },
    ])
  })
})
