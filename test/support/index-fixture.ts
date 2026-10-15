import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExtractor } from '../../src/repo-map/extract.js'
import { languageOf } from '../../src/repo-map/languages.js'
import type { IndexReader } from '../../src/store/index-reader.js'
import { openIndexStore } from '../../src/store/index-store.js'
import type { CommitFile, IndexStore } from '../../src/store/index-store.js'

const extractor = createExtractor()

export interface IndexedFixture {
  store: IndexStore
  reader: IndexReader
  sha: string
  readText: (path: string) => Promise<string>
}

export async function openFixtureStore(): Promise<IndexStore> {
  return openIndexStore(join(mkdtempSync(join(tmpdir(), 'phada-graph-')), 'index.sqlite'))
}

export async function indexFixture(
  files: Readonly<Record<string, string>>,
  options: { store?: IndexStore; sha?: string } = {},
): Promise<IndexedFixture> {
  const store = options.store ?? (await openFixtureStore())
  const sha = options.sha ?? '1'.repeat(40)
  const commitFiles: CommitFile[] = []
  for (const [path, text] of Object.entries(files)) {
    const oid = createHash('sha1').update(text).digest('hex')
    const language = languageOf(path)
    if (language === undefined) {
      commitFiles.push({ path, oid, status: 'no-grammar' })
      continue
    }
    const map = await extractor.extract(language, text)
    if (map === 'timeout') throw new Error(`timeout extracting ${path}`)
    store.saveBlob({ oid, language, bytes: text.length, status: 'indexed', map })
    commitFiles.push({ path, oid, language, status: 'indexed' })
  }
  store.saveCommit({ sha, ref: 'HEAD', durationMs: 1, files: commitFiles })
  return {
    store,
    reader: store.reader(sha),
    sha,
    readText: async (path) => {
      const text = files[path]
      if (text === undefined) throw new Error(`no file ${path}`)
      return text
    },
  }
}
