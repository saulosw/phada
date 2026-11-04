import type { HistoryStore, MissFilter, MissRecord } from '../store/history-store.js'

export type { MissRecord } from '../store/history-store.js'

export type MissReader = Pick<HistoryStore, 'misses'>

export interface MissList {
  misses: MissRecord[]
  total: number
  dismissed: number
}

export function readMisses(
  history: MissReader | undefined,
  filter: Omit<MissFilter, 'state' | 'limit'>,
  all: boolean,
): MissList {
  if (history === undefined) return { misses: [], total: 0, dismissed: 0 }
  const { misses, total } = history.misses(all ? filter : { ...filter, state: 'open' })
  const dismissed = history.misses({ ...filter, state: 'dismissed', limit: 0 }).total
  return { misses, total, dismissed }
}
