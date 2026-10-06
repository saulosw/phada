import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import { InvalidReviewReportError } from './errors.js'
import { parseVerification } from './parse-verification.js'
import { buildVerifyPrompt } from './verify-prompt.js'

function parseError(text: string): InvalidReviewReportError {
  try {
    parseVerification(text)
  } catch (error) {
    if (error instanceof InvalidReviewReportError) return error
    throw error
  }
  throw new Error('expected parseVerification() to throw InvalidReviewReportError')
}

describe('parseVerification', () => {
  it('reads the verdicts of a plain JSON verification', () => {
    const verdicts = [verdictFixture(), verdictFixture({ id: 2, verdict: 'rejected' })]

    expect(parseVerification(verificationJson(verdicts))).toEqual(verdicts)
  })

  it('reads a verification inside a code fence with text around it', () => {
    const text = `Checked:\n\`\`\`json\n${verificationJson([verdictFixture()])}\n\`\`\`\nDone.`

    expect(parseVerification(text)).toEqual([verdictFixture()])
  })

  it('skips a JSON object without verdicts and takes the verification after it', () => {
    const text = `{"note": "thinking"}\n${verificationJson([verdictFixture({ id: 3 })])}`

    expect(parseVerification(text)).toEqual([verdictFixture({ id: 3 })])
  })

  it('ignores verdicts with the wrong shape', () => {
    const { reason: _reason, ...withoutReason } = verdictFixture()

    const verdicts = parseVerification(
      verificationJson([
        verdictFixture(),
        withoutReason,
        verdictFixture({ verdict: 'maybe' as never }),
        verdictFixture({ confidence: 120 }),
        verdictFixture({ id: 0 }),
        verdictFixture({ severity: 'P3' as never }),
        'not an object',
      ]),
    )

    expect(verdicts).toEqual([verdictFixture()])
  })

  it('reads an empty list of verdicts', () => {
    expect(parseVerification(verificationJson([]))).toEqual([])
  })

  it.each([
    ['no JSON object', 'Everything looks fine.'],
    ['no verdicts', '{"summary": "A review instead of a verification"}'],
  ])('rejects an answer with %s and keeps its start for --debug', (_case, text) => {
    const error = parseError(text)

    expect(error.message).toBe(
      'The AI did not return a valid review (no verdicts in the verification).',
    )
    expect(error.preview).toBe(text)
  })

  it('does not read the example in the verifier instructions as a verification', () => {
    const { instructions } = buildVerifyPrompt({ pullRequest: pullRequestFixture() }, [], 'x')

    expect(() => parseVerification(instructions)).toThrow(InvalidReviewReportError)
  })
})
