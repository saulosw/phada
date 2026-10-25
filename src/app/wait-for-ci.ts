import { ciSummary } from '../publish/ci-state.js'
import type { CiSummary } from '../publish/types.js'
import { ciGate } from '../watch/ci-gate.js'
import { readCheckEntries } from './read-ci.js'
import type { CiReaders, Warn } from './read-ci.js'

export interface WaitClock {
  now(): string
  sleep(ms: number): Promise<void>
}

export interface CiWaiting {
  startedAt: string
  deadline: string
  pending: string[]
}

export interface CiWaited {
  waitedMs: number
  state: CiSummary['state']
  pending: string[]
}

export interface CiWaitEvents {
  warning: Warn
  ciWaiting?(wait: CiWaiting): void
  ciWaited?(wait: CiWaited): void
}

export interface CiWaitInput {
  sha: string
  checks: readonly string[] | undefined
  waitMs: number
  since: string
}

export async function waitForCi(
  input: CiWaitInput,
  readers: CiReaders,
  clock: WaitClock,
  events: CiWaitEvents,
): Promise<void> {
  let waiting: { startedAt: string; summary: CiSummary } | undefined
  const waited = (now: string, summary: CiSummary) => {
    if (waiting === undefined) return
    events.ciWaited?.({
      waitedMs: Date.parse(now) - Date.parse(waiting.startedAt),
      state: summary.state,
      pending: [...summary.pending],
    })
  }
  for (;;) {
    const warnings: string[] = []
    const entries = await readCheckEntries(readers, input.sha, input.checks, (message) =>
      warnings.push(message),
    )
    const now = clock.now()
    if (warnings.length > 0) {
      if (waiting !== undefined) waited(now, waiting.summary)
      events.warning(`${warnings.join('; ')}; reviewing without waiting for CI`)
      return
    }
    const summary = ciSummary(entries)
    const gate = ciGate({
      ci: summary,
      waitMs: input.waitMs,
      onFailure: 'review',
      seenAt: input.since,
      now,
    })
    if (gate.action !== 'wait') {
      waited(now, summary)
      return
    }
    waiting = { startedAt: waiting?.startedAt ?? now, summary }
    events.ciWaiting?.({
      startedAt: waiting.startedAt,
      deadline: gate.deadline,
      pending: gate.pending,
    })
    await clock.sleep(Math.max(0, Date.parse(gate.until) - Date.parse(now)))
  }
}
