import { describe, expect, it } from 'vitest'
import { InvalidPullRequestRefError } from './errors.js'
import { formatPullRequestRef, parsePullRequestRef } from './pull-request-ref.js'

describe('parsePullRequestRef', () => {
  it.each([
    ['saulosw/phada#12', { owner: 'saulosw', repo: 'phada', number: 12 }],
    ['my-org/my.repo_v2#7', { owner: 'my-org', repo: 'my.repo_v2', number: 7 }],
    ['  saulosw/phada#12  ', { owner: 'saulosw', repo: 'phada', number: 12 }],
    ['https://github.com/saulosw/phada/pull/12', { owner: 'saulosw', repo: 'phada', number: 12 }],
    [
      'https://www.github.com/saulosw/phada/pull/12',
      { owner: 'saulosw', repo: 'phada', number: 12 },
    ],
    ['https://github.com/saulosw/phada/pull/12/', { owner: 'saulosw', repo: 'phada', number: 12 }],
    [
      'https://github.com/saulosw/phada/pull/12/files',
      { owner: 'saulosw', repo: 'phada', number: 12 },
    ],
    [
      'https://github.com/saulosw/phada/pull/12?w=1',
      { owner: 'saulosw', repo: 'phada', number: 12 },
    ],
    [
      'https://github.com/saulosw/phada/pull/12#discussion_r1',
      { owner: 'saulosw', repo: 'phada', number: 12 },
    ],
  ])('parses %j', (input, expected) => {
    expect(parsePullRequestRef(input)).toEqual(expected)
  })

  it.each([
    'saulosw/phada',
    'saulosw/phada#0',
    'saulosw/phada#01',
    'saulosw/phada#-1',
    'saulosw/phada#x',
    'saulosw/phada#99999999999999999999',
    '',
    'phada#12',
    'xsaulosw/phada#12junk',
    'saulosw/phada#12 extra',
    'prefix saulosw/phada#12',
    '../phada#12',
    'saulosw/..#12',
    './phada#12',
    'https://gitlab.com/saulosw/phada/pull/12',
    'https://github.com/saulosw/phada/issues/12',
    'http://github.com/saulosw/phada/pull/12',
    'https://github.com/saulosw/phada/pull/12abc',
  ])('rejects %j with a helpful error', (input) => {
    let caught: unknown
    try {
      parsePullRequestRef(input)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(InvalidPullRequestRefError)
    const error = caught as InvalidPullRequestRefError
    expect(error.name).toBe('InvalidPullRequestRefError')
    expect(error.input).toBe(input)
    expect(error.message).toBe(
      `Invalid pull request reference "${input}". ` +
        'Expected "owner/repo#123" or "https://github.com/owner/repo/pull/123".',
    )
  })
})

describe('formatPullRequestRef', () => {
  it('formats as owner/repo#number', () => {
    expect(formatPullRequestRef({ owner: 'saulosw', repo: 'phada', number: 12 })).toBe(
      'saulosw/phada#12',
    )
  })
})
