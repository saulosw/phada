import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { openPhadaThreads, phadaReviewsAt } from './phada-state.js'
import type { RunDecision, SkipReason } from './types.js'

export interface RunOptions {
  headSha: string
  force: boolean
  dryRun: boolean
}

export function decideRun(state: PullRequestReviewState, options: RunOptions): RunDecision {
  if (options.force) return { action: 'run' }
  const reason = skipReason(state, options.headSha)
  if (reason === undefined) return { action: 'run' }
  return options.dryRun ? { action: 'run', wouldSkip: reason } : { action: 'skip', reason }
}

function skipReason(state: PullRequestReviewState, headSha: string): SkipReason | undefined {
  const latest = phadaReviewsAt(state, headSha).at(-1)
  if (latest === undefined) return undefined
  const openThreads = openPhadaThreads(state).length
  if (openThreads > 0) return { kind: 'open-threads', openThreads }
  return latest.findings === 0 ? { kind: 'nothing-found' } : undefined
}
