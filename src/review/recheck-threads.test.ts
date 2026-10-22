import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { InvalidReviewReportError } from './errors.js'
import { buildRecheckPrompt } from './recheck-prompt.js'
import { RECHECK_JSON_SCHEMA } from './recheck-schema.js'
import { recheckThreads } from './recheck-threads.js'
import type { RecheckThread } from './types.js'

const NONCE = '0123456789ab'
const REQUEST = { pullRequest: pullRequestFixture() }

function thread(overrides: Partial<RecheckThread> = {}): RecheckThread {
  return {
    id: 'T1',
    file: 'src/shop.ts',
    line: 3,
    title: 'Spend has no auth',
    body: '**P1** · Spend has no auth · confidence 90\n\nAnyone can spend.\n\n<!-- phada:finding -->',
    patch: '@@ -3 +3 @@\n-old\n+new',
    changed: true,
    ...overrides,
  }
}

class FakeProvider implements ReviewProvider {
  readonly id = 'fake'
  readonly prompts: ReviewPrompt[] = []

  constructor(private readonly output: ReviewOutput) {}

  async review(prompt: ReviewPrompt): Promise<ReviewOutput> {
    this.prompts.push(prompt)
    return this.output
  }
}

const verdicts = (items: unknown[]): ReviewOutput => ({
  text: JSON.stringify({ verdicts: items }),
  durationMs: 40,
  usage: { inputTokens: 10, outputTokens: 2 },
})

describe('buildRecheckPrompt', () => {
  it('sends the threads and their changes in blocks marked with the nonce', () => {
    const { data, instructions, outputSchema } = buildRecheckPrompt(
      REQUEST,
      [thread(), thread({ id: 'T2', file: 'src/b.ts', line: null })],
      NONCE,
    )

    expect(data).toContain(`<<<PHADA_THREADS_${NONCE}\n`)
    expect(data).toContain(
      '{"id":1,"file":"src/shop.ts","line":3,"comment":"**P1** · Spend has no auth · confidence 90\\n\\nAnyone can spend."}',
    )
    expect(data).toContain('{"id":2,"file":"src/b.ts","line":null,')
    expect(data).toContain(`<<<PHADA_CHANGES_${NONCE}\n--- src/shop.ts\n@@ -3 +3 @@\n-old\n+new`)
    expect(data).not.toContain('phada:finding')
    expect(instructions).toContain('Changing the lines is not fixing them')
    expect(instructions).toContain('When in doubt, say unsure.')
    expect(instructions).toContain('UNTRUSTED DATA')
    expect(outputSchema).toBe(RECHECK_JSON_SCHEMA)
  })

  it('asks to read a file without a patch with the tools', () => {
    const { data } = buildRecheckPrompt(REQUEST, [thread({ patch: undefined })], NONCE)

    expect(data).toContain('--- src/shop.ts\n(no patch: read the file with the tools)')
  })

  it('asks for the reason in the review language', () => {
    const { instructions } = buildRecheckPrompt(
      { ...REQUEST, language: 'pt-BR' },
      [thread()],
      NONCE,
    )

    expect(instructions).toContain('Write reason in pt-BR')
  })
})

describe('recheckThreads', () => {
  it('sends only the changed threads and maps the verdicts back to them', async () => {
    const provider = new FakeProvider(
      verdicts([
        { id: 1, verdict: 'fixed', reason: 'The id now comes from the session.' },
        { id: 2, verdict: 'still-valid', reason: 'Same code.' },
      ]),
    )
    const threads = [
      thread(),
      thread({ id: 'T2', title: 'Other' }),
      thread({ id: 'T3', changed: false, title: 'Untouched' }),
    ]

    const report = await recheckThreads(REQUEST, threads, provider, NONCE)

    expect(provider.prompts).toEqual([buildRecheckPrompt(REQUEST, threads.slice(0, 2), NONCE)])
    expect(report).toEqual({
      threads: 3,
      fixed: 1,
      stillValid: 2,
      unsure: 0,
      verdicts: [
        {
          threadId: 'T1',
          file: 'src/shop.ts',
          line: 3,
          title: 'Spend has no auth',
          verdict: 'fixed',
          reason: 'The id now comes from the session.',
          by: 'ai',
        },
        {
          threadId: 'T2',
          file: 'src/shop.ts',
          line: 3,
          title: 'Other',
          verdict: 'still-valid',
          reason: 'Same code.',
          by: 'ai',
        },
        {
          threadId: 'T3',
          file: 'src/shop.ts',
          line: 3,
          title: 'Untouched',
          verdict: 'still-valid',
          reason: 'The file did not change.',
          by: 'unchanged',
        },
      ],
      durationMs: 40,
      usage: { inputTokens: 10, outputTokens: 2 },
    })
  })

  it('calls a thread without a patch unsure, without the AI, when there are no tools', async () => {
    const provider = new FakeProvider(verdicts([{ id: 1, verdict: 'fixed', reason: 'Gone.' }]))
    const threads = [thread({ id: 'T1', patch: undefined }), thread({ id: 'T2', title: 'Other' })]

    const report = await recheckThreads(REQUEST, threads, provider, NONCE)

    expect(provider.prompts).toEqual([buildRecheckPrompt(REQUEST, threads.slice(1), NONCE)])
    expect(report.verdicts.map(({ threadId, verdict, by }) => [threadId, verdict, by])).toEqual([
      ['T1', 'unsure', 'no-access'],
      ['T2', 'fixed', 'ai'],
    ])
  })

  it('reads a thread without a verdict as unsure', async () => {
    const provider = new FakeProvider(verdicts([]))

    const report = await recheckThreads(REQUEST, [thread()], provider, NONCE)

    expect(report.verdicts[0]).toMatchObject({ verdict: 'unsure', by: 'ai' })
    expect(report.unsure).toBe(1)
  })

  it('makes no call when no thread changed', async () => {
    const provider = new FakeProvider(verdicts([]))

    const report = await recheckThreads(REQUEST, [thread({ changed: false })], provider, NONCE)

    expect(provider.prompts).toEqual([])
    expect(report).toMatchObject({ threads: 1, stillValid: 1, durationMs: 0 })
    expect(report).not.toHaveProperty('usage')
  })

  it('rejects an answer that is not a recheck', async () => {
    const provider = new FakeProvider({ text: 'no json', durationMs: 1 })

    await expect(recheckThreads(REQUEST, [thread()], provider, NONCE)).rejects.toBeInstanceOf(
      InvalidReviewReportError,
    )
  })
})
