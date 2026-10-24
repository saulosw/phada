import { describe, expect, it } from 'vitest'
import type { IssueComment } from '../github/issue-comments.js'
import { prCommands } from './pr-commands.js'

const BASELINE = '2026-10-23T10:00:00Z'
const comment = (id: number, overrides: Partial<IssueComment> = {}): IssueComment => ({
  id,
  body: '/phada review',
  author: 'alice',
  authorIsBot: false,
  association: 'MEMBER',
  createdAt: `2026-10-23T12:0${id}:00Z`,
  url: `https://github.com/acme/shop/pull/12#issuecomment-${id}`,
  number: 12,
  pullRequest: true,
  ...overrides,
})

describe('prCommands', () => {
  it('turns a /phada review of a trusted author on a pull request into a request', () => {
    expect(prCommands([comment(1)], { baselineAt: BASELINE })).toEqual({
      commands: [
        {
          number: 12,
          commentId: 1,
          url: 'https://github.com/acme/shop/pull/12#issuecomment-1',
          author: 'alice',
        },
      ],
      lastId: 1,
      since: '2026-10-23T12:01:00Z',
    })
  })

  it.each([
    ['an author outside the repository', comment(1, { association: 'CONTRIBUTOR' })],
    ['a bot', comment(1, { authorIsBot: true })],
    ['an issue', comment(1, { pullRequest: false })],
    ['another first line', comment(1, { body: 'please /phada review' })],
    ['a comment before the baseline', comment(1, { createdAt: '2026-10-23T09:00:00Z' })],
  ])('ignores %s', (_case, ignored) => {
    expect(prCommands([ignored], { baselineAt: BASELINE }).commands).toEqual([])
  })

  it('reads the command on the first line, in any case, with text below it', () => {
    const asked = comment(1, { body: '\n  /Phada Review  \nthe fix for the login bug' })
    expect(prCommands([asked], { baselineAt: BASELINE }).commands).toHaveLength(1)
  })

  it('skips the comments it already read and moves its cursor to the newest one', () => {
    expect(
      prCommands([comment(1), comment(2, { body: 'thanks' })], {
        baselineAt: BASELINE,
        lastId: 1,
      }),
    ).toEqual({ commands: [], lastId: 2, since: '2026-10-23T12:02:00Z' })
  })

  it('keeps its cursor when there is nothing new', () => {
    expect(prCommands([comment(1)], { baselineAt: BASELINE, lastId: 1 })).toEqual({
      commands: [],
      lastId: 1,
    })
  })
})
