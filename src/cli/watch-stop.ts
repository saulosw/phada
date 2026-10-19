import type { JobRecord } from '../store/history-store.js'

export const ABORTED_EXIT_CODE = 130

export interface StopControl {
  readonly signal: AbortSignal
  readonly aborted: Promise<number>
  stopRequested(): boolean
  abortedTwice(): boolean
  track(job: JobRecord | undefined): void
}

export interface StopDeps {
  onSignal(handler: () => void): void
  write(text: string): void
  killChildren(): void
  putBack(job: JobRecord): void
  close(): void
}

export function createStopControl(deps: StopDeps): StopControl {
  const controller = new AbortController()
  let signals = 0
  let current: JobRecord | undefined
  let finish: (code: number) => void = () => undefined
  const aborted = new Promise<number>((resolve) => {
    finish = resolve
  })
  deps.onSignal(() => {
    signals += 1
    if (signals === 1) {
      deps.write(
        current === undefined
          ? 'Stopping…\n'
          : 'Stopping after the current review (Ctrl-C again to abort).\n',
      )
      controller.abort()
      return
    }
    deps.killChildren()
    if (current !== undefined) deps.putBack(current)
    deps.write('Aborted.\n')
    deps.close()
    finish(ABORTED_EXIT_CODE)
  })
  return {
    signal: controller.signal,
    aborted,
    stopRequested: () => signals > 0,
    abortedTwice: () => signals > 1,
    track: (job) => {
      current = job
    },
  }
}
