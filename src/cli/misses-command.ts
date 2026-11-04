import { readMisses } from '../app/read-misses.js'
import { dataFiles } from '../config/data-paths.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import type { ListClosedPullRequestsOptions } from '../github/list-closed-pull-requests.js'
import type { IndexFormat, RulesTarget } from './args.js'
import { MissNotFoundError } from './errors.js'
import { formatMissesJson, formatMissesText } from './format-misses.js'
import { existingHistory, filterOf } from './history-access.js'
import type { HistoryCommandDeps } from './history-access.js'
import { refreshHistory, refreshToken } from './history-refresh.js'

export interface MissesCommand {
  target?: RulesTarget
  all: boolean
  refresh: boolean
  since?: string
  format: IndexFormat
}

export interface MissesCommandDeps extends HistoryCommandDeps {
  listClosedPullRequests: (options: ListClosedPullRequestsOptions) => Promise<number[]>
}

export interface MissesDismissCommand {
  id: number
}

export async function runMisses(command: MissesCommand, deps: MissesCommandDeps): Promise<void> {
  const token = command.refresh
    ? await refreshToken(deps, historyEnabled(await loadTopLevelUserLayers(deps)))
    : undefined
  const path = dataFiles(deps.env, deps.home).history
  const filter = filterOf(command.target)
  const history =
    token === undefined ? await existingHistory(path, deps) : await deps.openHistoryStore(path)
  try {
    if (history !== undefined && token !== undefined) {
      const closed =
        command.since !== undefined && command.target?.kind === 'repo'
          ? await deps.listClosedPullRequests({
              ...command.target.repo,
              token,
              since: command.since,
            })
          : []
      await refreshHistory(history, filter, token, deps, closed)
    }
    const list = readMisses(history, filter, command.all)
    deps.stdout.write(
      command.format === 'json' ? formatMissesJson(list) : formatMissesText(list, command.all),
    )
  } finally {
    history?.close()
  }
}

export async function runMissesDismiss(
  command: MissesDismissCommand,
  deps: HistoryCommandDeps,
): Promise<void> {
  const history = await existingHistory(dataFiles(deps.env, deps.home).history, deps)
  if (history === undefined) throw new MissNotFoundError(command.id)
  try {
    if (!history.dismissMiss(command.id)) throw new MissNotFoundError(command.id)
    deps.stderr.write(`Dismissed miss ${command.id}; phada misses no longer lists it.\n`)
  } finally {
    history.close()
  }
}
