import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { InvalidReviewReportError } from './errors.js'
import { applyVerdicts, verifyCandidates } from './verify-findings.js'
import { buildVerifyPrompt } from './verify-prompt.js'

const FIRST = findingFixture({ severity: 'P2', confidence: 55, line: 3, title: 'first' })
const SECOND = findingFixture({ severity: 'P0', confidence: 90, line: 5, title: 'second' })
const THIRD = findingFixture({ severity: 'P1', confidence: 70, line: 6, title: 'third' })

class FakeVerifier implements ReviewProvider {
  readonly id = 'fake-cli'
  readonly prompts: ReviewPrompt[] = []

  constructor(private readonly answer: () => Promise<ReviewOutput>) {}

  review(prompt: ReviewPrompt): Promise<ReviewOutput> {
    this.prompts.push(prompt)
    return this.answer()
  }
}

describe('applyVerdicts', () => {
  it('takes the severity and confidence of a confirmed candidate and keeps the rest', () => {
    const applied = applyVerdicts(
      [FIRST],
      [verdictFixture({ severity: 'P1', confidence: 85, reason: 'Real.' })],
    )

    expect(applied).toEqual({
      findings: [{ ...FIRST, severity: 'P1', confidence: 85 }],
      rejected: [],
      confirmed: 1,
      unverified: 0,
    })
  })

  it('moves a rejected candidate, with the rating of the review, to the rejected list', () => {
    const applied = applyVerdicts(
      [FIRST, SECOND],
      [
        verdictFixture({ id: 1 }),
        verdictFixture({
          id: 2,
          verdict: 'rejected',
          confidence: 10,
          reason: 'Handled at line 4.',
        }),
      ],
    )

    expect(applied.findings).toEqual([{ ...FIRST, severity: 'P1', confidence: 90 }])
    expect(applied.rejected).toEqual([{ ...SECOND, reason: 'Handled at line 4.' }])
    expect(applied).toMatchObject({ confirmed: 1, unverified: 0 })
  })

  it('keeps a candidate without a verdict as the review rated it and counts it', () => {
    const applied = applyVerdicts([FIRST, SECOND, THIRD], [verdictFixture({ id: 2 })])

    expect(applied.findings).toEqual([FIRST, { ...SECOND, severity: 'P1', confidence: 90 }, THIRD])
    expect(applied).toMatchObject({ confirmed: 1, unverified: 2 })
  })

  it('uses the first verdict for a candidate and ignores unknown ids', () => {
    const applied = applyVerdicts(
      [FIRST],
      [
        verdictFixture({ id: 7, verdict: 'rejected' }),
        verdictFixture({ id: 1, confidence: 75 }),
        verdictFixture({ id: 1, verdict: 'rejected' }),
      ],
    )

    expect(applied).toEqual({
      findings: [{ ...FIRST, severity: 'P1', confidence: 75 }],
      rejected: [],
      confirmed: 1,
      unverified: 0,
    })
  })
})

describe('verifyCandidates', () => {
  const request = { pullRequest: pullRequestFixture(), language: 'pt-BR' }

  it('sends the candidates to the verifier in one call and applies its verdicts', async () => {
    const text = verificationJson([
      verdictFixture({ id: 1, confidence: 80 }),
      verdictFixture({ id: 2, verdict: 'rejected', reason: 'Speculative.' }),
    ])
    const verifier = new FakeVerifier(() =>
      Promise.resolve({ text, durationMs: 900, usage: { inputTokens: 100, outputTokens: 20 } }),
    )

    const checked = await verifyCandidates(
      request,
      [FIRST, SECOND, THIRD],
      verifier,
      'abcdefabcdef',
    )

    expect(verifier.prompts).toEqual([
      buildVerifyPrompt(request, [FIRST, SECOND, THIRD], 'abcdefabcdef'),
    ])
    expect(checked).toEqual({
      findings: [{ ...FIRST, severity: 'P1', confidence: 80 }, THIRD],
      verification: {
        candidates: 3,
        confirmed: 1,
        unverified: 1,
        rejected: [{ ...SECOND, reason: 'Speculative.' }],
        durationMs: 900,
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    })
  })

  it('does not call the verifier when there are no candidates', async () => {
    const verifier = new FakeVerifier(() => Promise.reject(new Error('should not be called')))

    const checked = await verifyCandidates(request, [], verifier, 'abcdefabcdef')

    expect(verifier.prompts).toHaveLength(0)
    expect(checked).toEqual({
      findings: [],
      verification: { candidates: 0, confirmed: 0, unverified: 0, rejected: [], durationMs: 0 },
    })
  })

  it('leaves usage out when the verifier does not report it', async () => {
    const verifier = new FakeVerifier(() =>
      Promise.resolve({ text: verificationJson([verdictFixture()]), durationMs: 5 }),
    )

    const { verification } = await verifyCandidates(request, [FIRST], verifier, 'abcdefabcdef')

    expect(verification).not.toHaveProperty('usage')
  })

  it('rejects an answer that is not a verification', async () => {
    const verifier = new FakeVerifier(() =>
      Promise.resolve({ text: 'All findings look right.', durationMs: 5 }),
    )

    await expect(
      verifyCandidates(request, [FIRST], verifier, 'abcdefabcdef'),
    ).rejects.toBeInstanceOf(InvalidReviewReportError)
  })

  it('lets a verifier failure propagate unchanged', async () => {
    const failure = new Error('verifier exploded')
    const verifier = new FakeVerifier(() => Promise.reject(failure))

    await expect(verifyCandidates(request, [FIRST], verifier, 'abcdefabcdef')).rejects.toBe(failure)
  })
})
