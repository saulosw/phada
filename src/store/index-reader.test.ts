import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FileMap } from '../repo-map/types.js'
import { openIndexStore } from './index-store.js'
import type { IndexStore } from './index-store.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-reader-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const FIRST = '1'.repeat(40)
const SECOND = '2'.repeat(40)
const OLD_B = 'b'.repeat(40)
const NEW_B = 'c'.repeat(40)
const SHARED = 'a'.repeat(40)

function mapWith(call: string, reference: string): FileMap {
  return {
    symbols: [
      {
        key: 0,
        kind: 'function',
        name: 'run',
        startLine: 1,
        endLine: 4,
        exported: true,
        signature: 'export function run()',
      },
    ],
    imports: [{ module: './a', name: 'load', alias: 'fetchIt', kind: 'named', line: 1 }],
    exports: [{ name: 'run', line: 1 }],
    calls: [{ caller: 0, name: call, line: 2, constructs: false }],
    heritage: [],
    references: [{ owner: 0, name: reference, line: 3 }],
    parseErrors: 0,
  }
}

async function twoCommits(): Promise<IndexStore> {
  const store = await openIndexStore(join(dir, `${Math.random()}.sqlite`))
  store.saveBlob({
    oid: SHARED,
    language: 'typescript',
    bytes: 1,
    status: 'indexed',
    map: mapWith('load', 'Row'),
  })
  store.saveBlob({
    oid: OLD_B,
    language: 'typescript',
    bytes: 1,
    status: 'indexed',
    map: mapWith('load', 'Row'),
  })
  store.saveBlob({
    oid: NEW_B,
    language: 'typescript',
    bytes: 1,
    status: 'indexed',
    map: mapWith('save', 'Col'),
  })
  store.saveCommit({
    sha: FIRST,
    ref: 'HEAD',
    durationMs: 1,
    files: [
      { path: 'src/a.ts', oid: SHARED, language: 'typescript', status: 'indexed' },
      { path: 'src/copy.ts', oid: SHARED, language: 'typescript', status: 'indexed' },
      { path: 'src/b.ts', oid: OLD_B, language: 'typescript', status: 'indexed' },
      { path: 'tsconfig.json', oid: 'd'.repeat(40), status: 'no-grammar' },
    ],
  })
  store.saveCommit({
    sha: SECOND,
    ref: 'HEAD',
    durationMs: 1,
    files: [
      { path: 'src/a.ts', oid: SHARED, language: 'typescript', status: 'indexed' },
      { path: 'src/b.ts', oid: NEW_B, language: 'typescript', status: 'indexed' },
    ],
  })
  return store
}

describe('IndexReader', () => {
  it('lists the indexed files of a commit and every path it has', async () => {
    const store = await twoCommits()
    const reader = store.reader(FIRST)

    expect([...reader.files().keys()].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/copy.ts'])
    expect(reader.paths().has('tsconfig.json')).toBe(true)
    expect(reader.files().get('src/a.ts')?.language).toBe('typescript')
    store.close()
  })

  it('finds calls and uses by name only in the blobs of the commit asked for', async () => {
    const store = await twoCommits()
    const first = store.reader(FIRST)
    const second = store.reader(SECOND)

    const blobPaths = (reader: typeof first, blobIds: number[]) =>
      blobIds.flatMap((id) => reader.pathsOfBlob(id)).sort()
    expect(
      blobPaths(
        first,
        first.callsNamed('load', 100).map((call) => call.blobId),
      ),
    ).toEqual(['src/a.ts', 'src/b.ts', 'src/copy.ts'])
    expect(
      blobPaths(
        second,
        second.callsNamed('load', 100).map((call) => call.blobId),
      ),
    ).toEqual(['src/a.ts'])
    expect(second.callsNamed('save', 100)).toHaveLength(1)
    expect(second.referencesNamed('Col', 100)).toEqual([
      { blobId: expect.any(Number), ownerId: expect.any(Number), name: 'Col', line: 3 },
    ])
    store.close()
  })

  it('stops at the limit it is given', async () => {
    const store = await twoCommits()

    expect(store.reader(FIRST).callsNamed('load', 1)).toHaveLength(1)
    store.close()
  })

  it('reads the symbols, imports and exports of a blob and finds symbols and imports by name', async () => {
    const store = await twoCommits()
    const reader = store.reader(SECOND)
    const blobId = reader.files().get('src/b.ts')?.blobId ?? -1

    const [run] = reader.symbolsOfBlob(blobId)
    expect(run).toMatchObject({ kind: 'function', name: 'run', startLine: 1, exported: true })
    expect(reader.symbol(run?.id ?? -1)?.name).toBe('run')
    expect(reader.importsOfBlob(blobId)).toEqual([
      { blobId, module: './a', name: 'load', alias: 'fetchIt', kind: 'named', line: 1 },
    ])
    expect(reader.exportsOfBlob(blobId)).toEqual([{ blobId, name: 'run', line: 1 }])
    expect(reader.callsOfBlob(blobId).map((call) => call.name)).toEqual(['save'])
    expect(reader.referencesOfBlob(blobId).map((item) => item.name)).toEqual(['Col'])
    expect(reader.symbolsNamed('RUN', { ignoreCase: true })).toHaveLength(2)
    expect(reader.symbolsNamed('RUN')).toHaveLength(0)
    expect(reader.importsNamed('load')).toHaveLength(2)
    expect(reader.callersOfNames(['save', 'load'], 10)).toHaveLength(2)
    store.close()
  })
})
