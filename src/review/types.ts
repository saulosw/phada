import type { PullRequest } from '../github/pull-request.js'
import type { TokenUsage } from '../providers/types.js'

export interface ReviewRequest {
  pullRequest: PullRequest
  language?: string
  minConfidence?: number
}

export interface ReviewTarget {
  repo: string
  number: number
  headSha: string
}

export type Severity = 'P0' | 'P1' | 'P2'

export interface Finding {
  severity: Severity
  confidence: number
  file: string
  line: number
  title: string
  why: string
  fix: string | null
}

export interface FileChange {
  path: string
  change: string
  findings: number
}

export type ScoreValue = 0 | 1 | 2 | 3 | 4 | 5

export interface Score {
  value: ScoreValue
  reason: string
}

export interface DroppedFindings {
  invalid: number
  belowFloor: number
  outsideDiff: number
  duplicate: number
}

export interface ReviewResult {
  target: ReviewTarget
  providerId: string
  model?: string
  additionalModels?: string[]
  durationMs: number
  usage?: TokenUsage
  summary: string
  files: FileChange[]
  findings: Finding[]
  worthChecking: Finding[]
  worthCheckingOmitted: number
  minConfidence: number
  score: Score
  dropped: DroppedFindings
}

export type ReviewOutcome =
  { status: 'reviewed'; result: ReviewResult } | { status: 'skipped'; reason: 'empty-diff' }
