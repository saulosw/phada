import { describe, expect, it } from 'vitest'
import { pullRequestLinks } from './pull-links.js'

describe('pullRequestLinks', () => {
  it('reads the pull request links Slack wraps in a message, with or without a label', () => {
    expect(
      pullRequestLinks(
        'can someone look? <https://github.com/acme/shop/pull/12> and <https://github.com/Acme/Web/pull/3|the web one>',
      ),
    ).toEqual([
      { repo: 'acme/shop', number: 12 },
      { repo: 'acme/web', number: 3 },
    ])
  })

  it('reads a link to a page of the pull request and a bare link', () => {
    expect(
      pullRequestLinks(
        'https://github.com/acme/shop/pull/12/files and <https://github.com/acme/shop/pull/13#discussion_r1>',
      ),
    ).toEqual([
      { repo: 'acme/shop', number: 12 },
      { repo: 'acme/shop', number: 13 },
    ])
  })

  it('reads each pull request once and at most five', () => {
    const many = [1, 1, 2, 3, 4, 5, 6, 7]
      .map((n) => `<https://github.com/acme/shop/pull/${n}>`)
      .join(' ')
    expect(pullRequestLinks(many).map(({ number }) => number)).toEqual([1, 2, 3, 4, 5])
  })

  it('ignores other links', () => {
    expect(
      pullRequestLinks(
        '<https://github.com/acme/shop/issues/4> <https://evil.example/acme/shop/pull/1> https://github.com/acme/shop/pulls',
      ),
    ).toEqual([])
  })
})
