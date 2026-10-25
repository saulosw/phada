import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDeps, useScreenInput, useWorking } from './app-context.js'

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

export function useLoaded<T>(load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<DataState<T>>({ status: 'loading' })
  const [round, setRound] = useState(0)
  const latest = useRef(load)
  latest.current = load
  useWorking(state.status === 'loading')
  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void settle(latest.current).then((next) => {
      if (current) setState(next)
    })
    return () => {
      current = false
    }
  }, [round])
  const reload = useCallback(() => setRound((value) => value + 1), [])
  useScreenInput((input) => {
    if (input === 'r') reload()
  })
  return { state, reload }
}

async function settle<T>(read: () => T | Promise<T>): Promise<DataState<T>> {
  try {
    return { status: 'ready', value: await read() }
  } catch (error) {
    return { status: 'failed', error }
  }
}
