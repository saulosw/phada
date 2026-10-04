import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { ReviewResult } from '../review/types.js'
import { formatPullRequestSummary, formatReview } from './format-review.js'

const RESULT: ReviewResult = {
  target: { repo: 'acme/shop', number: 12, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
  providerId: 'claude-cli',
  model: 'claude-sonnet-5',
  text: '1. [high] src/shop.ts:1 — spend has no auth (confidence 90)\n',
  durationMs: 131_400,
  usage: { inputTokens: 41_234, outputTokens: 13_012 },
}

describe('formatPullRequestSummary', () => {
  it('shows the pull request, the head commit, the change stats and the diff size', () => {
    const pr = pullRequestFixture({ diff: 'x'.repeat(65_741) })

    expect(formatPullRequestSummary(pr)).toBe(
      'acme/shop#12 · a1b2c3d · 2 files · +15 −1 · 64.2 KB diff',
    )
  })

  it('uses the singular for a single changed file', () => {
    const pr = pullRequestFixture({
      stats: { changedFiles: 1, additions: 3, deletions: 0, commits: 1 },
    })

    expect(formatPullRequestSummary(pr)).toContain('· 1 file · +3 −0 ·')
  })

  it('shows small diffs in bytes, counted as UTF-8', () => {
    const pr = pullRequestFixture({ diff: 'ção' })

    expect(formatPullRequestSummary(pr)).toContain('· 5 B diff')
  })
})

describe('formatReview', () => {
  it('prints a header, the review and a footer with provider, model, time and tokens', () => {
    expect(formatReview(pullRequestFixture(), RESULT)).toBe(
      [
        '# Review of acme/shop#12: Let users spend crystals',
        'https://github.com/acme/shop/pull/12 · head a1b2c3d · open',
        '',
        '1. [high] src/shop.ts:1 — spend has no auth (confidence 90)',
        '',
        '---',
        'claude-cli · claude-sonnet-5 · 2m11s · 41.2k in / 13.0k out',
        '',
      ].join('\n'),
    )
  })

  it('marks draft and closed pull requests', () => {
    const output = formatReview(pullRequestFixture({ state: 'closed', draft: true }), RESULT)

    expect(output).toContain('· head a1b2c3d · closed, draft\n')
  })

  it('shows the other models next to the main one when more than one answered', () => {
    const result = { ...RESULT, additionalModels: ['claude-haiku-4-5', 'claude-helper-1'] }

    expect(formatReview(pullRequestFixture(), result)).toContain(
      '\nclaude-cli · claude-sonnet-5 (+ claude-haiku-4-5, claude-helper-1) · 2m11s ·',
    )
  })

  it('leaves the model and the tokens out when the provider did not report them', () => {
    const { model: _model, usage: _usage, ...result } = RESULT

    expect(formatReview(pullRequestFixture(), { ...result, durationMs: 42_149 })).toContain(
      '\n---\nclaude-cli · 42.1s\n',
    )
  })

  it('removes terminal control sequences from the title and the review', () => {
    const pr = pullRequestFixture({ title: 'Fix\u001B[2J\r\nthe shop' })

    const output = formatReview(pr, { ...RESULT, text: 'Looks fine\u001B]0;pwned\u0007' })

    expect(output).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/)
    expect(output).toContain('# Review of acme/shop#12: Fix[2J the shop\n')
    expect(output).toContain('\nLooks fine]0;pwned\n')
  })
})
