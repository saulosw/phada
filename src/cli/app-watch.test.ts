import { describe, expect, it } from 'vitest'
import type { ReviewProgress } from '../app/review-progress.js'
import type { WatchEnd, WatchEvent } from '../app/watch-event.js'
import { childScope, runCommand } from '../process/run-command.js'
import type { JobRecord } from '../watch/types.js'
import { appWatch } from './app-watch.js'
import type { AppWatchDeps } from './app-watch.js'
import { UsageError, WatchRunningError } from './errors.js'
import type { WatchHandle, WatchListeners, WatchSessionDeps, WatchStart } from './watch-session.js'

const LOCK = '/data/watch.lock'
const LONG_CHILD: [string, string[]] = [process.execPath, ['-e', 'setTimeout(() => {}, 30_000)']]
const JOB: JobRecord = {
  id: 7,
  repo: 'acme/shop',
  number: 12,
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  status: 'running',
  attempts: 0,
  notBefore: '2026-10-25T12:00:00.000Z',
  createdAt: '2026-10-25T12:00:00.000Z',
}

interface FakeSession {
  start: WatchStart
  deps: WatchSessionDeps
  listeners: WatchListeners
  stops: number
  aborts: number
  end(end: WatchEnd): void
}

function harness(
  options: {
    holder?: number
    startWatch?: (session: FakeSession) => Promise<void>
    fail?: unknown
  } = {},
) {
  const sessions: FakeSession[] = []
  const deps: AppWatchDeps = {
    ...({} as WatchSessionDeps),
    env: { PHADA_DATA_HOME: '/data' },
    home: '/home/ana',
    lockHolder: async (path) => (path === LOCK ? options.holder : undefined),
    startWatch: async (start, sessionDeps, listeners) => {
      if (options.fail !== undefined) throw options.fail
      let end: (value: WatchEnd) => void = () => undefined
      const done = new Promise<WatchEnd>((resolve) => {
        end = resolve
      })
      const session: FakeSession = {
        start,
        deps: sessionDeps,
        listeners,
        stops: 0,
        aborts: 0,
        end,
      }
      sessions.push(session)
      await options.startWatch?.(session)
      const handle: WatchHandle = {
        done,
        stop: () => {
          session.stops += 1
        },
        abort: () => {
          session.aborts += 1
          sessionDeps.killDetachedChildren()
          end({ reason: 'aborted' })
        },
        stopRequested: () => session.stops > 0,
        running: () => undefined,
      }
      return handle
    },
  }
  const events: WatchEvent[] = []
  const progress: { job: number; event: ReviewProgress['kind'] }[] = []
  const observer = {
    event: (event: WatchEvent) => events.push(event),
    progress: (job: JobRecord, event: ReviewProgress) =>
      progress.push({ job: job.id, event: event.kind }),
  }
  return { deps, sessions, events, progress, observer }
}

describe('the watch the app starts', () => {
  it('starts the watch of phada watch, which keeps going until stopped', async () => {
    const { deps, sessions, observer } = harness()

    const started = await appWatch(deps).start(observer)

    expect(started.status).toBe('started')
    expect(sessions.map(({ start }) => start)).toEqual([{ once: false, backfill: false }])
  })

  it('does nothing when a watch of another terminal holds the lock', async () => {
    const { deps, sessions, observer } = harness({ holder: 4242 })

    expect(await appWatch(deps).start(observer)).toEqual({ status: 'elsewhere', pid: 4242 })
    expect(sessions).toEqual([])
  })

  it('throws what kept the watch from starting', async () => {
    const missing = harness({ fail: new UsageError('Add watch: to the user config.') })
    const taken = harness({
      fail: new WatchRunningError('Another phada watch is running (PID 9).'),
    })

    await expect(appWatch(missing.deps).start(missing.observer)).rejects.toThrow('watch:')
    await expect(appWatch(taken.deps).start(taken.observer)).rejects.toThrow('PID 9')
  })

  it('passes on the events, the warnings and the progress of each job', async () => {
    const { deps, sessions, events, progress, observer } = harness()
    await appWatch(deps).start(observer)
    const [session] = sessions
    if (session === undefined) throw new Error('the watch did not start')

    session.listeners.event({ kind: 'started', job: JOB })
    session.listeners.warning('could not save the run in the history (disk full).')
    const sinks = session.listeners.progress(JOB)
    sinks.review({ kind: 'aiStarted', provider: 'claude', run: 'review' })
    sinks.reviewAndPublish({ kind: 'publishing' })

    expect(events).toEqual([
      { kind: 'started', job: JOB },
      { kind: 'warning', message: 'could not save the run in the history (disk full).' },
    ])
    expect(progress).toEqual([
      { job: 7, event: 'aiStarted' },
      { job: 7, event: 'publishing' },
    ])
  })

  it('stops after the current review and aborts through the handle', async () => {
    const { deps, sessions, observer } = harness()
    const started = await appWatch(deps).start(observer)
    if (started.status !== 'started') throw new Error('the watch did not start')
    const [session] = sessions

    started.control.stop()
    started.control.abort()

    expect(session?.stops).toBe(1)
    expect(session?.aborts).toBe(1)
    expect(await started.control.done).toEqual({ reason: 'aborted' })
  })

  it('aborts a running watch on close and waits for it to end', async () => {
    const { deps, sessions, observer } = harness()
    const watch = appWatch(deps)
    await watch.start(observer)

    await watch.close()

    expect(sessions[0]?.aborts).toBe(1)
  })

  it('aborts on close a watch still starting, once it started', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps, sessions, observer } = harness({ startWatch: () => gate })
    const watch = appWatch(deps)
    const starting = watch.start(observer)

    const closing = watch.close()
    await new Promise((done) => setImmediate(done))
    release()
    await closing

    expect((await starting).status).toBe('started')
    expect(sessions[0]?.aborts).toBe(1)
  })

  it('leaves a watch that already ended alone on close', async () => {
    const { deps, sessions, observer } = harness()
    const watch = appWatch(deps)
    const started = await watch.start(observer)
    sessions[0]?.end({ reason: 'stopped' })
    if (started.status === 'started') await started.control.done

    await watch.close()

    expect(sessions[0]?.aborts).toBe(0)
  })

  it("kills on abort only the children the watch started, never another run's", async () => {
    let watchChild: Promise<string> = Promise.resolve('none')
    const { deps, observer } = harness({
      startWatch: async () => {
        await Promise.resolve()
        watchChild = runCommand(...LONG_CHILD, { detached: true }).then(
          () => 'ended',
          () => 'killed',
        )
      },
    })
    const review = childScope()
    const reviewChild = review.run(() =>
      runCommand(...LONG_CHILD, { detached: true }).then(
        () => 'ended',
        () => 'killed',
      ),
    )
    const started = await appWatch(deps).start(observer)
    if (started.status !== 'started') throw new Error('the watch did not start')
    await new Promise((done) => setTimeout(done, 200))

    started.control.abort()

    expect(await watchChild).toBe('killed')
    const settled = await Promise.race([
      reviewChild,
      new Promise((done) => setTimeout(() => done('running'), 300)),
    ])
    review.kill()
    expect(settled).toBe('running')
  })
})
