import type { Finding } from '../review/types.js'

export interface PublicationPlan {
  comments: Finding[]
  stillOpen: Finding[]
  openThreads: number
}

export type SkipReason = { kind: 'open-threads'; openThreads: number } | { kind: 'nothing-found' }

export type RunDecision =
  { action: 'run'; wouldSkip?: SkipReason } | { action: 'skip'; reason: SkipReason }
