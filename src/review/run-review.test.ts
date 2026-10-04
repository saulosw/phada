import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { buildReviewPrompt } from './prompt.js'
import { runReview } from './run-review.js'

class FakeProvider implements ReviewProvider {
  readonly id = 'fake-cli'
  readonly prompts: ReviewPrompt[] = []

  constructor(private readonly answer: () => Promise<ReviewOutput>) {}

  review(prompt: ReviewPrompt): Promise<ReviewOutput> {
    this.prompts.push(prompt)
    return this.answer()
  }
}

const OUTPUT: ReviewOutput = {
  text: '1. [high] src/shop.ts:1 — spend has no auth (confidence 90)',
  durationMs: 1234,
  model: 'claude-fake-1',
  usage: { inputTokens: 3512, outputTokens: 420 },
}

describe('runReview', () => {
  it('sends the prompt to the provider and returns the review with its target', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))
    const request = { pullRequest: pullRequestFixture(), language: 'pt-BR' }

    const outcome = await runReview(request, { provider, createNonce: () => 'abcdefabcdef' })

    expect(provider.prompts).toEqual([buildReviewPrompt(request, 'abcdefabcdef')])
    expect(outcome).toEqual({
      status: 'reviewed',
      result: {
        target: {
          repo: 'acme/shop',
          number: 12,
          headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        },
        providerId: 'fake-cli',
        model: 'claude-fake-1',
        text: OUTPUT.text,
        durationMs: 1234,
        usage: { inputTokens: 3512, outputTokens: 420 },
      },
    })
  })

  it('leaves model and usage out when the provider does not report them', async () => {
    const provider = new FakeProvider(() => Promise.resolve({ text: 'ok', durationMs: 5 }))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toEqual({
      target: expect.any(Object),
      providerId: 'fake-cli',
      text: 'ok',
      durationMs: 5,
    })
  })

  it('keeps its own identity fields when the provider output carries extra keys', async () => {
    const output = {
      ...OUTPUT,
      providerId: 'impostor-cli',
      target: { repo: 'evil/repo', number: 1, headSha: 'deadbeef' },
      raw: { secret: 'internal' },
    }
    const provider = new FakeProvider(() => Promise.resolve(output))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toEqual({
      target: {
        repo: 'acme/shop',
        number: 12,
        headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      },
      providerId: 'fake-cli',
      model: 'claude-fake-1',
      text: OUTPUT.text,
      durationMs: 1234,
      usage: { inputTokens: 3512, outputTokens: 420 },
    })
  })

  it('keeps the additional models reported by the provider', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({ ...OUTPUT, additionalModels: ['claude-helper-1'] }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result.additionalModels).toEqual([
      'claude-helper-1',
    ])
  })

  it('uses a fresh 12-character hex nonce for each review', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))
    const request = { pullRequest: pullRequestFixture() }

    await runReview(request, { provider })
    await runReview(request, { provider })

    const nonces = provider.prompts.map(({ data }) => /<<<PHADA_DIFF_([0-9a-f]+)\n/.exec(data)?.[1])
    expect(nonces[0]).toMatch(/^[0-9a-f]{12}$/)
    expect(nonces[1]).toMatch(/^[0-9a-f]{12}$/)
    expect(nonces[0]).not.toBe(nonces[1])
  })

  it.each(['', '  \n\t\n'])(
    'skips a pull request whose diff is %j without calling the provider',
    async (diff) => {
      const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

      const outcome = await runReview({ pullRequest: pullRequestFixture({ diff }) }, { provider })

      expect(outcome).toEqual({ status: 'skipped', reason: 'empty-diff' })
      expect(provider.prompts).toHaveLength(0)
    },
  )

  it('lets a provider failure propagate unchanged', async () => {
    const failure = new Error('provider exploded')
    const provider = new FakeProvider(() => Promise.reject(failure))

    await expect(runReview({ pullRequest: pullRequestFixture() }, { provider })).rejects.toBe(
      failure,
    )
  })
})
