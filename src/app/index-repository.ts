import { mergeConfig } from '../config/merge-config.js'
import { parseConfigText } from '../config/parse-config.js'
import type { ConfigLayer } from '../config/types.js'
import { DEFAULT_IGNORE, matcher } from '../context/ignore.js'
import type { Extractor } from '../repo-map/extract.js'
import { languageOf } from '../repo-map/languages.js'
import type { Language } from '../repo-map/languages.js'
import type { GitMirror, TreeFile } from '../repository/git-mirror.js'
import { blobKey } from '../store/index-store.js'
import type {
  BlobStatus,
  CommitFile,
  FileStatus,
  IndexStore,
  IndexSummary,
} from '../store/index-store.js'

export const INDEX_MAX_FILE_BYTES = 1_000_000
export const KEEP_COMMITS = 10
export const INDEX_REF = 'refs/phada/index'

export const DEPENDENCY_FOLDERS: readonly string[] = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/.venv/**',
  '**/venv/**',
  '**/site-packages/**',
  '**/vendor/**',
]

const BINARY_PROBE_LENGTH = 8000
const PHADA_CONFIG = /(^|\/)\.phada\/config\.yml$/
const MODE_STATUS: Readonly<Record<string, FileStatus>> = {
  '120000': 'symlink',
  '160000': 'submodule',
}

export interface LeftOutFile {
  path: string
  reason: Exclude<FileStatus, 'indexed'>
}

export interface IndexReport {
  repository: string
  commit: string
  ref: string
  durationMs: number
  files: { total: number; indexed: number; extracted: number; reused: number }
  summary: IndexSummary
  leftOut: LeftOutFile[]
  rebuilt: boolean
  warnings: string[]
  indexPath: string
}

export interface IndexRepositoryInput {
  owner: string
  repo: string
  ref?: string
  userLayers: readonly ConfigLayer[]
}

export interface IndexRepositoryEvents {
  extracting(total: number): void
  extracted(done: number, total: number): void
}

export interface IndexRepositoryDeps {
  mirror: Pick<GitMirror, 'fetch' | 'checkout' | 'listFiles' | 'readBlobs'>
  openStore: () => Promise<IndexStore>
  extractor: Extractor
  now: () => number
  events: IndexRepositoryEvents
}

interface Planned {
  file: TreeFile
  language?: Language
  status?: FileStatus
}

export async function indexRepository(
  input: IndexRepositoryInput,
  deps: IndexRepositoryDeps,
): Promise<IndexReport> {
  const started = deps.now()
  const ref = input.ref ?? 'HEAD'
  const sha = await deps.mirror.fetch(ref, INDEX_REF)
  const files = await deps.mirror.listFiles(sha)
  const warnings: string[] = []
  const isIgnored = await ignoreMatcher(input.userLayers, files, deps, sha, warnings)

  const store = await deps.openStore()
  try {
    const planned: Planned[] = files.map((file) => plan(file, isIgnored))
    const candidates = planned.filter((item) => item.status === undefined)
    const known = store.knownBlobs(
      candidates.flatMap(({ file, language }) =>
        language === undefined ? [] : [{ oid: file.oid, language }],
      ),
    )
    const keyOf = (file: TreeFile, language: Language | undefined) =>
      language === undefined ? '' : blobKey(file.oid, language)
    const wanted = new Map<string, { file: TreeFile; languages: Set<Language> }>()
    for (const { file, language } of candidates) {
      if (language === undefined || known.has(keyOf(file, language))) continue
      const entry = wanted.get(file.oid) ?? { file, languages: new Set<Language>() }
      entry.languages.add(language)
      wanted.set(file.oid, entry)
    }

    const fresh = new Map<string, BlobStatus>()
    const total = [...wanted.values()].reduce((sum, entry) => sum + entry.languages.size, 0)
    deps.events.extracting(total)
    let done = 0
    const toRead = [...wanted.values()].map((entry) => entry.file)
    for await (const blob of deps.mirror.readBlobs(toRead)) {
      for (const language of wanted.get(blob.oid)?.languages ?? []) {
        const status = await extractBlob(blob, language, store, deps.extractor)
        fresh.set(blobKey(blob.oid, language), status)
        done += 1
        deps.events.extracted(done, total)
      }
    }
    if (done < total) deps.events.extracted(total, total)

    const commitFiles: CommitFile[] = planned.map(({ file, language, status }) => {
      const key = keyOf(file, language)
      const blobStatus = status ?? fresh.get(key) ?? known.get(key) ?? 'missing'
      return {
        path: file.path,
        oid: file.oid,
        ...(language === undefined ? {} : { language }),
        status: blobStatus,
      }
    })
    const durationMs = Math.round(deps.now() - started)
    store.saveCommit({ sha, ref, durationMs, files: commitFiles })
    store.prune(KEEP_COMMITS)

    const leftOut = commitFiles
      .filter(
        (file): file is CommitFile & { status: LeftOutFile['reason'] } => file.status !== 'indexed',
      )
      .map(({ path, status }) => ({ path, reason: status }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const indexed = commitFiles.filter((file) => file.status === 'indexed').length
    return {
      repository: `${input.owner}/${input.repo}`,
      commit: sha,
      ref,
      durationMs,
      files: {
        total: files.length,
        indexed,
        extracted: fresh.size,
        reused: candidates.filter(({ file, language }) => known.has(keyOf(file, language))).length,
      },
      summary: store.summary(sha),
      leftOut,
      rebuilt: store.rebuilt,
      warnings,
      indexPath: store.path,
    }
  } finally {
    store.close()
  }
}

function plan(file: TreeFile, isIgnored: (path: string) => boolean): Planned {
  const byMode = MODE_STATUS[file.mode]
  if (byMode !== undefined) return { file, status: byMode }
  if (isIgnored(file.path)) return { file, status: 'ignored' }
  const language = languageOf(file.path)
  if (language === undefined) return { file, status: 'no-grammar' }
  if (file.size > INDEX_MAX_FILE_BYTES) return { file, language, status: 'too-large' }
  return { file, language }
}

async function extractBlob(
  blob: { oid: string; bytes: Uint8Array },
  language: Language,
  store: IndexStore,
  extractor: Extractor,
): Promise<BlobStatus> {
  const base = { oid: blob.oid, language, bytes: blob.bytes.length }
  if (blob.bytes.subarray(0, BINARY_PROBE_LENGTH).includes(0)) {
    store.saveBlob({ ...base, status: 'binary' })
    return 'binary'
  }
  let map: Awaited<ReturnType<Extractor['extract']>>
  try {
    map = await extractor.extract(language, new TextDecoder().decode(blob.bytes))
  } catch {
    store.saveBlob({ ...base, status: 'parse-failed' })
    return 'parse-failed'
  }
  if (map === 'timeout') {
    store.saveBlob({ ...base, status: 'parse-timeout' })
    return 'parse-timeout'
  }
  store.saveBlob({ ...base, status: 'indexed', map })
  return 'indexed'
}

async function ignoreMatcher(
  userLayers: readonly ConfigLayer[],
  files: readonly TreeFile[],
  deps: IndexRepositoryDeps,
  sha: string,
  warnings: string[],
): Promise<(path: string) => boolean> {
  const checkout = deps.mirror.checkout(sha)
  const repositoryLayers: ConfigLayer[] = []
  for (const file of files) {
    if (!PHADA_CONFIG.test(file.path) || MODE_STATUS[file.mode] !== undefined) continue
    const dir = file.path.replace(PHADA_CONFIG, '')
    let text: string
    try {
      text = await checkout.readText(file.path)
    } catch (error) {
      warnings.push(`Ignoring ${file.path}: ${(error as Error).message}`)
      continue
    }
    const parsed = parseConfigText(text)
    if (!parsed.ok) {
      warnings.push(`Ignoring ${file.path}: ${parsed.message}`)
      continue
    }
    repositoryLayers.push({
      kind: dir === '' ? 'repo-root' : 'repo-dir',
      dir,
      configLabel: file.path,
      config: parsed.config,
    })
  }
  const merged = mergeConfig([
    ...userLayers.filter((layer) => layer.kind === 'user'),
    ...repositoryLayers,
    ...userLayers.filter((layer) => layer.kind === 'user-repo'),
  ])
  warnings.push(...merged.warnings)
  return matcher([...DEFAULT_IGNORE, ...DEPENDENCY_FOLDERS, ...merged.ignore])
}
