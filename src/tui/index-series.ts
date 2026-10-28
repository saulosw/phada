import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../app/error-message.js'
import type { IndexingProgress, IndexingResult } from '../app/index-repository.js'
import { useAppDeps, useWorking } from './app-context.js'

export type SeriesEntry =
  | { repo: string; state: 'waiting' }
  | { repo: string; state: 'running'; progress: IndexingProgress | null }
  | { repo: string; state: 'done'; result: IndexingResult }

export type SeriesPhase = 'idle' | 'running' | 'stopping' | 'ended'

export interface IndexSeries {
  entries: readonly SeriesEntry[]
  phase: SeriesPhase
  start(repos: readonly string[]): void
  stop(): void
}

export function useIndexSeries(): IndexSeries {
  const { indexRepository } = useAppDeps()
  const [entries, setEntries] = useState<readonly SeriesEntry[]>([])
  const [phase, setPhase] = useState<SeriesPhase>('idle')
  const running = useRef<AbortController | undefined>(undefined)
  useWorking(phase === 'running' || phase === 'stopping')
  useEffect(() => () => running.current?.abort(), [])

  const start = useCallback(
    (repos: readonly string[]) => {
      if (running.current !== undefined) return
      const controller = new AbortController()
      running.current = controller
      const set = (index: number, entry: SeriesEntry) =>
        setEntries((current) => current.map((old, at) => (at === index ? entry : old)))
      setEntries(repos.map((repo) => ({ repo, state: 'waiting' })))
      setPhase('running')
      void (async () => {
        for (const [index, repo] of repos.entries()) {
          if (controller.signal.aborted) break
          set(index, { repo, state: 'running', progress: null })
          const result = await indexRepository(repo, {
            signal: controller.signal,
            onProgress: (progress) => set(index, { repo, state: 'running', progress }),
          }).catch((error: unknown): IndexingResult => ({
            kind: 'failed',
            message: errorMessage(error),
          }))
          set(index, { repo, state: 'done', result })
        }
        if (running.current === controller) running.current = undefined
        setPhase('ended')
      })()
    },
    [indexRepository],
  )
  const stop = useCallback(() => {
    const controller = running.current
    if (controller === undefined || controller.signal.aborted) return
    controller.abort()
    setPhase((current) => (current === 'running' ? 'stopping' : current))
  }, [])
  return { entries, phase, start, stop }
}
