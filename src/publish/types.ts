import type { ConversationItem, Finding, ReplyKind } from '../review/types.js'

export const REPLY_KINDS = [
  'ack',
  'applied',
  'question',
  'disagreed',
  'refuted',
] as const satisfies readonly ReplyKind[]

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
  omittedBots: number
  resolved: number
  bots: number
  truncated: number
  bytes: number
}

export interface Conversation {
  items: ConversationItem[]
  report: ConversationReport
}
