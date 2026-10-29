import type { PullRequest } from '../github/pull-request.js'
import type { BlockedCommand, ExternalToolCall, TokenUsage } from '../providers/types.js'

export type { BlockedCommand }

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

export type ReviewerLens =
  | { kind: 'default' }
  | { kind: 'append' | 'replace'; text: string; origin: string }
  | { kind: 'skill'; name: string; text: string; origin: string }

export interface SkillPass {
  skill: string
  lens: ReviewerLens
  mode?: 'native'
  paths?: string[]
  skip?: string
}

export type ConversationRole =
  'author' | 'owner' | 'member' | 'collaborator' | 'contributor' | 'external' | 'bot' | 'phada'

export interface ConversationReply {
  at: string
  author: string
  role: ConversationRole
  body: string
}

export type ConversationReviewState = 'approved' | 'changes-requested' | 'commented' | 'dismissed'

export type ConversationItem =
  | { kind: 'comment'; at: string; author: string; role: ConversationRole; body: string }
  | {
      kind: 'review'
      at: string
      author: string
      role: ConversationRole
      state: ConversationReviewState
      body?: string
    }
  | {
      kind: 'thread'
      at: string
      author: string
      role: ConversationRole
      file: string
      line: number | null
      resolved: boolean
      outdated: boolean
      body: string
      replies?: ConversationReply[]
      omittedReplies?: number
    }

export type CiCheckState = 'passing' | 'failing' | 'pending'

export interface CiCheck {
  name: string
  state: CiCheckState
  conclusion?: string
  title?: string
  summary?: string
  annotations?: string[]
  log?: string
}

export interface ReviewRequest {
  pullRequest: PullRequest
  language?: string
  minConfidence?: number
  verify?: boolean
  debt?: DebtMode
  context?: ReviewContext
  impact?: DiffImpact
  related?: RelatedSummary[]
  conversation?: ConversationItem[]
  ci?: CiCheck[]
  passes?: SkillPass[]
}

export interface ReviewTarget {
  repo: string
  number: number
  headSha: string
  diffFingerprint?: string
}

export type Severity = 'P0' | 'P1' | 'P2'

export type FindingScope = 'change' | 'repository'

export type DebtMode = 'summary' | 'comments' | 'off'

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
  suggestion?: Suggestion
  skill?: string
  scope?: FindingScope
}

export interface Suggestion {
  startLine: number
  endLine: number
  original: string
  replacement: string
}

export type ClaimVerdict = 'confirmed' | 'contradicted' | 'unverified'

export interface Claim {
  claim: string
  verdict: ClaimVerdict
  evidence: string
}

export interface SuggestionCounts {
  valid: number
  invalid: number
  dropped: number
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
  debt?: number
}

export interface PassReport {
  skill: string
  origin: string
  status: 'reviewed' | 'skipped' | 'failed'
  mode?: 'native'
  durationMs: number
  usage?: TokenUsage
  findings: number
  reason?: string
  output?: string
  captured?: number
  blocked?: BlockedCommand[]
}

export interface CapturedComment {
  path: string
  line?: number
  startLine?: number
  body: string
}

export interface CapturedWrite {
  command: string
  body: string
  comments: CapturedComment[]
}

export interface NativeSkillRun {
  text: string
  captured: CapturedWrite[]
  durationMs: number
  model?: string
  usage?: TokenUsage
  blocked: BlockedCommand[]
  externalCalls?: ExternalToolCall[]
  warnings?: string[]
}

export interface SkillBody {
  skill: string
  text: string
}

export interface InvestigationFloor {
  expected: number
  shortfalls: string[]
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
  debt?: Finding[]
  worthChecking: Finding[]
  worthCheckingOmitted: number
  minConfidence: number
  score: Score
  dropped: DroppedFindings
  claims: Claim[]
  investigationFloor?: InvestigationFloor
  verification?: Verification
  suggestions?: SuggestionCounts
  ignored?: string[]
  externalCalls?: ExternalToolCall[]
  warnings?: string[]
  passes?: PassReport[]
  skillBodies?: SkillBody[]
}

export interface RecheckThread {
  id: string
  file: string
  line: number | null
  title: string
  body: string
  patch?: string
  changed: boolean
}

export type RecheckVerdictKind = 'fixed' | 'still-valid' | 'unsure'

export interface RecheckVerdict {
  threadId: string
  file: string
  line: number | null
  title: string
  verdict: RecheckVerdictKind
  reason: string
  by: 'ai' | 'unchanged' | 'no-access'
}

export interface RecheckReport {
  threads: number
  fixed: number
  stillValid: number
  unsure: number
  verdicts: RecheckVerdict[]
  durationMs: number
  usage?: TokenUsage
}

export type SkipReviewReason = 'empty-diff' | 'all-ignored' | 'no-skill-applies'

export type ReviewOutcome =
  | { status: 'reviewed'; result: ReviewResult }
  | { status: 'skipped'; reason: SkipReviewReason; passes?: PassReport[] }
