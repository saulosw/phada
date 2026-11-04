import type { LocalFileSystem } from '../config/local-files.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import { openExistingHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import type { RulesTarget } from './args.js'
import type { GitHubTokenDeps } from './github-token.js'
import type { TextOutput } from './progress.js'

export interface HistoryCommandDeps extends GitHubTokenDeps {
  home: string
  files: LocalFileSystem
  stdout: TextOutput
  stderr: TextOutput
  clock: () => Date
  openHistoryStore: (path: string) => Promise<HistoryStore>
  openHistoryReader?: (path: string) => Promise<HistoryStore>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
}

export async function existingHistory(
  path: string,
  deps: HistoryCommandDeps,
  open: (path: string) => Promise<HistoryStore> = deps.openHistoryStore,
): Promise<HistoryStore | undefined> {
  const opening = await openExistingHistoryStore(path, {
    exists: (file) => deps.files.exists(file),
    open,
  })
  if (opening.status === 'missing') return undefined
  if (opening.status === 'open') return opening.history
  throw opening.error
}

export interface Filter {
  repo?: string
  number?: number
}

export function filterOf(target: RulesTarget | undefined): Filter {
  if (target === undefined) return {}
  if (target.kind === 'repo') return { repo: `${target.repo.owner}/${target.repo.repo}` }
  const { owner, repo, number } = target.ref
  return { repo: `${owner}/${repo}`, number }
}
