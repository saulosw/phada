import { describe, expect, it } from 'vitest'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { reportProgress } from './review-progress.js'
import type { ReviewProgress } from './review-progress.js'

const PROMPT: ReviewPrompt = { instructions: 'rules', data: 'diff', outputSchema: {} }
const OUTPUT: ReviewOutput = { text: 'ok', durationMs: 1 }

function recorder() {
  const events: ReviewProgress[] = []
  return { events, sink: (event: ReviewProgress) => events.push(event) }
}

describe('reportProgress', () => {
  it('reports when the AI starts and finishes a pass, forwarding the prompt and the output', async () => {
    const prompts: ReviewPrompt[] = []
    const provider: ReviewProvider = {
      id: 'fake-cli',
      review: async (prompt) => {
        prompts.push(prompt)
        return OUTPUT
      },
    }
    const { events, sink } = recorder()

    const wrapped = reportProgress(provider, 'verify', sink)

    expect(wrapped.id).toBe('fake-cli')
    await expect(wrapped.review(PROMPT)).resolves.toBe(OUTPUT)
    expect(prompts).toEqual([PROMPT])
    expect(events).toEqual([
      { kind: 'aiStarted', provider: 'fake-cli', run: 'verify' },
      { kind: 'aiFinished', provider: 'fake-cli', run: 'verify', answered: true },
    ])
  })

  it('reports the end of a pass the provider failed', async () => {
    const failure = new Error('boom')
    const provider: ReviewProvider = { id: 'fake-cli', review: () => Promise.reject(failure) }
    const { events, sink } = recorder()

    await expect(reportProgress(provider, 'recheck', sink).review(PROMPT)).rejects.toBe(failure)

    expect(events).toEqual([
      { kind: 'aiStarted', provider: 'fake-cli', run: 'recheck' },
      { kind: 'aiFinished', provider: 'fake-cli', run: 'recheck', answered: false },
    ])
  })

  it('reports a native skill run as its own kind of run', async () => {
    const provider: ReviewProvider = {
      id: 'claude-cli',
      review: () => Promise.reject(new Error('unused')),
      runSkill: async () => ({ text: 'ok', durationMs: 1, blocked: [] }),
    }
    const { events, sink } = recorder()

    const run = await reportProgress(provider, 'review', sink).runSkill?.({} as never)

    expect(run?.text).toBe('ok')
    expect(events).toEqual([
      { kind: 'aiStarted', provider: 'claude-cli', run: 'skill' },
      { kind: 'aiFinished', provider: 'claude-cli', run: 'skill', answered: true },
    ])
  })

  it('does not run skills when the provider does not', () => {
    const provider: ReviewProvider = { id: 'ollama', review: () => Promise.reject(new Error('x')) }

    expect(reportProgress(provider, 'review', recorder().sink).runSkill).toBeUndefined()
  })
})
