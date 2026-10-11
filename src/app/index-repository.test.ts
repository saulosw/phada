import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ConfigLayer } from '../config/types.js'
import { createExtractor } from '../repo-map/extract.js'
import type { Extractor } from '../repo-map/extract.js'
import type { Checkout } from '../repository/checkout.js'
import { CheckoutError } from '../repository/checkout.js'
import type { TreeFile } from '../repository/git-mirror.js'
import { openIndexStore } from '../store/index-store.js'
import type { IndexStore } from '../store/index-store.js'
import { indexRepository } from './index-repository.js'
import type { IndexRepositoryDeps } from './index-repository.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-index-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SHA = '1'.repeat(40)
const extractor = createExtractor()

interface FakeFile {
  content?: string | Uint8Array
  mode?: string
  size?: number
}

function fakeMirror(files: Record<string, FakeFile>) {
  const fetched: { ref: string; keepAs: string }[] = []
  const read: string[][] = []
  const entries: TreeFile[] = Object.entries(files).map(([path, file]) => {
    const content = file.content ?? ''
    const bytes = typeof content === 'string' ? Buffer.from(content) : content
    return {
      path,
      oid: oidOf(content),
      mode: file.mode ?? '100644',
      size: file.size ?? bytes.length,
    }
  })
  const blobs = new Map(
    Object.values(files).map((file) => {
      const content = file.content ?? ''
      return [oidOf(content), typeof content === 'string' ? Buffer.from(content) : content]
    }),
  )
  const checkout: Checkout = {
    commit: SHA,
    readText: async (path) => {
      const content = files[path]?.content
      if (typeof content !== 'string') throw new CheckoutError('not-found', path)
      return content
    },
    grep: async () => [],
    listDir: async () => [],
    close: async () => {},
  }
  const mirror: IndexRepositoryDeps['mirror'] = {
    fetch: async (ref, keepAs) => {
      fetched.push({ ref, keepAs })
      return SHA
    },
    checkout: () => checkout,
    listFiles: async () => entries,
    readBlobs: async function* (wanted) {
      read.push(wanted.map((file) => file.path))
      for (const file of wanted)
        yield { oid: file.oid, bytes: new Uint8Array(blobs.get(file.oid) ?? []) }
    },
  }
  return { mirror, fetched, read }
}

function oidOf(content: string | Uint8Array): string {
  return Buffer.from(content).toString('hex').padEnd(40, '0').slice(0, 40)
}

let stores = 0
function storePath(): string {
  stores += 1
  return join(dir, `s${stores}.sqlite`)
}

function deps(
  mirror: IndexRepositoryDeps['mirror'],
  path: string,
  overrides: Partial<IndexRepositoryDeps> = {},
) {
  const events: string[] = []
  const closed: IndexStore[] = []
  const value: IndexRepositoryDeps = {
    mirror,
    openStore: async () => {
      const store = await openIndexStore(path)
      const close = store.close.bind(store)
      store.close = () => {
        closed.push(store)
        close()
      }
      return store
    },
    extractor,
    now: () => 1_000,
    events: {
      fetched: (sha) => events.push(`fetched ${sha.slice(0, 7)}`),
      extracting: (total) => events.push(`extracting ${total}`),
      extracted: (done, total) => events.push(`extracted ${done}/${total}`),
    },
    ...overrides,
  }
  return { deps: value, events, closed }
}

const INPUT = { owner: 'acme', repo: 'shop', userLayers: [] as ConfigLayer[] }

