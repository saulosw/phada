import type { ReviewDetail } from './read-history.js'
import type { SubmitResult } from './submit-request.js'

export type ReviewMode = 'look' | 'publish'

export interface PullRequestTarget {
  owner: string
  repo: string
  number: number
}

export interface OpenPullRequest {
  number: number
  title: string | null
  author: string
  draft: boolean
}

export type OpenPullRequests =
  { status: 'no-token' } | { status: 'read'; repo: string; pulls: OpenPullRequest[] }

export type HistorySave =
  | { status: 'off' }
  | { status: 'saved'; runId: number; feedbackError?: string }
  | { status: 'not-saved'; error: string }

export type EnqueuedReview = { status: 'no-token' } | { status: 'submitted'; result: SubmitResult }

export type RequestedReview =
  | { status: 'no-token' }
  | { status: 'cancelled' }
  | { status: 'reviewed'; detail: ReviewDetail; history: HistorySave }
