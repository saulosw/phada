import type { SubmitDeps } from '../app/submit-request.js'
import { userConfigDir } from '../config/user-config.js'
import { historyEnabled, resolveWatchSettings } from '../config/watch-settings.js'
import type { WatchSettings } from '../config/watch-settings.js'
import type { ConfigLayer } from '../config/types.js'
import { NOTHING_TO_WATCH, UsageError } from './errors.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { FetchPullRequestOptions, PullRequestMetadata } from '../github/pull-request.js'
import type { HistoryStore } from '../store/history-store.js'
import { fetchedPullFacts } from '../watch/pull-facts.js'
import type { PullFacts } from '../watch/pull-facts.js'
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
  return fetchedPullFacts(
    await deps.fetchPullRequestMetadata({ ...splitRepoName(repo), number, token }),
  )
}

export function watchSettingsOf(layers: readonly ConfigLayer[]): WatchSettings | undefined {
  return historyEnabled(layers) ? resolveWatchSettings(layers) : undefined
}

export function requireWatchSettings(layers: readonly ConfigLayer[]): WatchSettings {
  const settings = resolveWatchSettings(layers)
  if (settings === undefined) throw new UsageError(NOTHING_TO_WATCH)
  if (!historyEnabled(layers)) {
    throw new UsageError(
      'phada watch needs the history to know what it already reviewed; remove history: false from your config.',
    )
  }
  return settings
}
