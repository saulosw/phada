import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { latestPhadaReview, openPhadaThreads, phadaReviewsAt } from './phada-state.js'
import type { RunDecision, SkipReason } from './types.js'

export interface RunOptions {
  headSha: string
  force: boolean
  dryRun: boolean
  skipReviewedCommits?: boolean
  diff?: { fingerprint: string; ignoredOnly: boolean }
}

export function decideRun(state: PullRequestReviewState, options: RunOptions): RunDecision {
  if (options.force) return { action: 'run' }
  const reason =
    (options.skipReviewedCommits
      ? onceReason(state, options.headSha)
      : skipReason(state, options.headSha)) ?? sameDiffReason(state, options)
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

function onceReason(state: PullRequestReviewState, headSha: string): SkipReason | undefined {
  return phadaReviewsAt(state, headSha).length > 0 ? { kind: 'already-reviewed' } : undefined
}

function sameDiffReason(
  state: PullRequestReviewState,
  options: RunOptions,
): SkipReason | undefined {
  if (options.diff === undefined) return undefined
  const latest = latestPhadaReview(state)
  if (latest === undefined || latest.sha === options.headSha) return undefined
  if (latest.diff !== options.diff.fingerprint) return undefined
  return { kind: 'same-diff', since: latest.sha, ignoredOnly: options.diff.ignoredOnly }
}
