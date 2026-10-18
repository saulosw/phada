import type { LocalFileSystem } from '../config/local-files.js'
import { expandHome } from '../config/user-config.js'
import type { ContextSources } from '../context/types.js'
import type { RepositoryFilesOptions, RepositoryTree } from '../github/repository-files.js'

export interface ContextReaders {
  home: string
  files: LocalFileSystem
  fetchRepositoryTree: (
    options: RepositoryFilesOptions & { sha: string },
  ) => Promise<RepositoryTree>
  fetchRepositoryFile: (
    options: RepositoryFilesOptions & { path: string; ref: string },
  ) => Promise<string | null>
}

export function contextSourcesAt(
  readers: ContextReaders,
  repository: RepositoryFilesOptions,
  ref: string,
): ContextSources {
  return {
    readTree: () => readers.fetchRepositoryTree({ ...repository, sha: ref }),
    readRepoFile: (path) => readers.fetchRepositoryFile({ ...repository, path, ref }),
    readLocalFile: (path) => readers.files.readText(expandHome(path, readers.home)),
    listLocalDocs: (path) => readers.files.listDocs(expandHome(path, readers.home)),
  }
}
