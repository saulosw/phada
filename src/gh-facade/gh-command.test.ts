import { describe, expect, it } from 'vitest'
import { filesToRead, parseGhCommand } from './gh-command.js'

const parse = (line: string, files: Record<string, string> = {}, stdin?: string) =>
  parseGhCommand(line.split(' '), { files, ...(stdin === undefined ? {} : { stdin }) })

describe('parseGhCommand', () => {
  it('reads pr view with json fields and jq', () => {
    expect(parse('pr view 12 --json title,files --jq .title')).toEqual({
      kind: 'pr-view',
      target: '12',
      json: ['title', 'files'],
      jq: '.title',
      comments: false,
    })
  })

  it('reads a pull request URL and --repo', () => {
    expect(parse('pr view https://github.com/acme/shop/pull/12 -R acme/shop --comments')).toEqual({
      kind: 'pr-view',
      target: 'https://github.com/acme/shop/pull/12',
      repo: 'acme/shop',
      comments: true,
    })
  })

  it('reads pr diff --name-only', () => {
    expect(parse('pr diff --name-only')).toEqual({ kind: 'pr-diff', nameOnly: true })
  })

  it('reads a pr comment body from a flag or a file', () => {
    expect(parse('pr comment 12 --body x')).toEqual({ kind: 'pr-comment', target: '12', body: 'x' })
    expect(parse('pr comment -F body.md', { 'body.md': 'From file.' })).toEqual({
      kind: 'pr-comment',
      body: 'From file.',
    })
    expect(parse('pr comment --body-file -', {}, 'From stdin.')).toEqual({
      kind: 'pr-comment',
      body: 'From stdin.',
    })
  })

  it('reads a pr review with its event', () => {
    expect(parse('pr review --request-changes -b x')).toEqual({
      kind: 'pr-review',
      event: 'request-changes',
      body: 'x',
    })
  })

  it('reads gh api with fields and the method', () => {
    expect(
      parse(
        'api repos/{owner}/{repo}/pulls/12/comments -X POST -f body=Fix -f path=a.ts -F line=3',
      ),
    ).toEqual({
      kind: 'api',
      method: 'POST',
      path: 'repos/{owner}/{repo}/pulls/12/comments',
      fields: { body: 'Fix', path: 'a.ts', line: 3 },
      paginate: false,
    })
  })

  it('posts with fields and no method, and gets without them', () => {
    expect(parse('api repos/o/r/issues/12/comments -f body=x')).toMatchObject({ method: 'POST' })
    expect(parse('api repos/o/r/pulls/12 --paginate --jq .title')).toMatchObject({
      method: 'GET',
      paginate: true,
      jq: '.title',
    })
  })

  it('reads an api body from --input', () => {
    expect(parse('api repos/o/r/pulls/12/reviews --input -', {}, '{"body":"x"}')).toMatchObject({
      method: 'POST',
      input: { body: 'x' },
    })
  })

  it('reads nested review comments given as fields', () => {
    expect(
      parse(
        'api repos/o/r/pulls/12/reviews -f body=All -f comments[][path]=a.ts -F comments[][line]=3 -f comments[][body]=x -f comments[][path]=b.ts -F comments[][line]=4 -f comments[][body]=y',
      ),
    ).toMatchObject({
      fields: {
        body: 'All',
        comments: [
          { path: 'a.ts', line: 3, body: 'x' },
          { path: 'b.ts', line: 4, body: 'y' },
        ],
      },
    })
  })

  it('reads search with the query words', () => {
    expect(parse('search prs fix the cart --repo acme/shop --json number')).toEqual({
      kind: 'search',
      type: 'prs',
      query: 'fix the cart',
      repo: 'acme/shop',
      json: ['number'],
    })
  })

  it.each([
    ['issue view 7 --comments', { kind: 'issue-view', target: '7', comments: true }],
    ['issue list -s all -L 5', { kind: 'issue-list', state: 'all', limit: 5 }],
    ['pr list --search spend', { kind: 'pr-list', search: 'spend' }],
    ['repo view --json name', { kind: 'repo-view', json: ['name'] }],
    ['auth status', { kind: 'auth-status' }],
  ])('reads %s', (line, expected) => {
    expect(parse(line)).toEqual(expected)
  })

  it.each([
    ['run list', 'run list'],
    ['pr checkout 12', 'pr checkout'],
    ['pr view --web', 'pr view --web'],
    ['pr view --bogus', 'pr view --bogus'],
  ])('marks %s as unsupported', (line, sub) => {
    expect(parse(line)).toEqual({ kind: 'unsupported', sub })
  })
})

describe('filesToRead', () => {
  it('lists the files a command reads, never stdin', () => {
    expect(filesToRead(['pr', 'comment', '-F', 'body.md'])).toEqual(['body.md'])
    expect(filesToRead(['pr', 'review', '--body-file=r.md'])).toEqual(['r.md'])
    expect(filesToRead(['api', 'x', '--input', 'in.json', '-F', 'body=@note.md'])).toEqual([
      'in.json',
      'note.md',
    ])
    expect(filesToRead(['pr', 'comment', '-F', '-'])).toEqual([])
    expect(filesToRead(['pr', 'view'])).toEqual([])
  })
})
