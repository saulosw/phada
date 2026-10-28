import type { WatchControl, WatchObserver, WatchStarted } from '../app/watch-event.js'
import { dataFiles } from '../config/data-paths.js'
import { childScope } from '../process/run-command.js'
import type { ChildScope } from '../process/run-command.js'
import { startWatch } from './watch-session.js'
import type { WatchSessionDeps } from './watch-session.js'

export interface AppWatchDeps extends WatchSessionDeps {
  startWatch?: typeof startWatch
  childScope?: () => ChildScope
}

export interface AppWatch {
  start(observer: WatchObserver): Promise<WatchStarted>
  close(): Promise<void>
}

export function appWatch(deps: AppWatchDeps): AppWatch {
  let running: WatchControl | undefined
  let starting: Promise<unknown> = Promise.resolve()
  const start = async (observer: WatchObserver): Promise<WatchStarted> => {
    const holder = await deps.lockHolder(dataFiles(deps.env, deps.home).lock)
    if (holder !== undefined) return { status: 'elsewhere', pid: holder }
    const children = (deps.childScope ?? childScope)()
    const handle = await children.run(() =>
      (deps.startWatch ?? startWatch)(
        { once: false, backfill: false },
        { ...deps, killDetachedChildren: () => children.kill() },
        {
          event: observer.event,
          warning: (message) => observer.event({ kind: 'warning', message }),
          progress: (job) => {
            const sink = (event: Parameters<WatchObserver['progress']>[1]) =>
              observer.progress(job, event)
            return { review: sink, reviewAndPublish: sink }
          },
        },
      ),
    )
    const control: WatchControl = {
      done: handle.done,
      stop: () => handle.stop(),
      abort: () => handle.abort(),
    }
    running = control
    const forget = () => {
      if (running === control) running = undefined
    }
    void handle.done.then(forget, forget)
    return { status: 'started', control }
  }
  return {
    start: (observer) => {
      const started = start(observer)
      starting = started.catch(() => undefined)
      return started
    },
    close: async () => {
      await starting
      const control = running
      if (control === undefined) return
      control.abort()
      await control.done.catch(() => undefined)
    },
  }
}
