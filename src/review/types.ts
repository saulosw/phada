import type { PullRequest } from '../github/pull-request.js'
import type { TokenUsage } from '../providers/types.js'

export interface ReviewRequest {
  pullRequest: PullRequest
  language?: string
}

export interface ReviewTarget {
  repo: string
  number: number
  headSha: string
}

export interface ReviewResult {
  target: ReviewTarget
  providerId: string
  model?: string
  additionalModels?: string[]
  text: string
  durationMs: number
  usage?: TokenUsage
}

export type ReviewOutcome =
  { status: 'reviewed'; result: ReviewResult } | { status: 'skipped'; reason: 'empty-diff' }
