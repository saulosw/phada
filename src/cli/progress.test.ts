import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { withProgress } from './progress.js'
import type { TextOutput } from './progress.js'

const PROMPT: ReviewPrompt = { instructions: 'rules', data: 'diff', outputSchema: {} }
const OUTPUT: ReviewOutput = { text: 'ok', durationMs: 1 }
const CLEAR_LINE = '\r\u001B[2K'

function recorder(isTTY: boolean): TextOutput & { written: string[] } {
  const written: string[] = []
  return { isTTY, written, write: (text: string) => written.push(text) }
}

function deferredProvider() {
  let settle: { resolve: (output: ReviewOutput) => void; reject: (error: unknown) => void } = {
    resolve: () => {},
    reject: () => {},
  }
  const prompts: ReviewPrompt[] = []
  const provider: ReviewProvider = {
    id: 'fake-cli',
    review: (prompt) => {
      prompts.push(prompt)
      return new Promise((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
  }
  return { provider, prompts, settle: () => settle }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('withProgress', () => {
  it('keeps the provider id and forwards the prompt and the output', async () => {
    const { provider, prompts, settle } = deferredProvider()
    const wrapped = withProgress(provider, recorder(false))

    const review = wrapped.review(PROMPT)
    settle().resolve(OUTPUT)

    expect(wrapped.id).toBe('fake-cli')
    await expect(review).resolves.toBe(OUTPUT)
    expect(prompts).toEqual([PROMPT])
  })

  it('updates one line with the elapsed time on a terminal, then clears it', async () => {
    const { provider, settle } = deferredProvider()
    const output = recorder(true)

    const review = withProgress(provider, output).review(PROMPT)
    await vi.advanceTimersByTimeAsync(75_000)
    settle().resolve(OUTPUT)
    await review

    expect(output.written[0]).toBe(`${CLEAR_LINE}Reviewing with fake-cli… 0s`)
    expect(output.written[1]).toBe(`${CLEAR_LINE}Reviewing with fake-cli… 1s`)
    expect(output.written).toContain(`${CLEAR_LINE}Reviewing with fake-cli… 1m15s`)
    expect(output.written.at(-1)).toBe(CLEAR_LINE)
    expect(output.written.join('')).not.toContain('\n')
  })

  it('writes a single line when the output is not a terminal', async () => {
    const { provider, settle } = deferredProvider()
    const output = recorder(false)

    const review = withProgress(provider, output).review(PROMPT)
    await vi.advanceTimersByTimeAsync(30_000)
    settle().resolve(OUTPUT)
    await review

    expect(output.written).toEqual(['Reviewing with fake-cli… (this can take a few minutes)\n'])
  })

  it('names the action it is waiting for', async () => {
    const { provider, settle } = deferredProvider()
    const output = recorder(false)

    const review = withProgress(provider, output, 'Verifying findings').review(PROMPT)
    settle().resolve(OUTPUT)
    await review

    expect(output.written).toEqual([
      'Verifying findings with fake-cli… (this can take a few minutes)\n',
    ])
  })

  it('stops the timer and clears the line when the provider fails', async () => {
    const { provider, settle } = deferredProvider()
    const output = recorder(true)
    const failure = new Error('boom')

    const review = withProgress(provider, output).review(PROMPT)
    settle().reject(failure)
    await expect(review).rejects.toBe(failure)
    const writes = output.written.length
    await vi.advanceTimersByTimeAsync(5_000)

    expect(output.written.at(-1)).toBe(CLEAR_LINE)
    expect(output.written).toHaveLength(writes)
    expect(vi.getTimerCount()).toBe(0)
  })
})
