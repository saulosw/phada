import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { InvalidReviewReportError } from './errors.js'
import { buildReviewPrompt } from './prompt.js'
import { REVIEW_REPORT_JSON_SCHEMA } from './report-schema.js'
import { DEFAULT_MIN_CONFIDENCE, runReview } from './run-review.js'
import { buildVerifyPrompt } from './verify-prompt.js'

class FakeProvider implements ReviewProvider {
  readonly id = 'fake-cli'
  readonly prompts: ReviewPrompt[] = []

  constructor(private readonly answer: () => Promise<ReviewOutput>) {}

  review(prompt: ReviewPrompt): Promise<ReviewOutput> {
    this.prompts.push(prompt)
    return this.answer()
  }
}

function inTurn(...outputs: ReviewOutput[]): () => Promise<ReviewOutput> {
  let next = 0
  return () => {
    const output = outputs[next++]
    return output === undefined
      ? Promise.reject(new Error('no more answers'))
      : Promise.resolve(output)
  }
}

function nonces(...values: string[]): () => string {
  let next = 0
  return () => values[next++] ?? 'ffffffffffff'
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
        worthChecking: [],
        worthCheckingOmitted: 0,
        minConfidence: 60,
        score: { value: 3, reason: '1 P1 finding (shop.ts:1)' },
        dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
      },
    })
  })

  it('asks the provider for the review report schema', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

    await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(provider.prompts[0]?.outputSchema).toBe(REVIEW_REPORT_JSON_SCHEMA)
  })

  it('shows findings from confidence 60 by default, sorted, and counts what it dropped', async () => {
    const text = reviewReportJson({
      findings: [
        findingFixture({ severity: 'P2', confidence: 95, line: 9 }),
        findingFixture({ severity: 'P0', confidence: 60, line: 2 }),
        findingFixture({ confidence: 59 }),
        findingFixture({ confidence: 10 }),
        { severity: 'P1' },
      ],
    })
    const provider = new FakeProvider(() => Promise.resolve({ text, durationMs: 1 }))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
      findings: [
        findingFixture({ severity: 'P0', confidence: 60, line: 2 }),
        findingFixture({ severity: 'P2', confidence: 95, line: 9 }),
      ],
      worthChecking: [findingFixture({ confidence: 59 })],
      worthCheckingOmitted: 0,
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      score: { value: 1, reason: '1 P0 finding (shop.ts:2)' },
      dropped: { invalid: 1, belowFloor: 1, outsideDiff: 0, duplicate: 0 },
    })
  })

  it('applies the confidence cut of the request and returns it', async () => {
    const text = reviewReportJson({
      findings: [findingFixture({ confidence: 90, line: 2 }), findingFixture({ confidence: 60 })],
    })
    const provider = new FakeProvider(() => Promise.resolve({ text, durationMs: 1 }))

    const outcome = await runReview(
      { pullRequest: pullRequestFixture(), minConfidence: 95 },
      { provider },
    )

    expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
      findings: [],
      worthChecking: [
        findingFixture({ confidence: 90, line: 2 }),
        findingFixture({ confidence: 60 }),
      ],
      minConfidence: 95,
      score: { value: 5, reason: 'no problems found' },
      files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 0 }],
    })
  })

  it.each([49, 101, 75.5])(
    'rejects a confidence cut of %d without calling the provider',
    async (minConfidence) => {
      const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

      await expect(
        runReview({ pullRequest: pullRequestFixture(), minConfidence }, { provider }),
      ).rejects.toThrow(
        new RangeError(`Invalid minConfidence ${minConfidence}: use an integer from 50 to 100.`),
      )
      expect(provider.prompts).toHaveLength(0)
    },
  )

  it('drops findings outside the diff and repeated findings, and counts them', async () => {
    const text = reviewReportJson({
      findings: [
        findingFixture({ line: 2 }),
        findingFixture({ line: 2, confidence: 85 }),
        findingFixture({ line: 40 }),
        findingFixture({ file: 'src/other.ts' }),
      ],
    })
    const provider = new FakeProvider(() => Promise.resolve({ text, durationMs: 1 }))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
      findings: [findingFixture({ line: 2 })],
      dropped: { invalid: 0, belowFloor: 0, outsideDiff: 2, duplicate: 1 },
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
      worthChecking: [],
      worthCheckingOmitted: 0,
      minConfidence: 60,
      score: { value: 5, reason: 'no problems found' },
      dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
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
      worthChecking: [],
      worthCheckingOmitted: 0,
      minConfidence: 60,
      score: { value: 3, reason: '1 P1 finding (shop.ts:1)' },
      dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
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

  it('does not verify the findings unless asked', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(provider.prompts).toHaveLength(1)
    expect(outcome.status === 'reviewed' && outcome.result).not.toHaveProperty('verification')
  })

  describe('with verify', () => {
    const findingA = findingFixture({ severity: 'P2', confidence: 55, line: 3, title: 'a' })
    const findingB = findingFixture({ severity: 'P0', confidence: 90, line: 5, title: 'b' })
    const findingC = findingFixture({ severity: 'P1', confidence: 58, line: 6, title: 'c' })
    const report: ReviewOutput = {
      text: reviewReportJson({
        findings: [
          findingA,
          findingB,
          findingC,
          findingFixture({ line: 40, title: 'outside' }),
          findingFixture({ confidence: 10, title: 'low' }),
        ],
      }),
      durationMs: 1000,
      model: 'claude-fake-1',
      usage: { inputTokens: 3000, outputTokens: 400 },
    }
    const verification: ReviewOutput = {
      text: verificationJson([
        verdictFixture({ id: 1, severity: 'P1', confidence: 85 }),
        verdictFixture({ id: 2, verdict: 'rejected', reason: 'Handled at line 4.' }),
        verdictFixture({ id: 3, severity: 'P2', confidence: 40 }),
      ]),
      durationMs: 600,
      usage: { inputTokens: 3200, outputTokens: 150 },
    }
    const request = { pullRequest: pullRequestFixture(), verify: true }

    it('checks the candidates in a second call and scores only what survived', async () => {
      const provider = new FakeProvider(inTurn(report, verification))

      const outcome = await runReview(request, {
        provider,
        createNonce: nonces('aaaaaaaaaaaa', 'bbbbbbbbbbbb'),
      })

      expect(provider.prompts).toEqual([
        buildReviewPrompt(request, 'aaaaaaaaaaaa'),
        buildVerifyPrompt(request, [findingA, findingB, findingC], 'bbbbbbbbbbbb'),
      ])
      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        model: 'claude-fake-1',
        durationMs: 1600,
        usage: { inputTokens: 6200, outputTokens: 550 },
        files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
        findings: [{ ...findingA, severity: 'P1', confidence: 85, reason: 'The diff shows it.' }],
        worthChecking: [],
        score: { value: 3, reason: '1 P1 finding (shop.ts:3)' },
        dropped: { invalid: 0, belowFloor: 2, outsideDiff: 1, duplicate: 0, rejected: 1 },
        verification: {
          candidates: 3,
          confirmed: 2,
          unverified: 0,
          rejected: [{ ...findingB, reason: 'Handled at line 4.' }],
          durationMs: 600,
          usage: { inputTokens: 3200, outputTokens: 150 },
        },
      })
    })

    it('lifts a confirmed finding above the cut and keeps an unchecked one as it was', async () => {
      const lifted: ReviewOutput = {
        text: verificationJson([verdictFixture({ id: 3, severity: 'P1', confidence: 90 })]),
        durationMs: 1,
      }
      const provider = new FakeProvider(inTurn(report, lifted))

      const outcome = await runReview(request, { provider })

      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        findings: [findingB, { ...findingC, confidence: 90 }],
        worthChecking: [findingA],
        dropped: { rejected: 0 },
        verification: { candidates: 3, confirmed: 1, unverified: 2, rejected: [] },
      })
    })

    it('asks for candidates from confidence 25 and drops the ones still below 50', async () => {
      const unsure = findingFixture({ severity: 'P1', confidence: 30, line: 7, title: 'd' })
      const rare = findingFixture({ severity: 'P2', confidence: 20, line: 8, title: 'e' })
      const generous = { ...report, text: reviewReportJson({ findings: [unsure, rare] }) }
      const kept: ReviewOutput = {
        text: verificationJson([verdictFixture({ id: 1, confidence: 45 })]),
        durationMs: 1,
      }
      const provider = new FakeProvider(inTurn(generous, kept))

      const outcome = await runReview(request, { provider })

      expect(provider.prompts[0]?.instructions).toContain('rated 25 or higher')
      expect(provider.prompts[1]?.data).toContain('"title":"d"')
      expect(provider.prompts[1]?.data).not.toContain('"title":"e"')
      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        findings: [],
        worthChecking: [],
        dropped: { belowFloor: 2, rejected: 0 },
        verification: { candidates: 1, confirmed: 1 },
      })
    })

    it('sends the verification to the verifier when there is one', async () => {
      const provider = new FakeProvider(inTurn(report))
      const verifier = new FakeProvider(inTurn(verification))

      await runReview(request, { provider, verifier })

      expect(provider.prompts).toHaveLength(1)
      expect(verifier.prompts).toHaveLength(1)
      expect(verifier.prompts[0]?.data).toContain('<<<PHADA_FINDINGS_')
    })

    it('makes no second call when no candidate is left to check', async () => {
      const empty = {
        ...report,
        text: reviewReportJson({ findings: [findingFixture({ line: 40 })] }),
      }
      const provider = new FakeProvider(inTurn(empty))

      const outcome = await runReview(request, { provider })

      expect(provider.prompts).toHaveLength(1)
      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        durationMs: 1000,
        usage: { inputTokens: 3000, outputTokens: 400 },
        verification: { candidates: 0, confirmed: 0, unverified: 0, rejected: [], durationMs: 0 },
      })
    })

    it.each([
      ['the review', { inputTokens: 3200, outputTokens: 150 }, 'review'],
      ['the verification', { inputTokens: 3000, outputTokens: 400 }, 'verification'],
    ])('reports the usage of the call that has it when %s has none', async (_case, usage, bare) => {
      const { usage: _first, ...reportWithout } = report
      const { usage: _second, ...verificationWithout } = verification
      const provider = new FakeProvider(
        bare === 'review'
          ? inTurn(reportWithout, verification)
          : inTurn(report, verificationWithout),
      )

      const outcome = await runReview(request, { provider })

      expect(outcome.status === 'reviewed' && outcome.result.usage).toEqual(usage)
    })

    it('leaves usage out when neither call reports it', async () => {
      const { usage: _first, ...reportWithout } = report
      const { usage: _second, ...verificationWithout } = verification
      const provider = new FakeProvider(inTurn(reportWithout, verificationWithout))

      const outcome = await runReview(request, { provider })

      expect(outcome.status === 'reviewed' && outcome.result).not.toHaveProperty('usage')
    })

    it('fails the review when the verification is not valid', async () => {
      const provider = new FakeProvider(inTurn(report, { text: 'Looks right.', durationMs: 1 }))

      await expect(runReview(request, { provider })).rejects.toBeInstanceOf(
        InvalidReviewReportError,
      )
    })
  })

  it('lets a provider failure propagate unchanged', async () => {
    const failure = new Error('provider exploded')
    const provider = new FakeProvider(() => Promise.reject(failure))

    await expect(runReview({ pullRequest: pullRequestFixture() }, { provider })).rejects.toBe(
      failure,
    )
  })
})
