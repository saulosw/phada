import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewContextFixture } from '../../test/support/review-context.js'
import type { ReviewPrompt } from '../providers/types.js'
import { buildReviewPrompt } from './prompt.js'
import type { DiffImpact, RelatedSummary, ReviewRequest } from './types.js'
import { buildVerifyPrompt } from './verify-prompt.js'

const NONCE = '0123456789ab'
const CANDIDATES = [
  findingFixture({ severity: 'P0', confidence: 95, line: 3, title: 'spend has no auth' }),
]
const RELATED: RelatedSummary[] = [
  { repo: 'acme/web', commit: '1a2b3c4d5e6f', state: 'consumers', count: 2, graph: true },
]
const IMPACT: DiffImpact = {
  symbols: [
    {
      kind: 'function',
      name: 'getUser',
      path: 'src/users.ts',
      startLine: 1,
      endLine: 3,
      exported: true,
      callers: 1,
      files: 1,
      sites: [
        {
          path: 'src/api.ts',
          line: 4,
          in: 'handle',
          kind: 'calls',
          how: 'resolved',
          text: 'return getUser(id)',
        },
      ],
      dependencies: [],
    },
  ],
  omittedSymbols: 0,
  callerFiles: 1,
}

const BARE: ReviewRequest = { pullRequest: pullRequestFixture() }
const RICH: ReviewRequest = {
  pullRequest: pullRequestFixture(),
  language: 'pt-BR',
  verify: true,
  context: reviewContextFixture(),
  impact: IMPACT,
  related: RELATED,
}

function digest({ instructions, data, outputSchema }: ReviewPrompt): string {
  return createHash('sha256')
    .update([instructions, data, JSON.stringify(outputSchema)].join('\u0000'))
    .digest('hex')
}

describe('prompts of a pull request without conversation', () => {
  it.each([
    ['bare', BARE, 'd39cf046d8e7c3c722a272fb4bd5a2e840062da31c61b962dfce2cf89c7ff31c'],
    [
      'with context, impact and related repositories',
      RICH,
      '2cbb0a33e7c684905113b3f1ea60d0e5e459cc1c03fb802a83b6324e19177604',
    ],
  ])('keeps the review prompt of 0.8.0 byte for byte (%s)', (_case, request, expected) => {
    expect(digest(buildReviewPrompt(request, NONCE))).toBe(expected)
  })

  it.each([
    ['bare', BARE, 'ad64d9fad33e7bef72885b75100a1b2e84a7cddb2adb5c1d2cafd5be43b1425f'],
    [
      'with context, impact and related repositories',
      RICH,
      '9145318ab6b5050b663757a0bc34b0850039397adaaeff86df59865ed24fbb92',
    ],
  ])('keeps the verify prompt of 0.8.0 byte for byte (%s)', (_case, request, expected) => {
    expect(digest(buildVerifyPrompt(request, CANDIDATES, NONCE))).toBe(expected)
  })
})
