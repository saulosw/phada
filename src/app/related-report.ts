import type { RelatedState } from '../review/types.js'
import type { SkipReason } from './select-related.js'

export interface RelatedEntry {
  repo: string
  origin: string
  description?: string
  commit?: string
  state: RelatedState | 'skipped'
  count?: number
  packages: string[]
  graph: boolean
  reason?: SkipReason
}

export interface RelatedReport {
  status: 'used' | 'off' | 'unavailable' | 'none'
  reason?: string
  repositories: RelatedEntry[]
}
