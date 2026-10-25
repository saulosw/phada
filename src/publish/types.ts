import type { CiCheck, CiCheckState, ConversationItem, Finding } from '../review/types.js'

export interface PublicationPlan {
  comments: Finding[]
  stillOpen: Finding[]
  dismissed: Finding[]
  fixedAgain: Finding[]
  fixedThreads: number
  openThreads: number
}

export type SkipReason =
  | { kind: 'open-threads'; openThreads: number }
  | { kind: 'nothing-found' }
  | { kind: 'already-reviewed' }
  | { kind: 'same-diff'; since: string }
  | { kind: 'closed-or-draft' }

export type RunDecision =
  { action: 'run'; wouldSkip?: SkipReason } | { action: 'skip'; reason: SkipReason }

export interface ConversationReport {
  items: number
  omitted: number
  resolved: number
  bots: number
  truncated: number
  bytes: number
}

export interface Conversation {
  items: ConversationItem[]
  report: ConversationReport
}

export type CiState = 'none' | 'pending' | 'passing' | 'failing'

export interface CiEntry {
  name: string
  kind: 'check-run' | 'status'
  id?: number
  actions: boolean
  state: CiCheckState
  conclusion?: string
  title?: string
  summary?: string
  url?: string
}

export interface CiSummary {
  state: CiState
  total: number
  failing: string[]
  pending: string[]
}

export interface CiReport {
  annotations: number
  omittedAnnotations: number
  logs: number
  omittedLogs: number
  truncated: number
  bytes: number
}

export interface Ci {
  checks: CiCheck[]
  summary: CiSummary
  report: CiReport
  warnings?: string[]
}
