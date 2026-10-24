import type { SubmitDeps } from '../app/submit-request.js'
import { userConfigDir } from '../config/user-config.js'
import type { WatchSettings } from '../config/watch-settings.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { FetchPullRequestOptions, PullRequestMetadata } from '../github/pull-request.js'
import type { HistoryStore } from '../store/history-store.js'
import type { PullFacts } from '../watch/request-policy.js'
import { whenChecker } from './run-when.js'

export interface RequestWiringDeps {
  env: NodeJS.ProcessEnv
  home: string
  clock: () => Date
  fetchPullRequestMetadata: (options: FetchPullRequestOptions) => Promise<PullRequestMetadata>
}

export function submitDeps(
  history: HistoryStore,
  settings: WatchSettings,
  token: string,
  deps: RequestWiringDeps,
): SubmitDeps {
  return {
    history,
    settings,
    readPull: (repo, number) => readPullFacts(repo, number, token, deps),
    checkWhen: whenChecker({ cwd: userConfigDir(deps.env, deps.home), env: deps.env }),
    now: deps.clock,
  }
}

export async function readPullFacts(
  repo: string,
  number: number,
  token: string,
  deps: Pick<RequestWiringDeps, 'fetchPullRequestMetadata'>,
): Promise<PullFacts> {
  const pull = await deps.fetchPullRequestMetadata({ ...splitRepoName(repo), number, token })
  return {
    repo: pull.repo,
    number: pull.number,
    headSha: pull.headSha,
    state: pull.state,
    private: pull.private,
    association: pull.association,
    author: pull.author,
    draft: pull.draft,
    baseRef: pull.baseRef,
    title: pull.title,
  }
}
