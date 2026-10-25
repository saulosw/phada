import { refreshFeedback } from '../app/feedback.js'
import { dataFiles } from '../config/data-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { HistoryStore } from '../store/history-store.js'
import type { IndexFormat, RulesTarget } from './args.js'
import { UsageError } from './errors.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import {
  feedbackStats,
  formatHistoryJson,
  formatHistoryText,
  formatStatsJson,
  formatStatsText,
} from './format-history.js'
import type { TextOutput } from './progress.js'
import { feedbackRefreshDeps } from './review-wiring.js'
import { toTerminalText } from './terminal-text.js'
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

export interface HistoryCommandDeps extends GitHubTokenDeps {
  home: string
  files: LocalFileSystem
  stdout: TextOutput
  stderr: TextOutput
  clock: () => Date
  openHistoryStore: (path: string) => Promise<HistoryStore>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
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
  if (token === undefined && !(await deps.files.exists(path))) {
    deps.stdout.write(
      command.format === 'json'
        ? render(command, since, undefined)
        : 'No reviews in the history yet.\n',
    )
    return
  }
  const history = await deps.openHistoryStore(path)
  try {
    const filter = filterOf(command.target)
    if (token !== undefined) await refresh(history, filter, token, deps)
    deps.stdout.write(render(command, since, { history, filter }))
  } finally {
    history.close()
  }
}

export async function runHistoryPrune(
  command: HistoryPruneCommand,
  deps: HistoryCommandDeps,
): Promise<void> {
  const path = dataFiles(deps.env, deps.home).history
  if (!(await deps.files.exists(path))) {
    deps.stdout.write('No reviews in the history yet.\n')
    return
  }
  const before = new Date(deps.clock().getTime() - command.olderThanMs).toISOString()
  const history = await deps.openHistoryStore(path)
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

interface Filter {
  repo?: string
  number?: number
}

function render(
  command: HistoryCommand,
  since: string | undefined,
  source: { history: HistoryStore; filter: Filter } | undefined,
): string {
  const json = command.format === 'json'
  const showsFindings = json || command.stats || command.target?.kind === 'pull'
  const findings = showsFindings
    ? (source?.history.findings({ ...source.filter, since }) ?? [])
    : undefined
  if (command.stats) {
    const stats = feedbackStats(findings ?? [])
    return json ? formatStatsJson(stats, since) : formatStatsText(stats, since)
  }
  const { runs, total } = source?.history.runs({
    ...source.filter,
    since,
    limit: command.limit,
  }) ?? { runs: [], total: 0 }
  if (json) return formatHistoryJson(runs, total, findings ?? [])
  if (total === 0 && findings === undefined && source !== undefined) {
    const comments = source.history.findings({ ...source.filter, since }).length
    if (comments > 0) return onlyCommentsText(comments)
  }
  return formatHistoryText(runs, total, findings)
}

function onlyCommentsText(comments: number): string {
  const one = comments === 1
  return `No reviews in the history yet, but ${formatCount(comments, 'Phada comment')} ${one ? 'is' : 'are'} recorded. See what happened to ${one ? 'it' : 'them'} with --stats, or with owner/repo#N for one pull request.\n`
}

async function refresh(
  history: HistoryStore,
  filter: Filter,
  token: string,
  deps: HistoryCommandDeps,
): Promise<void> {
  const due =
    filter.repo !== undefined && filter.number !== undefined
      ? [{ repo: filter.repo.toLowerCase(), number: filter.number }]
      : history.feedbackDue(filter, deps.clock().toISOString())
  if (due.length === 0) return
  deps.stderr.write(`Refreshing ${formatCount(due.length, 'pull request')}…\n`)
  await refreshFeedback(
    due,
    'refresh',
    feedbackRefreshDeps(history, token, deps, {
      observed: () => undefined,
      warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
    }),
  )
}

async function refreshToken(deps: HistoryCommandDeps, enabled: boolean): Promise<string> {
  if (!enabled) {
    throw new UsageError('--refresh saves to the history; remove history: false from your config.')
  }
  return requireGitHubToken(deps, 'read the pull requests and their comments')
}

function filterOf(target: RulesTarget | undefined): Filter {
  if (target === undefined) return {}
  if (target.kind === 'repo') return { repo: `${target.repo.owner}/${target.repo.repo}` }
  const { owner, repo, number } = target.ref
  return { repo: `${owner}/${repo}`, number }
}
