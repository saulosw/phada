import { describe, expect, it } from 'vitest'
import { localPullRequest } from './local-pull-request.js'
import type { LocalChanges } from './local-pull-request.js'

const BASE = '1111111111111111111111111111111111111111'
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
const SYNTHETIC = '9999999999999999999999999999999999999999'

function changes(overrides: Partial<LocalChanges> = {}): LocalChanges {
  return {
    repo: 'acme/shop',
    private: true,
    branch: 'feat/spend',
    baseRef: 'main',
    base: BASE,
    head: HEAD,
    reviewed: HEAD,
    dirty: false,
    messages: [{ sha: HEAD, subject: 'Let users spend crystals', body: '' }],
    stats: { changedFiles: 1, additions: 3, deletions: 0, commits: 1 },
    diff: 'diff --git a/a.ts b/a.ts\n',
    ...overrides,
  }
}

describe('localPullRequest', () => {
  it('takes the title and description of the only commit', () => {
    const pullRequest = localPullRequest(
      changes({
        messages: [{ sha: HEAD, subject: 'Let users spend crystals', body: 'Adds spend().' }],
      }),
    )

    expect(pullRequest).toEqual({
      repo: 'acme/shop',
      number: 0,
      url: '',
      title: 'Let users spend crystals',
      description: 'Let users spend crystals\n\nAdds spend().',
      author: '',
      association: 'OWNER',
      state: 'open',
      draft: false,
      baseRef: 'main',
      baseSha: BASE,
      headRef: 'feat/spend',
      headSha: HEAD,
      fromFork: false,
      private: true,
      stats: { changedFiles: 1, additions: 3, deletions: 0, commits: 1 },
      diff: 'diff --git a/a.ts b/a.ts\n',
    })
  })

  it('names several commits after the branch and lists every message, oldest first', () => {
    const pullRequest = localPullRequest(
      changes({
        messages: [
          {
            sha: 'a'.repeat(40),
            subject: 'Add the shop',
            body: 'First body.\n\nSecond paragraph.',
          },
          { sha: 'b'.repeat(40), subject: 'Fix the total', body: '' },
        ],
      }),
    )

    expect(pullRequest.title).toBe('feat/spend')
    expect(pullRequest.description).toBe(
      'Add the shop\n\nFirst body.\n\nSecond paragraph.\n\nFix the total',
    )
  })

  it('names uncommitted changes with no commit after the branch and says they are included', () => {
    const pullRequest = localPullRequest(
      changes({ messages: [], dirty: true, reviewed: SYNTHETIC }),
    )

    expect(pullRequest.title).toBe('Uncommitted changes on feat/spend')
    expect(pullRequest.description).toBe('This review includes uncommitted changes.')
    expect(pullRequest.headSha).toBe(SYNTHETIC)
  })

  it('adds the uncommitted line after the commit messages', () => {
    const pullRequest = localPullRequest(changes({ dirty: true, reviewed: SYNTHETIC }))

    expect(pullRequest.title).toBe('Let users spend crystals')
    expect(pullRequest.description).toBe(
      'Let users spend crystals\n\nThis review includes uncommitted changes.',
    )
  })

  it('uses the short HEAD sha on a detached HEAD', () => {
    const { branch: _branch, ...detached } = changes({
      messages: [
        { sha: 'a'.repeat(40), subject: 'One', body: '' },
        { sha: 'b'.repeat(40), subject: 'Two', body: '' },
      ],
    })

    const pullRequest = localPullRequest(detached)

    expect(pullRequest.title).toBe('abcdef0')
    expect(pullRequest.headRef).toBe('HEAD')
    expect(
      localPullRequest({ ...detached, messages: [], dirty: true, reviewed: SYNTHETIC }).title,
    ).toBe('Uncommitted changes on abcdef0')
  })
})
