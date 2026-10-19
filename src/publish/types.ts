import type { Finding } from '../review/types.js'

export interface PublicationPlan {
  comments: Finding[]
  stillOpen: Finding[]
  dismissed: Finding[]
  fixedAgain: Finding[]
  openThreads: number
}

export type SkipReason =
  | { kind: 'open-threads'; openThreads: number }
  | { kind: 'nothing-found' }
  | { kind: 'already-reviewed' }
  | { kind: 'same-diff'; since: string; ignoredOnly: boolean }
  | { kind: 'closed-or-draft' }

export type RunDecision =
  { action: 'run'; wouldSkip?: SkipReason } | { action: 'skip'; reason: SkipReason }
