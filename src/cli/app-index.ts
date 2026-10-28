import { errorMessage } from '../app/error-message.js'
import { indexRepository } from '../app/index-repository.js'
import type { IndexingOptions, IndexingResult } from '../app/index-repository.js'
import { repositoryCache } from '../config/cache-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadUserLayers } from '../config/user-config.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { Extractor } from '../repo-map/extract.js'
import type { GitMirror, GitMirrorOptions } from '../repository/git-mirror.js'
import type { IndexStore } from '../store/index-store.js'
import { readGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'

export interface AppIndexDeps extends GitHubTokenDeps {
  home: string
  version: string
  files: LocalFileSystem
  openMirror: (options: GitMirrorOptions) => Promise<GitMirror>
  openIndexStore: (path: string, version: string) => Promise<IndexStore>
  createExtractor: () => Extractor
}

export async function indexForApp(
  name: string,
  { signal, onProgress }: IndexingOptions,
  deps: AppIndexDeps,
): Promise<IndexingResult> {
  try {
    const token = await readGitHubToken(deps)
    if (token === undefined) return { kind: 'no-token' }
    const target = splitRepoName(name)
    const cache = repositoryCache(deps.env, deps.home, target.owner, target.repo)
    const userLayers = await loadUserLayers({ ...deps, ...target })
    onProgress({ phase: 'fetching' })
    const mirror = await deps.openMirror({ dir: cache.mirror, ...target, token, env: deps.env })
    const result = await indexRepository(
      { ...target, userLayers, signal },
      {
        mirror,
        openStore: () => deps.openIndexStore(cache.index, deps.version),
        extractor: deps.createExtractor(),
        now: () => performance.now(),
        events: {
          extracting: (total) => onProgress({ phase: 'extracting', done: 0, total }),
          extracted: (done, total) => onProgress({ phase: 'extracting', done, total }),
        },
      },
    )
    if ('cancelled' in result) {
      return { kind: 'cancelled', extracted: result.extracted, total: result.total }
    }
    return { kind: 'indexed', files: result.files.indexed }
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) }
  }
}
