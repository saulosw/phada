import { refreshFeedback } from '../app/feedback.js'
import { dataFiles } from '../config/data-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import { PullRequestNotFoundError } from '../github/errors.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { HistoryStore } from '../store/history-store.js'
import type { IndexFormat, RulesTarget } from './args.js'
import { MissingGitHubTokenError, UsageError } from './errors.js'
import {
  feedbackStats,
  formatHistoryJson,
  formatHistoryText,
  formatStatsJson,
  formatStatsText,
} from './format-history.js'
import type { TextOutput } from './progress.js'
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

export interface HistoryCommandDeps {
  env: NodeJS.ProcessEnv
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
  const token = command.refresh ? refreshToken(deps.env, enabled) : undefined
  if (!enabled) deps.stderr.write('The history is off in your config; nothing new is saved.\n')
  const now = deps.clock()
  const since =
    command.sinceMs === undefined
      ? undefined
      : new Date(now.getTime() - command.sinceMs).toISOString()
  const path = dataFiles(deps.env, deps.home).history
  if (token === undefined && !(await deps.files.exists(path))) {
    deps.stdout.write(render(command, since, undefined))
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
  const findings = source?.history.findings({ ...source.filter, since }) ?? []
  if (command.stats) {
    const stats = feedbackStats(findings)
    return json ? formatStatsJson(stats, since) : formatStatsText(stats, since)
  }
  const { runs, total } = source?.history.runs({
    ...source.filter,
    since,
    limit: command.limit,
  }) ?? { runs: [], total: 0 }
  if (json) return formatHistoryJson(runs, total, findings)
  return formatHistoryText(runs, total, command.target?.kind === 'pull' ? findings : undefined)
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
  await refreshFeedback(due, 'refresh', {
    history,
    fetchReviewState: (pull) =>
      deps.fetchReviewState({ ...splitRepoName(pull.repo), number: pull.number, token }),
    isNotFound: (error) => error instanceof PullRequestNotFoundError,
    now: () => deps.clock().toISOString(),
    events: {
      observed: () => undefined,
      warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
    },
  })
}

function refreshToken(env: NodeJS.ProcessEnv, enabled: boolean): string {
  if (!enabled) {
    throw new UsageError('--refresh saves to the history; remove history: false from your config.')
  }
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (!token) throw new MissingGitHubTokenError('read the pull requests and their comments')
  return token
}

function filterOf(target: RulesTarget | undefined): Filter {
  if (target === undefined) return {}
  if (target.kind === 'repo') return { repo: `${target.repo.owner}/${target.repo.repo}` }
  const { owner, repo, number } = target.ref
  return { repo: `${owner}/${repo}`, number }
}
