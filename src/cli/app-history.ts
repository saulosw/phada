import type { HistoryOpening, HistoryStore } from '../store/history-store.js'

export interface AppHistory {
  current(): Promise<HistoryStore | undefined>
  close(): void
}

type Opened = { history: HistoryStore } | { error: Error }

export function appHistory(
  path: string,
  open: (path: string) => Promise<HistoryOpening>,
): AppHistory {
  let opened: Opened | undefined
  let opening: Promise<HistoryStore | undefined> | undefined
  let closed = false

  const settle = async (): Promise<HistoryStore | undefined> => {
    const result = await open(path)
    if (result.status === 'missing') return undefined
    opened = result.status === 'open' ? { history: result.history } : { error: result.error }
    if (closed && 'history' in opened) opened.history.close()
    return read()
  }

  const read = (): HistoryStore | undefined => {
    if (closed || opened === undefined) return undefined
    if ('error' in opened) throw opened.error
    return opened.history
  }

  return {
    current: async () => {
      if (closed) return undefined
      if (opened !== undefined) return read()
      opening ??= settle().finally(() => {
        opening = undefined
      })
      return opening
    },
    close: () => {
      if (closed) return
      closed = true
      if (opened !== undefined && 'history' in opened) opened.history.close()
    },
  }
}
