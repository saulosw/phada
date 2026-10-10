import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { InvalidReviewReportError } from './errors.js'
import { parseReviewReport } from './parse-report.js'

function parseError(text: string): InvalidReviewReportError {
  try {
    parseReviewReport(text)
  } catch (error) {
    if (error instanceof InvalidReviewReportError) return error
    throw error
  }
  throw new Error('expected parseReviewReport() to throw InvalidReviewReportError')
}

describe('parseReviewReport', () => {
  it('reads a plain JSON report', () => {
    expect(parseReviewReport(reviewReportJson())).toEqual({
      summary: 'Adds a spend endpoint.',
      files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint' }],
      findings: [findingFixture()],
      invalid: 0,
    })
  })

  it('reads a report inside a json code fence with text around it', () => {
    const text = `Here is the review:\n\`\`\`json\n${reviewReportJson()}\n\`\`\`\nThanks!`

    expect(parseReviewReport(text).findings).toEqual([findingFixture()])
  })

  it('skips a JSON object that is not a report and takes the report after it', () => {
    const text = `{"note": "thinking"}\n${reviewReportJson({ summary: 'The real one.' })}`

    expect(parseReviewReport(text).summary).toBe('The real one.')
  })

  it('is not confused by braces and quotes inside strings', () => {
    const finding = findingFixture({ title: 'Stray } in a string', why: 'Says \\"hi\\" first' })

    const parsed = parseReviewReport(
      `prefix { not json ${reviewReportJson({ findings: [finding] })}`,
    )

    expect(parsed.findings).toEqual([finding])
  })

  it('drops findings with the wrong shape and counts them', () => {
    const { line: _line, ...withoutLine } = findingFixture()
    const findings = [
      findingFixture(),
      withoutLine,
      findingFixture({ severity: 'P3' as never }),
      findingFixture({ confidence: 120 }),
      findingFixture({ confidence: 85.5 }),
      findingFixture({ line: 0 }),
      'not an object',
    ]

    const parsed = parseReviewReport(reviewReportJson({ findings }))

    expect(parsed.findings).toEqual([findingFixture()])
    expect(parsed.invalid).toBe(6)
  })

  it('keeps a finding or a file entry that carries an extra key, without the key', () => {
    const parsed = parseReviewReport(
      reviewReportJson({
        files: [{ path: 'a.ts', change: 'x', kind: 'source' }],
        findings: [{ ...findingFixture(), category: 'security' }],
      }),
    )

    expect(parsed.files).toEqual([{ path: 'a.ts', change: 'x' }])
    expect(parsed.findings).toEqual([findingFixture()])
    expect(parsed.invalid).toBe(0)
  })

  it('drops a finding without a fix key but keeps a null fix', () => {
    const { fix: _fix, ...withoutFix } = findingFixture()

    const parsed = parseReviewReport(
      reviewReportJson({ findings: [withoutFix, findingFixture({ fix: null })] }),
    )

    expect(parsed.findings).toEqual([findingFixture({ fix: null })])
    expect(parsed.invalid).toBe(1)
  })

  it('reads the rule and the text sources of a finding', () => {
    const text = reviewReportJson({
      findings: [
        {
          ...findingFixture(),
          rule: ' orm-only ',
          sources: ['docs/a.md', 3, ' ', 'src/shop.ts:2'],
        },
      ],
    })

    expect(parseReviewReport(text).findings).toEqual([
      findingFixture({ rule: 'orm-only', sources: ['docs/a.md', 'src/shop.ts:2'] }),
    ])
  })

  it('leaves out a null rule and empty sources, and accepts findings without them', () => {
    const text = reviewReportJson({
      findings: [
        { ...findingFixture(), rule: null, sources: [] },
        findingFixture({ title: 'old' }),
      ],
    })

    expect(parseReviewReport(text).findings).toEqual([
      findingFixture(),
      findingFixture({ title: 'old' }),
    ])
  })

  it('ignores file entries with the wrong shape', () => {
    const files = [{ path: 'a.ts', change: 'x' }, { path: '', change: 'y' }, { path: 'b.ts' }]

    expect(parseReviewReport(reviewReportJson({ files })).files).toEqual([
      { path: 'a.ts', change: 'x' },
    ])
  })

  it('accepts an empty findings array', () => {
    expect(parseReviewReport(reviewReportJson({ findings: [] }))).toMatchObject({
      findings: [],
      invalid: 0,
    })
  })

  it.each([
    ['', 'no JSON object in the answer'],
    ['No significant problems found.', 'no JSON object in the answer'],
    ['{"summary": "x", "files": [', 'no JSON object in the answer'],
    ['{"summary": "x", "files": []}', 'missing summary, files or findings'],
    ['{"summary": 1, "files": [], "findings": []}', 'missing summary, files or findings'],
    ['{"summary": "x", "files": [], "findings": {}}', 'missing summary, files or findings'],
  ])('rejects %j as an invalid review', (text, reason) => {
    const error = parseError(text)

    expect(error.message).toBe(`The AI did not return a valid review (${reason}).`)
  })

  it('keeps the start of the answer as a preview', () => {
    const text = `  ${'x'.repeat(600)}`

    expect(parseError(text).preview).toBe('x'.repeat(500))
  })
})
