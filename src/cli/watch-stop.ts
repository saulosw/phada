import type { WatchEvents } from '../app/watch-repositories.js'
import type { JobRecord } from '../watch/types.js'

export interface StopControl {
  readonly signal: AbortSignal
  readonly aborted: Promise<void>
  stop(): void
  abort(): void
  stopRequested(): boolean
  abortRequested(): boolean
  running(): JobRecord | undefined
  track(job: JobRecord | undefined): void
}

export interface StopDeps {
  killChildren(): void
  putBack(job: JobRecord): void
  close(): void
}

export function createStopControl(deps: StopDeps): StopControl {
  const controller = new AbortController()
  let aborting = false
  let current: JobRecord | undefined
  let finish: () => void = () => undefined
  const aborted = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    signal: controller.signal,
    aborted,
    stop: () => controller.abort(),
    abort: () => {
      if (aborting) return
      aborting = true
      controller.abort()
      deps.killChildren()
      if (current !== undefined) deps.putBack(current)
      deps.close()
      finish()
    },
    stopRequested: () => controller.signal.aborted,
    abortRequested: () => aborting,
    running: () => current,
    track: (job) => {
      current = job
    },
  }
}

export function trackRunningJob(events: WatchEvents, stop: StopControl): WatchEvents {
  const settled =
    <A extends unknown[]>(handler: (...args: A) => void) =>
    (...args: A) => {
      stop.track(undefined)
      handler(...args)
    }
  return {
    ...events,
    started: (job) => {
      stop.track(job)
      events.started(job)
    },
    finished: settled(events.finished),
    retry: settled(events.retry),
    paused: settled(events.paused),
    failed: settled(events.failed),
  }
}
