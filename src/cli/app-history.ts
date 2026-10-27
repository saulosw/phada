import type { HistoryOpening, HistoryStore } from '../store/history-store.js'

export interface AppHistory {
  current(): Promise<HistoryStore | undefined>
  close(): void
}

export function appHistory(
  path: string,
  open: (path: string) => Promise<HistoryOpening>,
): AppHistory {
  let opened: HistoryStore | undefined
  let opening: Promise<HistoryStore | undefined> | undefined
  let closed = false

  const settle = async (): Promise<HistoryStore | undefined> => {
    const result = await open(path)
    if (result.status === 'missing') return undefined
    if (result.status !== 'open') throw result.error
    if (closed) {
      result.history.close()
      return undefined
    }
    opened = result.history
    return opened
  }

  return {
    current: async () => {
      if (closed) return undefined
      if (opened !== undefined) return opened
      opening ??= settle().finally(() => {
        opening = undefined
      })
      return opening
    },
    close: () => {
      if (closed) return
      closed = true
      opened?.close()
    },
  }
}
