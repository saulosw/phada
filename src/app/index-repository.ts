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
const YIELD_EVERY_MS = 50
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
  signal?: AbortSignal
}

export interface IndexCancelled {
  cancelled: true
  extracted: number
  total: number
}

export type IndexingProgress =
  { phase: 'fetching' } | { phase: 'extracting'; done: number; total: number }

export interface IndexingOptions {
  signal: AbortSignal
  onProgress(progress: IndexingProgress): void
}

export type IndexingResult =
  | { kind: 'indexed'; files: number }
  | { kind: 'cancelled'; extracted: number; total: number }
  | { kind: 'no-token' }
  | { kind: 'failed'; message: string }

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

export type IndexCommitResult =
  | {
      complete: true
      files: number
      extracted: number
      reused: number
      commitFiles: CommitFile[]
      durationMs: number
    }
  | { complete: false; extracted: number; total: number }

export interface IndexCommitInput {
  sha: string
  ref: string
  files: readonly TreeFile[]
  ignore: (path: string) => boolean
  deadline?: number
  signal?: AbortSignal
}

export interface IndexCommitDeps {
  mirror: Pick<GitMirror, 'readBlobs'>
  store: IndexStore
  extractor: Extractor
  now: () => number
  events: IndexRepositoryEvents
}

export function indexRepository(
  input: IndexRepositoryInput & { signal: AbortSignal },
  deps: IndexRepositoryDeps,
): Promise<IndexReport | IndexCancelled>
export function indexRepository(
  input: IndexRepositoryInput,
  deps: IndexRepositoryDeps,
): Promise<IndexReport>
export async function indexRepository(
  input: IndexRepositoryInput,
  deps: IndexRepositoryDeps,
): Promise<IndexReport | IndexCancelled> {
  const started = deps.now()
  const ref = input.ref ?? 'HEAD'
  const { signal } = input
  let sha: string
  try {
    sha = await deps.mirror.fetch(ref, INDEX_REF, signal === undefined ? {} : { signal })
  } catch (error) {
    if (signal?.aborted === true) return { cancelled: true, extracted: 0, total: 0 }
    throw error
  }
  const files = await deps.mirror.listFiles(sha)
  const warnings: string[] = []
  const isIgnored = await ignoreMatcher(input.userLayers, files, deps, sha, warnings)

  const store = await deps.openStore()
  try {
    const result = await indexCommit(
      {
        sha,
        ref,
        files,
        ignore: isIgnored,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      { mirror: deps.mirror, store, extractor: deps.extractor, now: deps.now, events: deps.events },
    )
    if (!result.complete) {
      if (input.signal?.aborted !== true) throw new Error('indexing stopped without a cancel')
      return { cancelled: true, extracted: result.extracted, total: result.total }
    }
    store.prune(KEEP_COMMITS)
    const leftOut = result.commitFiles
      .filter(
        (file): file is CommitFile & { status: LeftOutFile['reason'] } => file.status !== 'indexed',
      )
      .map(({ path, status }) => ({ path, reason: status }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const indexed = result.commitFiles.filter((file) => file.status === 'indexed').length
    return {
      repository: `${input.owner}/${input.repo}`,
      commit: sha,
      ref,
      durationMs: Math.round(deps.now() - started),
      files: {
        total: files.length,
        indexed,
        extracted: result.extracted,
        reused: result.reused,
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

export async function refreshIndex(
  input: IndexRepositoryInput & { deadline: number },
  deps: IndexRepositoryDeps,
): Promise<{ complete: boolean; commit: string }> {
  const sha = await deps.mirror.fetch(input.ref ?? 'HEAD', INDEX_REF)
  const files = await deps.mirror.listFiles(sha)
  const isIgnored = await ignoreMatcher(input.userLayers, files, deps, sha, [])
  const store = await deps.openStore()
  try {
    const result = await indexCommit(
      { sha, ref: input.ref ?? 'HEAD', files, ignore: isIgnored, deadline: input.deadline },
      { mirror: deps.mirror, store, extractor: deps.extractor, now: deps.now, events: deps.events },
    )
    if (result.complete) store.prune(KEEP_COMMITS)
    return { complete: result.complete, commit: sha }
  } finally {
    store.close()
  }
}

export type ReviewIndexResult =
  Extract<IndexCommitResult, { complete: true }> | { complete: false; progress: string }

export async function indexForReview(
  input: Omit<IndexCommitInput, 'ignore'> & { ignore: readonly string[] },
  deps: IndexCommitDeps,
): Promise<ReviewIndexResult> {
  const result = await indexCommit(
    { ...input, ignore: matcher([...DEFAULT_IGNORE, ...DEPENDENCY_FOLDERS, ...input.ignore]) },
    deps,
  )
  if (!result.complete) {
    const count = (value: number) => value.toLocaleString('en-US')
    return {
      complete: false,
      progress: `${count(result.extracted)} of ${count(result.total)} files`,
    }
  }
  deps.store.prune(KEEP_COMMITS)
  return result
}

export async function indexCommit(
  input: IndexCommitInput,
  deps: IndexCommitDeps,
): Promise<IndexCommitResult> {
  const started = deps.now()
  const { store } = deps
  const planned: Planned[] = input.files.map((file) => plan(file, input.ignore))
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
  const cancelled = () => input.signal?.aborted === true
  deps.events.extracting(total)
  if (cancelled()) return { complete: false, extracted: 0, total }
  let done = 0
  let yielded = deps.now()
  const toRead = [...wanted.values()].map((entry) => entry.file)
  for await (const blob of deps.mirror.readBlobs(toRead)) {
    for (const language of wanted.get(blob.oid)?.languages ?? []) {
      const status = await extractBlob(blob, language, store, deps.extractor)
      fresh.set(blobKey(blob.oid, language), status)
      done += 1
      deps.events.extracted(done, total)
    }
    if (deps.now() - yielded >= YIELD_EVERY_MS) {
      await new Promise((resolve) => setImmediate(resolve))
      yielded = deps.now()
    }
    const pastDeadline = input.deadline !== undefined && deps.now() > input.deadline
    if (done < total && (pastDeadline || cancelled())) {
      return { complete: false, extracted: done, total }
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
  store.saveCommit({ sha: input.sha, ref: input.ref, durationMs, files: commitFiles })
  return {
    complete: true,
    files: input.files.length,
    extracted: fresh.size,
    reused: candidates.filter(({ file, language }) => known.has(keyOf(file, language))).length,
    commitFiles,
    durationMs,
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
