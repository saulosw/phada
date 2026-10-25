import { createContext } from 'react'
import type { DataState } from './data-hooks.js'

export const FRESH_MS = 30_000

export interface LoadEntry {
  state: DataState<unknown>
  loading: boolean
}

export interface LoadCache {
  entry(key: string): LoadEntry
  subscribe(key: string, listener: () => void): () => void
  load(key: string, loader: () => Promise<unknown>, options: { force: boolean }): void
}

interface StoredEntry {
  view: LoadEntry
  settledAt: number | null
  round: number
}

const NOT_LOADED: LoadEntry = { state: { status: 'loading' }, loading: false }

export const LoadCacheContext = createContext<LoadCache | undefined>(undefined)

export function createLoadCache(now: () => number, freshMs = FRESH_MS): LoadCache {
  const entries = new Map<string, StoredEntry>()
  const listeners = new Map<string, Set<() => void>>()
  const store = (key: string, entry: StoredEntry) => {
    entries.set(key, entry)
    for (const listener of [...(listeners.get(key) ?? [])]) listener()
  }
  const isFresh = (entry: StoredEntry) =>
    entry.view.loading || (entry.settledAt !== null && now() - entry.settledAt < freshMs)
  return {
    entry: (key) => entries.get(key)?.view ?? NOT_LOADED,
    subscribe: (key, listener) => {
      const keyListeners = listeners.get(key) ?? new Set()
      keyListeners.add(listener)
      listeners.set(key, keyListeners)
      return () => keyListeners.delete(listener)
    },
    load: (key, loader, { force }) => {
      const current = entries.get(key)
      if (!force && current !== undefined && isFresh(current)) return
      const round = (current?.round ?? 0) + 1
      store(key, {
        view: { state: current?.view.state ?? NOT_LOADED.state, loading: true },
        settledAt: current?.settledAt ?? null,
        round,
      })
      void settle(loader).then((state) => {
        if (entries.get(key)?.round !== round) return
        store(key, { view: { state, loading: false }, settledAt: now(), round })
      })
    },
  }
}

export async function settle<T>(read: () => T | Promise<T>): Promise<DataState<T>> {
  try {
    return { status: 'ready', value: await read() }
  } catch (error) {
    return { status: 'failed', error }
  }
}
