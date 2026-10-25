import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ciWaitProgress } from './ci-wait-progress.js'
import type { TextOutput } from './progress.js'

const CLEAR_LINE = '\r\u001B[2K'
const STARTED_AT = '2026-10-18T12:00:00.000Z'
const DEADLINE = '2026-10-18T12:15:00.000Z'

function recorder(isTTY: boolean): TextOutput & { written: string[] } {
  const written: string[] = []
  return { isTTY, written, write: (text: string) => written.push(text) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(STARTED_AT))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ciWaitProgress', () => {
  it('updates one line with the time waited and the pending checks on a terminal', async () => {
    const output = recorder(true)
    const progress = ciWaitProgress(output)

    progress.waiting({ startedAt: STARTED_AT, deadline: DEADLINE, pending: ['test', 'build'] })
    await vi.advanceTimersByTimeAsync(180_000)
    progress.waiting({ startedAt: STARTED_AT, deadline: DEADLINE, pending: ['build'] })
    await vi.advanceTimersByTimeAsync(12_000)
    progress.waited({ waitedMs: 192_000, state: 'passing', pending: [] })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(output.written[0]).toBe(`${CLEAR_LINE}Waiting for CI… 0s, 2 pending: test, build`)
    expect(output.written).toContain(`${CLEAR_LINE}Waiting for CI… 2m59s, 2 pending: test, build`)
    expect(output.written).toContain(`${CLEAR_LINE}Waiting for CI… 3m12s, 1 pending: build`)
    expect(output.written.slice(-2)).toEqual([CLEAR_LINE, 'Waited 3m12s for CI.\n'])
  })

  it('writes one line when the wait starts and one when it ends off a terminal', async () => {
    const output = recorder(false)
    const progress = ciWaitProgress(output)

    progress.waiting({ startedAt: STARTED_AT, deadline: DEADLINE, pending: ['test'] })
    await vi.advanceTimersByTimeAsync(60_000)
    progress.waiting({ startedAt: STARTED_AT, deadline: DEADLINE, pending: ['test'] })
    progress.waited({ waitedMs: 900_000, state: 'pending', pending: ['test'] })

    expect(output.written).toHaveLength(2)
    expect(output.written[0]).toMatch(/^Waiting for CI until \d\d:\d\d \(1 pending: test\)…\n$/)
    expect(output.written[1]).toBe('Waited 15m00s for CI. Still pending: test.\n')
  })
})
