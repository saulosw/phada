import type { PullRequest } from '../github/pull-request.js'
import type { ExternalToolCall, TokenUsage } from '../providers/types.js'

export interface ContextRule {
  key: string
  text: string
  scope: string[]
  except?: string[]
  severity?: Severity
  origin: string
}

export interface ContextDoc {
  path: string
  content: string
}

export interface ReviewContext {
  rules: ContextRule[]
  docs: ContextDoc[]
  ignored: string[]
}

export interface ImpactSite {
  repo?: string
  path: string
  line: number
  in?: string
  kind: 'calls' | 'uses' | 'inherits' | 'related'
  how: 'resolved' | 'inferred' | 'observed'
  pullRequest?: number
  text: string
}

export interface ImpactDependency {
  name: string
  repo?: string
  path: string
  line: number
  kind: string
}

export interface ImpactedSymbol {
  kind: string
  name: string
  path: string
  startLine: number
  endLine: number
  exported: boolean
  callers: number
  files: number
  capped?: boolean
  sites: ImpactSite[]
  dependencies: ImpactDependency[]
  related?: RelatedReach[]
}

export interface RelatedReach {
  repo: string
  callers: number
  uses: number
}

export interface DiffImpact {
  symbols: ImpactedSymbol[]
  omittedSymbols: number
  callerFiles: number
}

export type RelatedState = 'consumers' | 'uses' | 'linked' | 'unlinked'

export interface RelatedSummary {
  repo: string
  commit: string
  state: RelatedState
  count?: number
  description?: string
  graph: boolean
}

export interface ReviewRequest {
  pullRequest: PullRequest
  language?: string
  minConfidence?: number
  verify?: boolean
  context?: ReviewContext
  impact?: DiffImpact
  related?: RelatedSummary[]
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
  rule?: string
  sources?: string[]
  reason?: string
}

export interface RejectedFinding extends Finding {
  reason: string
}

export interface Verification {
  candidates: number
  confirmed: number
  unverified: number
  rejected: RejectedFinding[]
  durationMs: number
  usage?: TokenUsage
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
  rejected: number
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
  verification?: Verification
  ignored?: string[]
  externalCalls?: ExternalToolCall[]
  warnings?: string[]
}

export type SkipReviewReason = 'empty-diff' | 'all-ignored'

export type ReviewOutcome =
  { status: 'reviewed'; result: ReviewResult } | { status: 'skipped'; reason: SkipReviewReason }
