import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { InvalidReviewReportError } from './errors.js'
import { buildReviewPrompt } from './prompt.js'
import { REVIEW_REPORT_JSON_SCHEMA } from './report-schema.js'
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
  text: reviewReportJson(),
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
        durationMs: 1234,
        usage: { inputTokens: 3512, outputTokens: 420 },
        summary: 'Adds a spend endpoint.',
        files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
        findings: [findingFixture()],
        score: { value: 3, reason: '1 P1 finding (shop.ts:1)' },
        dropped: { invalid: 0, belowFloor: 0, belowCut: 0 },
      },
    })
  })

  it('asks the provider for the review report schema', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

    await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(provider.prompts[0]?.outputSchema).toBe(REVIEW_REPORT_JSON_SCHEMA)
  })

  it('shows only confident findings, sorted, and counts what it dropped', async () => {
    const text = reviewReportJson({
      findings: [
        findingFixture({ severity: 'P2', confidence: 95, line: 9 }),
        findingFixture({ severity: 'P0', confidence: 80, line: 2 }),
        findingFixture({ confidence: 60 }),
        findingFixture({ confidence: 10 }),
        { severity: 'P1' },
      ],
    })
    const provider = new FakeProvider(() => Promise.resolve({ text, durationMs: 1 }))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
      findings: [
        findingFixture({ severity: 'P0', confidence: 80, line: 2 }),
        findingFixture({ severity: 'P2', confidence: 95, line: 9 }),
      ],
      score: { value: 1, reason: '1 P0 finding (shop.ts:2)' },
      dropped: { invalid: 1, belowFloor: 1, belowCut: 1 },
    })
  })

  it('rejects an answer that is not a review report', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({ text: 'No significant problems found.', durationMs: 1 }),
    )

    await expect(
      runReview({ pullRequest: pullRequestFixture() }, { provider }),
    ).rejects.toBeInstanceOf(InvalidReviewReportError)
  })

  it('leaves model and usage out when the provider does not report them', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({ text: reviewReportJson({ findings: [] }), durationMs: 5 }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toEqual({
      target: expect.any(Object),
      providerId: 'fake-cli',
      durationMs: 5,
      summary: 'Adds a spend endpoint.',
      files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 0 }],
      findings: [],
      score: { value: 5, reason: 'no problems found' },
      dropped: { invalid: 0, belowFloor: 0, belowCut: 0 },
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
      durationMs: 1234,
      usage: { inputTokens: 3512, outputTokens: 420 },
      summary: 'Adds a spend endpoint.',
      files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
      findings: [findingFixture()],
      score: { value: 3, reason: '1 P1 finding (shop.ts:1)' },
      dropped: { invalid: 0, belowFloor: 0, belowCut: 0 },
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
