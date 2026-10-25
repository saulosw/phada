import { describe, expect, it } from 'vitest'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import type {
  PublishedReview,
  PullComment,
  ReviewThread,
  ThreadComment,
} from '../github/pull-request-reviews.js'
import { buildConversation } from './conversation.js'
import { FINDING_MARKER, resolvedMarker, reviewMarker } from './markers.js'

const VIEWER = 'phada-owner'
const AUTHOR = 'alice'
const SHA = 'a'.repeat(40)

function comment(overrides: Partial<PullComment> = {}): PullComment {
  return {
    id: 'IC1',
    author: 'bob',
    bot: false,
    association: 'MEMBER',
    createdAt: '2026-10-01T10:00:00Z',
    body: 'Looks fine.',
    ...overrides,
  }
}

function review(overrides: Partial<PublishedReview> = {}): PublishedReview {
  return {
    id: 'R1',
    author: 'bob',
    body: 'Please split this.',
    commitSha: SHA,
    state: 'commented',
    createdAt: '2026-10-01T11:00:00Z',
    association: 'MEMBER',
    bot: false,
    ...overrides,
  }
}

function reply(overrides: Partial<ThreadComment> = {}): ThreadComment {
  return {
    id: 'C2',
    author: AUTHOR,
    body: 'Fixed.',
    bot: false,
    createdAt: '2026-10-01T13:00:00Z',
    association: 'CONTRIBUTOR',
    ...overrides,
  }
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  const first = overrides.body ?? 'This can be null.'
  return reviewThread({
    id: 'T1',
    path: 'src/app.ts',
    line: 12,
    author: 'bob',
    body: first,
    commentId: 'C1',
    createdAt: '2026-10-01T12:00:00Z',
    association: 'MEMBER',
    bot: false,
    comments: 1,
    replies: [reply({ id: 'C1', author: overrides.author ?? 'bob', body: first })],
    ...overrides,
  })
}

function build(
  state: {
    reviews?: PublishedReview[]
    threads?: ReviewThread[]
  } = {},
  comments: PullComment[] = [],
) {
  return buildConversation({
    state: reviewState({ viewer: VIEWER, ...state }),
    comments,
    author: AUTHOR,
  })
}

