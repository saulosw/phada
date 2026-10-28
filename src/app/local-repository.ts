import { parseConfigText } from '../config/parse-config.js'
import type { ConfigLayer } from '../config/types.js'
import { mergeLayers } from '../context/load-context.js'
import { phadaFiles } from '../context/phada-paths.js'
import { readPackages } from '../graph/packages.js'
import type { RepositoryPackages } from '../graph/packages.js'
import type { LocalMirror, MirrorOpening, TreeFile } from '../repository/git-mirror.js'
import type { IndexOpening, IndexVersion, ReadOnlyIndex } from '../store/index-store.js'
import { errorMessage } from './error-message.js'

export interface LocalReaders {
  openIndex(repo: string): Promise<IndexOpening>
  openMirror(repo: string): Promise<MirrorOpening>
}

export type NotIndexed =
  | { reason: 'no-index' }
  | { reason: 'empty' }
  | { reason: 'other-version'; found: IndexVersion; expected: IndexVersion }
  | { reason: 'unreadable'; error: string }
  | { reason: 'no-mirror' }
  | { reason: 'mirror-unreadable'; error: string }

export interface LocalRepository {
  commit: string
  index: ReadOnlyIndex
  readText(path: string): Promise<string>
  packages: RepositoryPackages
  config: string | null
}

export type LocalOpening =
  { state: 'read'; local: LocalRepository } | { state: 'not-indexed'; why: NotIndexed }

export interface DeclaredRelated {
  related: { repo: string; description?: string }[]
  configError: string | null
  warnings: string[]
}

const ROOT_CONFIG = phadaFiles('').config

export async function openLocalRepository(
  repo: string,
  readers: LocalReaders,
): Promise<LocalOpening> {
  const opened = await openSnapshot(repo, readers)
  if (!('index' in opened)) return { state: 'not-indexed', why: opened }
  const { index, sha } = opened
  const read = await readMirror(repo, sha, readers)
  if ('reason' in read) {
    index.close()
    return { state: 'not-indexed', why: read }
  }
  return { state: 'read', local: { commit: sha, index, ...read } }
}

export async function indexedSnapshot(
  repo: string,
  readers: Pick<LocalReaders, 'openIndex'>,
): Promise<string | NotIndexed> {
  const opened = await openSnapshot(repo, readers)
  if (!('index' in opened)) return opened
  opened.index.close()
  return opened.sha
}

export function declaredRelated(
  repo: string,
  userLayers: ConfigLayer[],
  config: string | null,
): DeclaredRelated {
  const parsed = config === null ? null : parseConfigText(config)
  const repositoryLayers: ConfigLayer[] =
    parsed?.ok === true
      ? [{ kind: 'repo-root', dir: '', configLabel: ROOT_CONFIG, config: parsed.config }]
      : []
  const merged = mergeLayers(userLayers, repositoryLayers)
  return {
    related: merged.repos
      .filter((related) => related.repo.toLowerCase() !== repo.toLowerCase())
      .map(({ repo: name, description }) => ({
        repo: name,
        ...(description === undefined ? {} : { description }),
      })),
    configError: parsed?.ok === false ? parsed.message : null,
    warnings: merged.warnings,
  }
}

async function openSnapshot(
  repo: string,
  readers: Pick<LocalReaders, 'openIndex'>,
): Promise<{ index: ReadOnlyIndex; sha: string } | NotIndexed> {
  let opening: IndexOpening
  try {
    opening = await readers.openIndex(repo)
  } catch (error) {
    return { reason: 'unreadable', error: errorMessage(error) }
  }
  switch (opening.status) {
    case 'missing':
      return { reason: 'no-index' }
    case 'unreadable':
      return { reason: 'unreadable', error: opening.error.message }
    case 'other-version':
      return { reason: 'other-version', found: opening.found, expected: opening.expected }
    case 'open': {
      const { index } = opening
      if (index.snapshot !== null) return { index, sha: index.snapshot.sha }
      index.close()
      return { reason: 'empty' }
    }
  }
}

async function readMirror(
  repo: string,
  sha: string,
  readers: LocalReaders,
): Promise<Omit<LocalRepository, 'commit' | 'index'> | NotIndexed> {
  let opening: MirrorOpening
  try {
    opening = await readers.openMirror(repo)
  } catch (error) {
    return { reason: 'mirror-unreadable', error: errorMessage(error) }
  }
  if (opening.status === 'missing') return { reason: 'no-mirror' }
  try {
    const files = await opening.mirror.listFiles(sha)
    const readText = textReader(opening.mirror, files)
    const paths = new Set(files.map((file) => file.path))
    return {
      readText,
      packages: await readPackages(paths, readText),
      config: paths.has(ROOT_CONFIG) ? await readText(ROOT_CONFIG) : null,
    }
  } catch (error) {
    return { reason: 'mirror-unreadable', error: errorMessage(error) }
  }
}

function textReader(
  mirror: LocalMirror,
  files: readonly TreeFile[],
): (path: string) => Promise<string> {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const decoder = new TextDecoder()
  return async (path) => {
    const file = byPath.get(path)
    if (file === undefined) throw new Error(`${path} is not in the commit`)
    for await (const blob of mirror.readBlobs([file])) return decoder.decode(blob.bytes)
    throw new Error(`${path} is not in the mirror`)
  }
}
