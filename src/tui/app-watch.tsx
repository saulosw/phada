import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { WatchControl, WatchEvent, WatchObserver } from '../app/watch-event.js'
import { useAppDeps, useMessages, useWorking } from './app-context.js'
import type { QuitGuard, QuitGuardHold } from './app-context.js'
import { NO_STEPS, stepsAfter } from './review-steps.js'
import type { ReviewSteps } from './review-steps.js'
import { appendLog } from './watch-log.js'
import type { WatchLogEntry, WatchLogLine } from './watch-log.js'

export type WatchPhase = 'idle' | 'starting' | 'running' | 'stopping'

export type WatchNotice = { kind: 'elsewhere'; pid: number } | { kind: 'failed'; error: unknown }

type WatchJob = Parameters<WatchObserver['progress']>[0]

export interface RunningJob {
  job: WatchJob
  steps: ReviewSteps
}

export interface AppWatchSession {
  phase: WatchPhase
  notice: WatchNotice | undefined
  log: readonly WatchLogEntry[]
  running: RunningJob | undefined
  asking: boolean
  toggle(holder?: number): void
  confirmStop(): void
  keepRunning(): void
}

const IDLE: AppWatchSession = {
  phase: 'idle',
  notice: undefined,
  log: [],
  running: undefined,
  asking: false,
  toggle: () => {},
  confirmStop: () => {},
  keepRunning: () => {},
}

export const AppWatchContext = createContext<AppWatchSession>(IDLE)

export function useAppWatch(): AppWatchSession {
  return useContext(AppWatchContext)
}

export function useWatchSession(hold: QuitGuardHold): AppWatchSession {
  const { startWatch, now, pid } = useAppDeps()
  const messages = useMessages()
  const [phase, setPhase] = useState<WatchPhase>('idle')
  const [notice, setNotice] = useState<WatchNotice | undefined>()
  const [log, setLog] = useState<readonly WatchLogEntry[]>([])
  const [running, setRunning] = useState<RunningJob | undefined>()
  const [asking, setAsking] = useState(false)
  const control = useRef<WatchControl | undefined>(undefined)
  const phaseNow = useRef<WatchPhase>('idle')
  const move = useCallback((next: WatchPhase) => {
    phaseNow.current = next
    setPhase(next)
  }, [])
  const add = useCallback(
    (line: WatchLogLine) => setLog((current) => appendLog(current, { at: now().getTime(), line })),
    [now],
  )
  const start = () => {
    move('starting')
    setNotice(undefined)
    const observer: WatchObserver = {
      event: (event) => {
        add({ kind: 'event', event })
        setRunning((current) => runningAfter(current, event))
      },
      progress: (job, event) => {
        if (event.kind === 'warning') {
          add({ kind: 'event', event: { kind: 'warning', message: event.message } })
          return
        }
        setRunning((current) => ({
          job,
          steps: stepsAfter(
            current?.job.id === job.id ? current.steps : NO_STEPS,
            event,
            now().getTime(),
          ),
        }))
      },
    }
    startWatch(observer).then(
      (result) => {
        if (result.status === 'elsewhere') {
          setNotice({ kind: 'elsewhere', pid: result.pid })
          move('idle')
          return
        }
        control.current = result.control
        move('running')
        add({ kind: 'watchStarted' })
        const ended = (line: WatchLogLine) => {
          control.current = undefined
          setRunning(undefined)
          setAsking(false)
          move('idle')
          add(line)
        }
        result.control.done.then(
          (end) => ended({ kind: 'watchEnded', end }),
          (error: unknown) => ended({ kind: 'watchEnded', end: { reason: 'fatal', error } }),
        )
      },
      (error: unknown) => {
        setNotice({ kind: 'failed', error })
        move('idle')
      },
    )
  }
  const stop = () => {
    setAsking(false)
    if (phaseNow.current !== 'running') return
    control.current?.stop()
    move('stopping')
    add({ kind: 'watchStopping' })
  }
  const guard = useRef<QuitGuard | undefined>(undefined)
  guard.current =
    phase === 'running' || phase === 'stopping'
      ? {
          question: messages.queue.watch.quitQuestion,
          stop: () => {
            const current = control.current
            if (current === undefined) return undefined
            current.stop()
            return current.done.then(
              () => undefined,
              () => undefined,
            )
          },
          abort: () => control.current?.abort(),
        }
      : undefined
  const held = guard.current !== undefined
  useEffect(() => (held ? hold(guard) : undefined), [held, hold])
  useWorking(running !== undefined)
  return {
    phase,
    notice,
    log,
    running,
    asking: asking && phase === 'running',
    toggle: (holder) => {
      if (phaseNow.current === 'running') {
        setNotice(undefined)
        setAsking(true)
        return
      }
      if (phaseNow.current !== 'idle') return
      if (holder !== undefined && holder !== pid) {
        setNotice({ kind: 'elsewhere', pid: holder })
        return
      }
      start()
    },
    confirmStop: stop,
    keepRunning: () => setAsking(false),
  }
}

function runningAfter(current: RunningJob | undefined, event: WatchEvent): RunningJob | undefined {
  switch (event.kind) {
    case 'started':
      return { job: event.job, steps: NO_STEPS }
    case 'finished':
    case 'failed':
    case 'retry':
      return current?.job.id === event.job.id ? undefined : current
    case 'paused':
      return undefined
    default:
      return current
  }
}
