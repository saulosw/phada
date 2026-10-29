import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewContextFixture } from '../../test/support/review-context.js'
import type { ReviewPrompt } from '../providers/types.js'
import { buildReviewPrompt } from './prompt.js'
import type { CiCheck, ConversationItem, ReviewRequest } from './types.js'
import { buildVerifyPrompt } from './verify-prompt.js'

const NONCE = '0123456789ab'
const CANDIDATES = [
  findingFixture({ severity: 'P0', confidence: 95, line: 3, title: 'spend has no auth' }),
]
const BARE: ReviewRequest = { pullRequest: pullRequestFixture() }
const RICH: ReviewRequest = {
  pullRequest: pullRequestFixture(),
  verify: true,
  context: reviewContextFixture(),
}
const CONVERSATION: ConversationItem[] = [
  { kind: 'comment', at: '2026-10-01T09:00:00Z', author: 'alice', role: 'author', body: 'Hi' },
]
const CI: CiCheck[] = [
  {
    name: 'test',
    state: 'failing',
    conclusion: 'failure',
    title: 'Tests failed',
    annotations: ['src/shop.ts:3 failure: expected 3 to be 2'],
    log: '##[group]Run npm test\nFAIL src/shop.test.ts\n##[error]Process completed with exit code 1.',
  },
  { name: 'e2e', state: 'pending' },
  { name: 'build', state: 'passing' },
]

function digest({ instructions, data, outputSchema }: ReviewPrompt): string {
  return createHash('sha256')
    .update([instructions, data, JSON.stringify(outputSchema)].join('\u0000'))
    .digest('hex')
}

function blockOf(data: string, name: string): string {
  const start = data.indexOf(`<<<${name}_${NONCE}\n`)
  const end = data.indexOf(`\n${name}_${NONCE}>>>`)
  return start === -1 || end === -1 ? '' : data.slice(start + name.length + NONCE.length + 5, end)
}

describe('prompts of a pull request without checks', () => {
  it('keep the review prompt byte for byte', () => {
    expect(digest(buildReviewPrompt({ ...BARE, ci: [] }, NONCE))).toBe(
      'ad211432c66d9212c92bdb5882c601fef28426642e6c82bee5e81875aeffd34e',
    )
  })

  it('keep the verify prompt of 0.8.0 byte for byte', () => {
    expect(digest(buildVerifyPrompt({ ...BARE, ci: [] }, CANDIDATES, NONCE))).toBe(
      'ad64d9fad33e7bef72885b75100a1b2e84a7cddb2adb5c1d2cafd5be43b1425f',
    )
  })
})

describe.each([
  ['review', (request: ReviewRequest) => buildReviewPrompt(request, NONCE)],
  ['verify', (request: ReviewRequest) => buildVerifyPrompt(request, CANDIDATES, NONCE)],
])('the %s prompt with the checks of the head', (_prompt, build) => {
  it('puts one JSON object per check in a block after the conversation and before the diff', () => {
    const { data } = build({ ...RICH, conversation: CONVERSATION, ci: CI })

    const at = (name: string) => data.indexOf(`<<<${name}_${NONCE}`)
    expect(at('PHADA_DOCS')).toBeLessThan(at('PHADA_CONVERSATION'))
    expect(at('PHADA_CONVERSATION')).toBeLessThan(at('PHADA_CI'))
    expect(at('PHADA_CI')).toBeLessThan(at('PHADA_DIFF'))
    const lines = blockOf(data, 'PHADA_CI').split('\n')
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(CI)
  })

  it('explains the block only when there are checks', () => {
    const { instructions } = build({ ...BARE, ci: CI })

    expect(instructions).toContain('The PHADA_CI block')
    expect(instructions).toContain('UNTRUSTED DATA')
    expect(build({ ...BARE, ci: [] }).instructions).not.toContain('PHADA_CI')
  })
})

describe('CI rules', () => {
  it('asks the reviewer to anchor only a failure the diff causes, with the check as source', () => {
    const { instructions } = buildReviewPrompt({ ...BARE, ci: CI }, NONCE)

    expect(instructions).toContain('fails because of this diff')
    expect(instructions).toContain('numbered diff line that causes')
    expect(instructions).toContain('"ci:<name>" in sources')
    expect(instructions).toContain('Never report a failure that is unrelated to the diff')
    expect(instructions).toContain('flaky')
    expect(instructions).toContain('billing')
  })

  it('asks the verifier to reject a check failure the diff does not cause', () => {
    const { instructions } = buildVerifyPrompt({ ...BARE, ci: CI }, CANDIDATES, NONCE)

    expect(instructions).toContain('cites a check ("ci:<name>")')
    expect(instructions).toContain('the failure is unrelated to the\ndiff')
  })
})
