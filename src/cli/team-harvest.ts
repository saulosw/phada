import { errorMessage } from '../app/error-message.js'
import { toTerminalText } from '../app/terminal-text.js'
import type {
  ClosedPull,
  ListClosedPullRequestsOptions,
} from '../github/list-closed-pull-requests.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { HistoryStore } from '../store/history-store.js'
import type { HistoryCommandDeps } from './history-access.js'
import { refreshHistory } from './history-refresh.js'

const FIRST_HARVEST_DAYS = 90
const HARVEST_LIMIT = 200
const DAY_MS = 24 * 60 * 60 * 1000

export interface TeamHarvestDeps extends HistoryCommandDeps {
  listClosedPullRequests: (options: ListClosedPullRequestsOptions) => Promise<ClosedPull[]>
}

export async function harvestTeamComments(
  history: HistoryStore,
  repos: readonly string[],
  token: string,
  deps: TeamHarvestDeps,
  since?: string,
): Promise<void> {
  for (const repo of repos) {
    const cursor = history.lessonHarvest(repo)?.closedSince
    const from =
      since ??
      cursor ??
      new Date(deps.clock().getTime() - FIRST_HARVEST_DAYS * DAY_MS).toISOString()
    deps.stderr.write(
      `${toTerminalText(`${repo}: reading the pull requests closed since ${from.slice(0, 10)}…`)}\n`,
    )
    let closed: ClosedPull[]
    try {
      closed = await deps.listClosedPullRequests({
        ...splitRepoName(repo),
        token,
        since: from,
        limit: HARVEST_LIMIT,
      })
    } catch (error) {
      deps.stderr.write(`Warning: ${toTerminalText(`${repo}: ${errorMessage(error)}`)}\n`)
      continue
    }
    const { failed } = await refreshHistory(
      history,
      { repo },
      token,
      deps,
      closed.map(({ number }) => number),
    )
    const newest = latest([cursor, ...closed.map(({ closedAt }) => closedAt)])
    if (failed === 0 && newest !== undefined && newest !== cursor) {
      history.saveLessonHarvest({
        repo,
        closedSince: newest,
        harvestedAt: deps.clock().toISOString(),
      })
    }
  }
}

function latest(times: readonly (string | undefined)[]): string | undefined {
  let newest: string | undefined
  for (const time of times) {
    if (time === undefined) continue
    if (newest === undefined || Date.parse(time) > Date.parse(newest)) newest = time
  }
  return newest
}
