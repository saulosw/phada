import type { CiWaited, CiWaiting } from '../app/wait-for-ci.js'
import { checkNames } from './format-ci.js'
import { CLEAR_LINE, TICK_MS } from './progress.js'
import type { TextOutput } from './progress.js'
import { formatElapsed, formatLocalTime } from './units.js'

export interface CiWaitProgress {
  waiting(wait: CiWaiting): void
  waited(wait: CiWaited): void
}

export function ciWaitProgress(
  output: TextOutput,
  clock: () => Date = () => new Date(),
): CiWaitProgress {
  if (output.isTTY !== true) {
    let started = false
    return {
      waiting: (wait) => {
        if (started) return
        started = true
        output.write(
          `Waiting for CI until ${formatLocalTime(new Date(wait.deadline)).slice(-5)} (${pendingText(wait.pending)})…\n`,
        )
      },
      waited: (wait) => output.write(`${waitedText(wait)}\n`),
    }
  }

  let current: CiWaiting | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const render = () => {
    if (current === undefined) return
    const elapsed = formatElapsed(clock().getTime() - Date.parse(current.startedAt))
    output.write(`${CLEAR_LINE}Waiting for CI… ${elapsed}, ${pendingText(current.pending)}`)
  }
  return {
    waiting: (wait) => {
      current = wait
      render()
      if (timer !== undefined) return
      timer = setInterval(render, TICK_MS)
      timer.unref()
    },
    waited: (wait) => {
      clearInterval(timer)
      timer = undefined
      current = undefined
      output.write(CLEAR_LINE)
      output.write(`${waitedText(wait)}\n`)
    },
  }
}

function pendingText(pending: readonly string[]): string {
  return pending.length === 0
    ? 'no checks yet'
    : `${pending.length} pending: ${checkNames(pending)}`
}

function waitedText({ waitedMs, state, pending }: CiWaited): string {
  const waited = `Waited ${formatElapsed(waitedMs)} for CI.`
  if (state === 'none') return `${waited} No checks appeared.`
  return pending.length === 0 ? waited : `${waited} Still pending: ${checkNames(pending)}.`
}
