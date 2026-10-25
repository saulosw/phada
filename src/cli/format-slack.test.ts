import { describe, expect, it } from 'vitest'
import { DEFAULT_SLACK_EMOJIS } from '../config/watch-settings.js'
import type { ReviewEvent } from './review-event.js'
import { MAX_SLACK_MESSAGE, MAX_SLACK_MESSAGES, slackReplies } from './format-slack.js'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const finding = (n: number, severity = 'P1', why = 'Anyone can spend crystals for any user.') => ({
  severity,
  confidence: 90,
  file: 'src/shop.ts',
  line: n,
  title: `spend has no auth ${n}`,
  why,
})
const event = (overrides: Partial<ReviewEvent> = {}, findings = [finding(3)]): ReviewEvent => ({
  schemaVersion: 1,
  event: 'review.finished',
  job: {
    id: 1,
    repo: 'acme/shop',
    number: 12,
    headSha: SHA,
    url: 'https://github.com/acme/shop/pull/12',
  },
  requests: [],
  verdict: 'blocking',
  ci: null,
  publication: { status: 'published', url: 'https://github.com/acme/shop/pull/12#r1' },
  review: {
    review: {
      summary: 'Adds a spend endpoint.',
      score: { value: 2 },
      findings,
      worthChecking: [finding(9, 'P2')],
    },
  },
  ...overrides,
})

const HEADER =
  ':x: *Blocking findings* · <https://github.com/acme/shop/pull/12|acme/shop#12> at `a1b2c3d` · <https://github.com/acme/shop/pull/12#r1|review on GitHub>'

describe('slackReplies', () => {
  it('answers link with the verdict and the links', () => {
    expect(slackReplies(event(), 'link', DEFAULT_SLACK_EMOJIS)).toEqual([HEADER])
  })

  it('answers summary with the summary, the score and the counts', () => {
    expect(slackReplies(event(), 'summary', DEFAULT_SLACK_EMOJIS)).toEqual([
      `${HEADER}\nAdds a spend endpoint.\nScore 2/5 · 1 finding (1 P1) · 1 worth checking`,
    ])
  })

  it('answers full with every finding and a link to its line in the reviewed commit', () => {
    expect(slackReplies(event(), 'full', DEFAULT_SLACK_EMOJIS)).toEqual([
      [
        `${HEADER}\nAdds a spend endpoint.\nScore 2/5 · 1 finding (1 P1) · 1 worth checking`,
        '',
        `*P1* <https://github.com/acme/shop/blob/${SHA}/src/shop.ts#L3|src/shop.ts:3> spend has no auth 3`,
        'Anyone can spend crystals for any user.',
        '',
        '*Worth checking*',
        `*P2* <https://github.com/acme/shop/blob/${SHA}/src/shop.ts#L9|src/shop.ts:9> spend has no auth 9`,
        'Anyone can spend crystals for any user.',
      ].join('\n'),
    ])
  })

  it('leaves out the GitHub link of a review that was not published', () => {
    const [text] = slackReplies(
      event({ publication: { status: 'not-published' } }),
      'link',
      DEFAULT_SLACK_EMOJIS,
    )
    expect(text).not.toContain('review on GitHub')
  })

  it('splits a long review between findings, and stops at the most messages with what is left', () => {
    const long = 'x'.repeat(900)
    const findings = Array.from({ length: 60 }, (_, n) => finding(n + 1, 'P2', long))
    const replies = slackReplies(
      event({ verdict: 'comments' }, findings),
      'full',
      DEFAULT_SLACK_EMOJIS,
    )

    expect(replies).toHaveLength(MAX_SLACK_MESSAGES)
    for (const reply of replies) expect(reply.length).toBeLessThanOrEqual(MAX_SLACK_MESSAGE)
    expect(replies[1]?.startsWith('*P2* ')).toBe(true)
    expect(replies.at(-1)).toMatch(/\+\d+ more findings: see the review on GitHub\.$/)
    const silent = slackReplies(
      event({ verdict: 'comments', publication: { status: 'not-published' } }, findings),
      'full',
      DEFAULT_SLACK_EMOJIS,
    )
    expect(silent.at(-1)).toMatch(/\n\+\d+ more findings\.$/)
  })

  it('escapes what the AI wrote so it cannot mention or link', () => {
    const [text] = slackReplies(
      event({}, [{ ...finding(3), title: '<!channel> & <https://x|y>' }]),
      'full',
      DEFAULT_SLACK_EMOJIS,
    )
    expect(text).toContain('&lt;!channel&gt; &amp; &lt;https://x|y&gt;')
  })

  it('links the review Phada already published when it skips a commit', () => {
    expect(
      slackReplies(
        event({
          event: 'review.skipped',
          verdict: 'skipped',
          reason: 'already-reviewed',
          publication: { status: 'skipped', url: 'https://github.com/acme/shop/pull/12#r0' },
        }),
        'full',
        DEFAULT_SLACK_EMOJIS,
      ),
    ).toEqual([
      ':eyes: *Skipped* · <https://github.com/acme/shop/pull/12|acme/shop#12> at `a1b2c3d` · <https://github.com/acme/shop/pull/12#r0|review on GitHub>\nThis commit was already reviewed.',
    ])
  })

  it('says why a review failed', () => {
    expect(
      slackReplies(
        event({
          event: 'review.failed',
          verdict: 'failed',
          error: 'GitHub 502',
          publication: null,
        }),
        'full',
        DEFAULT_SLACK_EMOJIS,
      ),
    ).toEqual([
      ':warning: *Review failed* · <https://github.com/acme/shop/pull/12|acme/shop#12> at `a1b2c3d`\nGitHub 502',
    ])
  })

  it('says why a review was skipped', () => {
    expect(
      slackReplies(
        event({ event: 'review.skipped', verdict: 'skipped', reason: 'closed', publication: null }),
        'summary',
        DEFAULT_SLACK_EMOJIS,
      ),
    ).toEqual([
      ':eyes: *Skipped* · <https://github.com/acme/shop/pull/12|acme/shop#12> at `a1b2c3d`\nThe pull request was closed.',
    ])
  })
})
