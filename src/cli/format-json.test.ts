import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { ReviewResult } from '../review/types.js'
import { formatReviewJson } from './format-json.js'

const PULL_REQUEST = {
  repo: 'acme/shop',
  number: 12,
  url: 'https://github.com/acme/shop/pull/12',
  title: 'Let users spend crystals',
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  state: 'open',
  draft: false,
}

const RESULT: ReviewResult = {
  target: { repo: 'acme/shop', number: 12, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
  providerId: 'codex-cli',
  model: 'gpt-6-astra',
  additionalModels: ['gpt-6-mini'],
  durationMs: 16_400,
  usage: { inputTokens: 9700, outputTokens: 417 },
  summary: 'Adds a spend endpoint.',
  files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
  findings: [findingFixture({ severity: 'P0', confidence: 95, line: 3 })],
  worthChecking: [findingFixture({ severity: 'P2', confidence: 60, line: 5, fix: null })],
  worthCheckingOmitted: 2,
  minConfidence: 75,
  score: { value: 1, reason: '1 P0 finding (shop.ts:3)' },
  dropped: { invalid: 0, belowFloor: 1, outsideDiff: 2, duplicate: 0, rejected: 0 },
}

function parse(output: string): unknown {
  return JSON.parse(output)
}

describe('formatReviewJson', () => {
  it('prints the whole review as JSON with a schema version', () => {
    const output = formatReviewJson(pullRequestFixture(), { status: 'reviewed', result: RESULT })

    expect(output.endsWith('}\n')).toBe(true)
    expect(parse(output)).toEqual({
      schemaVersion: 1,
      status: 'reviewed',
      pullRequest: PULL_REQUEST,
      review: {
        score: { value: 1, reason: '1 P0 finding (shop.ts:3)' },
        summary: 'Adds a spend endpoint.',
        files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
        findings: [
          { ...findingFixture({ severity: 'P0', confidence: 95, line: 3 }), reason: null },
        ],
        worthChecking: [
          {
            ...findingFixture({ severity: 'P2', confidence: 60, line: 5, fix: null }),
            reason: null,
          },
        ],
        worthCheckingOmitted: 2,
        minConfidence: 75,
        dropped: { invalid: 0, belowFloor: 1, outsideDiff: 2, duplicate: 0, rejected: 0 },
        verification: null,
        provider: { id: 'codex-cli', model: 'gpt-6-astra', additionalModels: ['gpt-6-mini'] },
        durationMs: 16_400,
        usage: { inputTokens: 9700, outputTokens: 417 },
      },
    })
  })

  it('prints the verification with the rejected findings and why they were rejected', () => {
    const rejected = findingFixture({ severity: 'P1', confidence: 55, line: 8, fix: null })
    const result: ReviewResult = {
      ...RESULT,
      dropped: { ...RESULT.dropped, rejected: 1 },
      verification: {
        candidates: 4,
        confirmed: 2,
        unverified: 1,
        rejected: [{ ...rejected, reason: 'Handled at line 4.' }],
        durationMs: 9000,
        usage: { inputTokens: 9800, outputTokens: 200 },
      },
    }

    const output = parse(formatReviewJson(pullRequestFixture(), { status: 'reviewed', result }))

    expect(output).toMatchObject({
      review: {
        dropped: { rejected: 1 },
        verification: {
          candidates: 4,
          confirmed: 2,
          unverified: 1,
          rejected: [{ ...rejected, reason: 'Handled at line 4.' }],
          durationMs: 9000,
          usage: { inputTokens: 9800, outputTokens: 200 },
        },
      },
    })
  })

  it('prints why the verifier confirmed a finding, and null for one it did not check', () => {
    const confirmed = findingFixture({ confidence: 85, reason: 'Line 3 trusts the request body.' })
    const result: ReviewResult = { ...RESULT, findings: [confirmed] }

    const output = parse(formatReviewJson(pullRequestFixture(), { status: 'reviewed', result }))

    expect(output).toMatchObject({
      review: {
        findings: [{ ...confirmed, reason: 'Line 3 trusts the request body.' }],
        worthChecking: [{ reason: null }],
      },
    })
  })

  it('prints a null usage for a verification that did not report it', () => {
    const verification = { candidates: 0, confirmed: 0, unverified: 0, rejected: [], durationMs: 0 }

    const output = parse(
      formatReviewJson(pullRequestFixture(), {
        status: 'reviewed',
        result: { ...RESULT, verification },
      }),
    )

    expect(output).toMatchObject({ review: { verification: { ...verification, usage: null } } })
  })

  it('keeps the same shape when the provider reports no model or usage', () => {
    const { model: _model, additionalModels: _models, usage: _usage, ...result } = RESULT

    const output = parse(formatReviewJson(pullRequestFixture(), { status: 'reviewed', result }))

    expect(output).toMatchObject({
      review: { provider: { id: 'codex-cli', model: null, additionalModels: [] }, usage: null },
    })
  })

  it('prints a skipped review with the pull request', () => {
    const output = formatReviewJson(pullRequestFixture({ diff: '' }), {
      status: 'skipped',
      reason: 'empty-diff',
    })

    expect(parse(output)).toEqual({
      schemaVersion: 1,
      status: 'skipped',
      reason: 'empty-diff',
      pullRequest: PULL_REQUEST,
    })
  })

  it('keeps text from the AI as it is, with control characters escaped by JSON', () => {
    const why = '## Findings\n```\n\u001B[2Jgone'
    const result = { ...RESULT, findings: [findingFixture({ why })] }

    const output = formatReviewJson(pullRequestFixture(), { status: 'reviewed', result })

    expect(output).not.toMatch(/[\u0000-\u0009\u000B-\u001F]/)
    expect(parse(output)).toMatchObject({ review: { findings: [{ why }] } })
  })

  it('leaves out fields that are not part of the format', () => {
    const finding = { ...findingFixture(), category: 'security' }
    const result = {
      ...RESULT,
      findings: [finding],
      verification: {
        candidates: 1,
        confirmed: 0,
        unverified: 0,
        rejected: [{ ...finding, reason: 'Speculative.', debug: 'internal' }],
        durationMs: 1,
      },
      usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3 },
    }

    const output = formatReviewJson(pullRequestFixture(), { status: 'reviewed', result })

    expect(output).not.toContain('category')
    expect(output).not.toContain('cachedTokens')
    expect(output).not.toContain('internal')
  })
})