describe('buildConversation', () => {
  it('lists comments, reviews and threads oldest first with what each one is', () => {
    const answered = thread({
      isResolved: true,
      isOutdated: true,
      comments: 2,
      replies: [
        reply({ id: 'C1', author: 'bob', body: 'This can be null.' }),
        reply({ id: 'C2', body: 'It cannot, see the guard.' }),
      ],
    })

    const { items } = build(
      { reviews: [review({ createdAt: '2026-10-01T11:00:00Z' })], threads: [answered] },
      [
        comment({ createdAt: '2026-10-01T14:00:00Z', body: 'Merging after CI.' }),
        comment({ id: 'IC0', createdAt: '2026-10-01T09:00:00Z', body: 'Why a retry?' }),
      ],
    )

    expect(items).toEqual([
      {
        kind: 'comment',
        at: '2026-10-01T09:00:00Z',
        author: 'bob',
        role: 'member',
        body: 'Why a retry?',
      },
      {
        kind: 'review',
        at: '2026-10-01T11:00:00Z',
        author: 'bob',
        role: 'member',
        state: 'commented',
        body: 'Please split this.',
      },
      {
        kind: 'thread',
        at: '2026-10-01T12:00:00Z',
        author: 'bob',
        role: 'member',
        file: 'src/app.ts',
        line: 12,
        resolved: true,
        outdated: true,
        body: 'This can be null.',
        replies: [
          {
            at: '2026-10-01T13:00:00Z',
            author: AUTHOR,
            role: 'author',
            body: 'It cannot, see the guard.',
          },
        ],
      },
      {
        kind: 'comment',
        at: '2026-10-01T14:00:00Z',
        author: 'bob',
        role: 'member',
        body: 'Merging after CI.',
      },
    ])
  })

  it('names the pull request author, bots and the GitHub association of everyone else', () => {
    const { items } = build({}, [
      comment({ author: AUTHOR, association: 'CONTRIBUTOR' }),
      comment({ author: 'lint-app', bot: true, association: 'NONE' }),
      comment({ author: 'o', association: 'OWNER' }),
      comment({ author: 'c', association: 'COLLABORATOR' }),
      comment({ author: 'f', association: 'FIRST_TIME_CONTRIBUTOR' }),
      comment({ author: 'n', association: 'NONE' }),
      comment({ author: 'g', association: 'FIRST_TIMER' }),
      comment({ author: '', association: 'NONE' }),
    ])

    expect(items.map(({ author, role }) => `${author}:${role}`)).toEqual([
      'alice:author',
      'lint-app:bot',
      'o:owner',
      'c:collaborator',
      'f:contributor',
      'n:external',
      'g:contributor',
      ':external',
    ])
  })

  it('keeps an empty review only when it approves or requests changes, and never a pending one', () => {
    const { items } = build({
      reviews: [
        review({ id: 'A', body: '', state: 'approved' }),
        review({ id: 'B', body: '', state: 'changes-requested' }),
        review({ id: 'C', body: '  ', state: 'commented' }),
        review({ id: 'D', body: '', state: 'dismissed' }),
        review({ id: 'E', body: 'Draft note.', state: 'pending' }),
        review({ id: 'F', body: 'Was blocking.', state: 'dismissed' }),
      ],
    })

    expect(items).toEqual([
      expect.objectContaining({ kind: 'review', state: 'approved' }),
      expect.objectContaining({ kind: 'review', state: 'changes-requested' }),
      expect.objectContaining({ kind: 'review', state: 'dismissed', body: 'Was blocking.' }),
    ])
    expect(items[0]).not.toHaveProperty('body')
  })

  it('leaves out the reviews and threads of Phada and keeps what people answered on them', () => {
    const phadaBody = `**P1** · Retry never stops · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`
    const phadaThread = thread({
      id: 'T9',
      author: VIEWER,
      body: phadaBody,
      association: 'OWNER',
      comments: 5,
      replies: [
        reply({ id: 'C1', author: VIEWER, body: phadaBody }),
        reply({ id: 'C3', author: 'lint-app', bot: true, body: 'Linted.' }),
        reply({ id: 'C4', body: 'Not changing this, the retry is bounded upstream.' }),
        reply({ id: 'C5', author: VIEWER, body: `Fixed.\n\n${resolvedMarker(SHA)}` }),
      ],
    })
    const silentPhadaThread = thread({
      id: 'T8',
      author: VIEWER,
      body: phadaBody,
      replies: [reply({ id: 'C1', author: VIEWER, body: phadaBody })],
    })

    const { items } = build(
      {
        reviews: [review({ author: VIEWER, body: reviewMarker({ sha: SHA, findings: 1 }) })],
        threads: [phadaThread, silentPhadaThread],
      },
      [comment({ author: VIEWER, association: 'OWNER', body: 'I will merge this later.' })],
    )

    expect(items).toEqual([
      expect.objectContaining({ kind: 'comment', author: VIEWER, role: 'owner' }),
      {
        kind: 'thread',
        at: '2026-10-01T12:00:00Z',
        author: VIEWER,
        role: 'phada',
        file: 'src/app.ts',
        line: 12,
        resolved: false,
        outdated: false,
        body: 'Retry never stops',
        replies: [
          {
            at: '2026-10-01T13:00:00Z',
            author: AUTHOR,
            role: 'author',
            body: 'Not changing this, the retry is bounded upstream.',
          },
        ],
        omittedReplies: 1,
      },
    ])
  })

  it('counts the replies GitHub did not return', () => {
    const { items } = build({
      threads: [
        thread({
          comments: 30,
          replies: [
            reply({ id: 'C11', body: 'Reply 11.' }),
            reply({ id: 'C12', body: 'Reply 12.' }),
          ],
        }),
      ],
    })

    expect(items[0]).toMatchObject({ omittedReplies: 27 })
    expect(items[0]).toHaveProperty('replies', [
      expect.objectContaining({ body: 'Reply 11.' }),
      expect.objectContaining({ body: 'Reply 12.' }),
    ])
  })

  it('cuts each body at 2 KB and counts the cut ones', () => {
    const long = `${'x'.repeat(3000)}`
    const { items, report } = build(
      {
        threads: [
          thread({
            comments: 2,
            replies: [reply({ id: 'C1', author: 'bob' }), reply({ id: 'C2', body: long })],
          }),
        ],
      },
      [comment({ body: long })],
    )

    const [first, second] = items
    expect(first).toMatchObject({
      body: `${'x'.repeat(2048)}\n[truncated by Phada: 2048 of 3000 bytes]`,
    })
    expect(second).toMatchObject({
      replies: [{ body: `${'x'.repeat(2048)}\n[truncated by Phada: 2048 of 3000 bytes]` }],
    })
    expect(report.truncated).toBe(2)
  })

  it('keeps 16 KB, leaving out resolved threads, then outdated ones, then the oldest', () => {
    const big = 'y'.repeat(2000)
    const at = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00Z`
    const threads = [
      thread({ id: 'resolved-new', createdAt: at(50), isResolved: true, body: big, replies: [] }),
      thread({ id: 'resolved-old', createdAt: at(1), isResolved: true, body: big, replies: [] }),
      thread({ id: 'outdated', createdAt: at(40), isOutdated: true, body: big, replies: [] }),
    ]
    const comments = Array.from({ length: 9 }, (_, index) =>
      comment({ id: `IC${index}`, createdAt: at(10 + index), body: `${index}${big}` }),
    )

    const { items, report } = build({ threads }, comments)

    expect(items.map((item) => item.at)).toEqual([12, 13, 14, 15, 16, 17, 18].map(at))
    expect(report).toEqual({
      items: 7,
      omitted: 5,
      resolved: 0,
      bots: 0,
      truncated: 0,
      bytes: expect.any(Number),
    })
    expect(report.bytes).toBeLessThanOrEqual(16 * 1024)
  })

  it('reports what entered: resolved threads and bot items', () => {
    const { report } = build({ threads: [thread({ isResolved: true })] }, [
      comment({ author: 'lint-app', bot: true }),
      comment({ id: 'IC2' }),
    ])

    expect(report).toMatchObject({ items: 3, omitted: 0, resolved: 1, bots: 1, truncated: 0 })
  })

  it('is empty for a pull request without conversation', () => {
    expect(build()).toEqual({
      items: [],
      report: { items: 0, omitted: 0, resolved: 0, bots: 0, truncated: 0, bytes: 0 },
    })
  })
})