describe('indexRepository', () => {
  it('fetches the default branch, indexes code and says why the rest is left out', async () => {
    const { mirror, fetched } = fakeMirror({
      'src/a.ts': { content: 'export function a() { b() }\n' },
      'package-lock.json': { content: '{}' },
      'docs/x.md': { content: '# x' },
      'big.ts': { content: 'x', size: 1_000_001 },
      'img.ts': { content: new Uint8Array([1, 0, 2]) },
      'link.ts': { content: 'src/a.ts', mode: '120000' },
      'vendor/lib': { content: 'sub', mode: '160000', size: 0 },
      'app/gen/x.ts': { content: 'export const g = 1\n' },
      'app/.phada/config.yml': { content: 'ignore:\n  - gen/**\n' },
    })
    const h = deps(mirror, storePath())

    const report = await indexRepository(INPUT, h.deps)

    expect(fetched).toEqual([{ ref: 'HEAD', keepAs: 'refs/phada/index' }])
    expect(report).toMatchObject({
      repository: 'acme/shop',
      commit: SHA,
      ref: 'HEAD',
      files: { total: 9, indexed: 1, extracted: 2, reused: 0 },
      rebuilt: false,
      warnings: [],
    })
    expect(report.summary.symbols).toEqual({ function: 1 })
    expect(report.summary.calls).toBe(1)
    expect(report.leftOut).toEqual([
      { path: 'app/.phada/config.yml', reason: 'no-grammar' },
      { path: 'app/gen/x.ts', reason: 'ignored' },
      { path: 'big.ts', reason: 'too-large' },
      { path: 'docs/x.md', reason: 'no-grammar' },
      { path: 'img.ts', reason: 'binary' },
      { path: 'link.ts', reason: 'symlink' },
      { path: 'package-lock.json', reason: 'ignored' },
      { path: 'vendor/lib', reason: 'submodule' },
    ])
    expect(h.events).toEqual(['fetched 1111111', 'extracting 2', 'extracted 1/2', 'extracted 2/2'])
    expect(h.closed).toHaveLength(1)
  })

  it('extracts nothing the second time and only the changed file after a change', async () => {
    const path = storePath()
    const first = fakeMirror({
      'src/a.ts': { content: 'export const a = 1\n' },
      'src/b.ts': { content: 'export const b = 1\n' },
    })
    await indexRepository(INPUT, deps(first.mirror, path).deps)

    const again = fakeMirror({
      'src/a.ts': { content: 'export const a = 1\n' },
      'src/b.ts': { content: 'export const b = 1\n' },
    })
    const second = await indexRepository(INPUT, deps(again.mirror, path).deps)
    expect(second.files).toEqual({ total: 2, indexed: 2, extracted: 0, reused: 2 })
    expect(again.read).toEqual([[]])

    const changed = fakeMirror({
      'src/a.ts': { content: 'export const a = 2\n' },
      'src/b.ts': { content: 'export const b = 1\n' },
    })
    const third = await indexRepository(INPUT, deps(changed.mirror, path).deps)
    expect(third.files).toEqual({ total: 2, indexed: 2, extracted: 1, reused: 1 })
    expect(changed.read).toEqual([['src/a.ts']])
  })

  it('extracts a blob shared by two paths once and counts both files', async () => {
    const { mirror, read } = fakeMirror({
      'a/x.ts': { content: 'export function x() {}\n' },
      'b/x.ts': { content: 'export function x() {}\n' },
    })

    const report = await indexRepository(INPUT, deps(mirror, storePath()).deps)

    expect(read).toEqual([['a/x.ts']])
    expect(report.files).toEqual({ total: 2, indexed: 2, extracted: 1, reused: 0 })
    expect(report.summary.symbols).toEqual({ function: 2 })
  })

  it('leaves out a file that takes too long to parse, also on the next run', async () => {
    const path = storePath()
    const calls: string[] = []
    const slow: Extractor = {
      extract: async (language, text) => {
        calls.push(text)
        return 'timeout'
      },
    }
    const files = { 'src/slow.ts': { content: 'export const s = 1\n' } }

    const first = await indexRepository(
      INPUT,
      deps(fakeMirror(files).mirror, path, { extractor: slow }).deps,
    )
    const second = await indexRepository(
      INPUT,
      deps(fakeMirror(files).mirror, path, { extractor: slow }).deps,
    )

    expect(first.leftOut).toEqual([{ path: 'src/slow.ts', reason: 'parse-timeout' }])
    expect(second.leftOut).toEqual([{ path: 'src/slow.ts', reason: 'parse-timeout' }])
    expect(calls).toHaveLength(1)
  })

  it('warns about an invalid repository config and indexes the rest', async () => {
    const { mirror } = fakeMirror({
      '.phada/config.yml': { content: 'ignore: [unclosed\n' },
      'src/a.ts': { content: 'export const a = 1\n' },
    })

    const report = await indexRepository(INPUT, deps(mirror, storePath()).deps)

    expect(report.warnings).toEqual([expect.stringMatching(/^Ignoring \.phada\/config\.yml: /)])
    expect(report.files.indexed).toBe(1)
  })

  it('applies the ignore patterns of your own config and indexes the ref you ask for', async () => {
    const { mirror, fetched } = fakeMirror({
      'src/a.ts': { content: 'export const a = 1\n' },
      'tools/b.ts': { content: 'export const b = 1\n' },
    })
    const user: ConfigLayer = {
      kind: 'user',
      dir: '',
      configLabel: 'user:config.yml',
      config: { ignore: ['tools/**'] },
    }

    const report = await indexRepository(
      { ...INPUT, ref: 'release', userLayers: [user] },
      deps(mirror, storePath()).deps,
    )

    expect(fetched).toEqual([{ ref: 'release', keepAs: 'refs/phada/index' }])
    expect(report.leftOut).toEqual([{ path: 'tools/b.ts', reason: 'ignored' }])
  })

  it('closes the index when extraction fails', async () => {
    const { mirror } = fakeMirror({ 'src/a.ts': { content: 'export const a = 1\n' } })
    const failing: Extractor = {
      extract: async () => {
        throw new Error('boom')
      },
    }
    const h = deps(mirror, storePath(), { extractor: failing })

    await expect(indexRepository(INPUT, h.deps)).rejects.toThrow('boom')
    expect(h.closed).toHaveLength(1)
  })
})
