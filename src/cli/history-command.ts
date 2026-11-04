import { readFeedbackStats, readFindings, readReviews } from '../app/read-history.js'
import { readRunReport } from '../app/read-run-report.js'
import { formatRunReportJson, formatRunReportText } from './format-run-report.js'
import { dataFiles } from '../config/data-paths.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import type { IndexFormat, RulesTarget } from './args.js'
import { RunNotFoundError } from './errors.js'
import { existingHistory, filterOf } from './history-access.js'
import type { Filter, HistoryCommandDeps } from './history-access.js'
import { refreshHistory, refreshToken } from './history-refresh.js'
import {
  formatHistoryJson,
  formatHistoryText,
  formatStatsJson,
  formatStatsText,
} from './format-history.js'
import { formatCount } from './units.js'

export interface HistoryCommand {
  target?: RulesTarget
  sinceMs?: number
  limit: number
  stats: boolean
  refresh: boolean
  format: IndexFormat
}

export interface HistoryPruneCommand {
  olderThanMs: number
}

export interface HistoryShowCommand {
  id: number
  format: IndexFormat
}

export async function runHistory(command: HistoryCommand, deps: HistoryCommandDeps): Promise<void> {
  const enabled = historyEnabled(await loadTopLevelUserLayers(deps))
  const token = command.refresh ? await refreshToken(deps, enabled) : undefined
  if (!enabled) deps.stderr.write('The history is off in your config; nothing new is saved.\n')
  const now = deps.clock()
  const since =
    command.sinceMs === undefined
      ? undefined
      : new Date(now.getTime() - command.sinceMs).toISOString()
  const path = dataFiles(deps.env, deps.home).history
  const filter = filterOf(command.target)
  const history =
    token === undefined ? await existingHistory(path, deps) : await deps.openHistoryStore(path)
  if (history === undefined) {
    deps.stdout.write(
      command.format === 'json'
        ? render(command, since, undefined, filter)
        : 'No reviews in the history yet.\n',
    )
    return
  }
  try {
    if (token !== undefined) await refreshHistory(history, filter, token, deps)
    deps.stdout.write(render(command, since, history, filter))
  } finally {
    history.close()
  }
}

export async function runHistoryShow(
  command: HistoryShowCommand,
  deps: HistoryCommandDeps,
): Promise<void> {
  const history = await existingHistory(
    dataFiles(deps.env, deps.home).history,
    deps,
    deps.openHistoryReader ?? ((path) => openHistoryStore(path, { readOnly: true })),
  )
  if (history === undefined) {
    deps.stdout.write('No reviews in the history yet.\n')
    return
  }
  try {
    const report = readRunReport(history, command.id)
    if (report === undefined) throw new RunNotFoundError(command.id)
    deps.stdout.write(
      command.format === 'json' ? formatRunReportJson(report) : formatRunReportText(report),
    )
  } finally {
    history.close()
  }
}

export async function runHistoryPrune(
  command: HistoryPruneCommand,
  deps: HistoryCommandDeps,
): Promise<void> {
  const history = await existingHistory(dataFiles(deps.env, deps.home).history, deps)
  if (history === undefined) {
    deps.stdout.write('No reviews in the history yet.\n')
    return
  }
  const before = new Date(deps.clock().getTime() - command.olderThanMs).toISOString()
  try {
    const { runs, findings, jobs, vacuumed } = history.prune(before)
    deps.stdout.write(
      `Removed ${formatCount(runs, 'review')}, ${formatCount(findings, 'finding')} and ${formatCount(jobs, 'job')} older than ${before.slice(0, 10)}.\n`,
    )
    if (!vacuumed) {
      deps.stderr.write(
        'Warning: the history file is in use and was not compacted; the space is reused later.\n',
      )
    }
  } finally {
    history.close()
  }
}

function render(
  command: HistoryCommand,
  since: string | undefined,
  history: HistoryStore | undefined,
  filter: Filter,
): string {
  const json = command.format === 'json'
  const showsFindings = json || command.stats || command.target?.kind === 'pull'
  if (command.stats) {
    const stats = readFeedbackStats(history, { ...filter, since }).repos
    return json ? formatStatsJson(stats, since) : formatStatsText(stats, since)
  }
  const findings = showsFindings ? readFindings(history, { ...filter, since }) : undefined
  const { runs, total } = readReviews(history, { ...filter, since, limit: command.limit })
  if (json) return formatHistoryJson(runs, total, findings ?? [])
  if (total === 0 && findings === undefined && history !== undefined) {
    const comments = readFindings(history, { ...filter, since }).length
    if (comments > 0) return onlyCommentsText(comments)
  }
  return formatHistoryText(runs, total, findings)
}

function onlyCommentsText(comments: number): string {
  const one = comments === 1
  return `No reviews in the history yet, but ${formatCount(comments, 'Phada comment')} ${one ? 'is' : 'are'} recorded. See what happened to ${one ? 'it' : 'them'} with --stats, or with owner/repo#N for one pull request.\n`
}
