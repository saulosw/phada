import { refreshFeedback } from '../app/feedback.js'
import { toTerminalText } from '../app/terminal-text.js'
import type { DueFilter, HistoryStore } from '../store/history-store.js'
import { UsageError } from './errors.js'
import { requireGitHubToken } from './github-token.js'
import type { HistoryCommandDeps } from './history-access.js'
import { feedbackRefreshDeps } from './review-wiring.js'
import { formatCount } from './units.js'

export async function refreshToken(deps: HistoryCommandDeps, enabled: boolean): Promise<string> {
  if (!enabled) {
    throw new UsageError('--refresh saves to the history; remove history: false from your config.')
  }
  return requireGitHubToken(deps, 'read the pull requests and their comments')
}

export async function refreshHistory(
  history: HistoryStore,
  filter: Pick<DueFilter, 'repo' | 'number'>,
  token: string,
  deps: HistoryCommandDeps,
): Promise<void> {
  const due =
    filter.repo !== undefined && filter.number !== undefined
      ? [{ repo: filter.repo.toLowerCase(), number: filter.number }]
      : history.feedbackDue(filter, deps.clock().toISOString())
  if (due.length === 0) return
  deps.stderr.write(`Refreshing ${formatCount(due.length, 'pull request')}…\n`)
  let misses = 0
  await refreshFeedback(
    due,
    'refresh',
    feedbackRefreshDeps(history, token, deps, {
      observed: (_pull, _threads, found) => {
        misses += found
      },
      warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
    }),
  )
  if (misses > 0) {
    deps.stderr.write(`Found ${formatCount(misses, 'new miss', 'new misses')}.\n`)
  }
}
