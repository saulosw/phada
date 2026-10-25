import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAppDeps, useScreenInput, useWorking } from './app-context.js'
import { LoadCacheContext, settle } from './load-cache.js'

export { FRESH_MS } from './load-cache.js'

export const POLL_MS = 2000

export type DataState<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; error: unknown }

export function usePolled<T>(
  read: () => T | Promise<T>,
  intervalMs = POLL_MS,
  key = '',
): DataState<T> {
  const { scheduler } = useAppDeps()
  const [state, setState] = useState<DataState<T>>({ status: 'loading' })
  const latest = useRef(read)
  latest.current = read
  useWorking(state.status === 'loading')
  useEffect(() => {
    let mounted = true
    let reading = false
    const tick = () => {
      if (reading) return
      reading = true
      settle(latest.current)
        .then((next) => {
          if (mounted) setState(next)
        })
        .finally(() => {
          reading = false
        })
    }
    tick()
    const stop = scheduler.every(intervalMs, tick)
    return () => {
      mounted = false
      stop()
    }
  }, [scheduler, intervalMs, key])
  return state
}

export interface Loaded<T> {
  state: DataState<T>
  reload(): void
}

export function useLoaded<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const cache = useContext(LoadCacheContext)
  if (cache === undefined) throw new Error('useLoaded() outside the app')
  const latest = useRef(load)
  latest.current = load
  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(key, listener),
    [cache, key],
  )
  const entry = useSyncExternalStore(subscribe, () => cache.entry(key))
  useWorking(entry.loading || entry.state.status === 'loading')
  useEffect(() => {
    cache.load(key, () => latest.current(), { force: false })
  }, [cache, key])
  const reload = useCallback(() => {
    cache.load(key, () => latest.current(), { force: true })
  }, [cache, key])
  useScreenInput((input) => {
    if (input === 'r') reload()
  })
  return { state: entry.state as DataState<T>, reload }
}
