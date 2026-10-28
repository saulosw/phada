import { FILE_STATUSES } from '../store/index-store.js'
import type {
  IndexOpening,
  IndexSnapshot,
  IndexSummary,
  IndexVersion,
  LeftOutPath,
  ReadOnlyIndex,
} from '../store/index-store.js'
import { errorMessage } from './error-message.js'

export type { IndexVersion } from '../store/index-store.js'

export type IndexLanguage = keyof IndexSummary['languages']
export type IndexSymbolKind = keyof IndexSummary['symbols']

export interface IndexReaders {
  repositories(): Promise<string[]>
  indexPath(repo: string): string
  openIndex(path: string): Promise<IndexOpening>
  fileSize(path: string): Promise<number>
}

export interface ExtensionCount {
  extension: string
  files: number
}

export interface LeftOutGroup {
  reason: LeftOutPath['status']
  files: number
  extensions: ExtensionCount[]
}

export type RepositoryIndexState =
  | { state: 'missing'; path: string }
  | {
      state: 'other-version'
      path: string
      bytes: number
      found: IndexVersion
      expected: IndexVersion
    }
  | { state: 'unreadable'; path: string; error: string }
  | { state: 'empty'; path: string; bytes: number }
  | {
      state: 'indexed'
      path: string
      bytes: number
      snapshot: IndexSnapshot
      summary: IndexSummary
      leftOut: LeftOutGroup[]
    }

export interface IndexedRepository {
  repo: string
  index: RepositoryIndexState
}

export interface RepositoryIndexes {
  repositories: IndexedRepository[]
}

export async function readIndexes(readers: IndexReaders): Promise<RepositoryIndexes> {
  const repos = await readers.repositories()
  return {
    repositories: await Promise.all(
      repos.map(async (repo) => ({
        repo,
        index: await readIndex(readers.indexPath(repo), readers),
      })),
    ),
  }
}

async function readIndex(path: string, readers: IndexReaders): Promise<RepositoryIndexState> {
  let opening: IndexOpening
  try {
    opening = await readers.openIndex(path)
  } catch (error) {
    return { state: 'unreadable', path, error: errorMessage(error) }
  }
  switch (opening.status) {
    case 'missing':
      return { state: 'missing', path }
    case 'unreadable':
      return { state: 'unreadable', path, error: opening.error.message }
    case 'other-version':
      return {
        state: 'other-version',
        path,
        bytes: await readers.fileSize(path),
        found: opening.found,
        expected: opening.expected,
      }
    case 'open':
      return summed(opening.index, await readers.fileSize(path))
  }
}

function summed(index: ReadOnlyIndex, bytes: number): RepositoryIndexState {
  const { path, snapshot } = index
  try {
    if (snapshot === null) return { state: 'empty', path, bytes }
    return {
      state: 'indexed',
      path,
      bytes,
      snapshot,
      summary: index.summary(snapshot.sha),
      leftOut: leftOutGroups(index.leftOut(snapshot.sha)),
    }
  } catch (error) {
    return { state: 'unreadable', path, error: errorMessage(error) }
  } finally {
    index.close()
  }
}

function leftOutGroups(files: readonly LeftOutPath[]): LeftOutGroup[] {
  const groups = FILE_STATUSES.flatMap((reason): LeftOutGroup[] => {
    const paths = files.filter((file) => file.status === reason).map((file) => file.path)
    return reason === 'indexed' || paths.length === 0
      ? []
      : [{ reason, files: paths.length, extensions: extensionCounts(paths) }]
  })
  return groups.sort((a, b) => b.files - a.files)
}

export function extensionCounts(paths: readonly string[]): ExtensionCount[] {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    const extension = dot <= 0 ? '' : name.slice(dot).toLowerCase()
    counts.set(extension, (counts.get(extension) ?? 0) + 1)
  }
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .map(([extension, files]) => ({ extension, files }))
}
