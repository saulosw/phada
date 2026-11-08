import { describe, expect, it } from 'vitest'
import type { ThreadReply } from '../app/reply-to-threads.js'
import { formatReplyRun, replyRunJson } from './format-reply.js'

const PULL = { repo: 'acme/shop', number: 12 }

function thread(overrides: Partial<ThreadReply> = {}): ThreadReply {
  return {
    threadId: 'T1',
    url: 'https://github.com/acme/shop/pull/12#discussion_r1',
    file: 'src/shop.ts',
    line: 3,
    kind: 'question',
    text: 'The check runs in `spend()`, line 40.',
    posted: true,
    resolved: false,
    answerUrl: 'https://github.com/acme/shop/pull/12#discussion_r2',
    ...overrides,
  }
}

describe('formatReplyRun', () => {
  it('prints each thread with its kind, what happened and the answer, then a summary', () => {
    const text = formatReplyRun(
      {
        pullRequest: PULL,
        limited: false,
        threads: [
          thread(),
          thread({
            threadId: 'T2',
            file: 'src/cart.ts',
            line: null,
            kind: 'refuted',
            text: 'Right, the guard is upstream.\nResolving.',
            resolved: true,
          }),
          thread({
            threadId: 'T3',
            kind: 'ack',
            posted: false,
            answerUrl: undefined,
            text: undefined,
          }),
          thread({
            threadId: 'T4',
            kind: 'disagreed',
            posted: false,
            answerUrl: undefined,
            skipped: 'resolved',
          }),
        ],
      },
      false,
    )

    expect(text).toBe(
      [
        'src/shop.ts:3 · question · posted',
        '  The check runs in `spend()`, line 40.',
        '  https://github.com/acme/shop/pull/12#discussion_r2',
        '',
        'src/cart.ts · refuted · posted and resolved',
        '  Right, the guard is upstream.',
        '  Resolving.',
        '  https://github.com/acme/shop/pull/12#discussion_r2',
        '',
        'src/shop.ts:3 · ack · no answer needed',
        '',
        'src/shop.ts:3 · disagreed · skipped (thread resolved)',
        '  The check runs in `spend()`, line 40.',
        '',
        '4 threads on acme/shop#12: 2 answers posted, 1 thread resolved, 1 skipped.',
        '',
      ].join('\n'),
    )
  })

  it('says nothing was posted in a dry run', () => {
    const text = formatReplyRun(
      {
        pullRequest: PULL,
        limited: false,
        threads: [
          thread({ posted: false, answerUrl: undefined }),
          thread({ kind: 'applied', posted: false, answerUrl: undefined, text: undefined }),
        ],
      },
      true,
    )

    expect(text).toBe(
      [
        'src/shop.ts:3 · question · not posted (dry run)',
        '  The check runs in `spend()`, line 40.',
        '',
        'src/shop.ts:3 · applied · no answer needed',
        '',
        '2 threads on acme/shop#12: dry run, nothing was posted or kept.',
        '',
      ].join('\n'),
    )
  })

  it('says when there is nothing to answer', () => {
    expect(formatReplyRun({ pullRequest: PULL, limited: false, threads: [] }, false)).toBe(
      "Nothing to answer on acme/shop#12: no new reply in Phada's open threads.\n",
    )
  })

  it('prints nothing more when the usage limit stopped it before any thread', () => {
    expect(formatReplyRun({ pullRequest: PULL, limited: true, threads: [] }, false)).toBe('')
  })

  it('strips control characters from the text of others', () => {
    const text = formatReplyRun(
      {
        pullRequest: PULL,
        limited: false,
        threads: [thread({ file: 'src/\u001b[31mshop.ts', text: 'ok\u0007 then' })],
      },
      false,
    )

    expect(text).toContain('src/[31mshop.ts:3 · question · posted\n  ok then\n')
  })
})

describe('replyRunJson', () => {
  it('gives the pull request, the run and every thread', () => {
    const json = JSON.parse(
      replyRunJson(
        {
          pullRequest: PULL,
          limited: true,
          threads: [thread({ kind: 'refuted', resolved: true })],
        },
        false,
      ),
    ) as unknown

    expect(json).toEqual({
      pullRequest: { repo: 'acme/shop', number: 12 },
      dryRun: false,
      limited: true,
      threads: [
        {
          threadId: 'T1',
          url: 'https://github.com/acme/shop/pull/12#discussion_r1',
          file: 'src/shop.ts',
          line: 3,
          kind: 'refuted',
          text: 'The check runs in `spend()`, line 40.',
          posted: true,
          resolved: true,
          answerUrl: 'https://github.com/acme/shop/pull/12#discussion_r2',
          skipped: null,
        },
      ],
    })
  })

  it('ends with a newline and gives null for a missing text and line', () => {
    const json = replyRunJson(
      {
        pullRequest: PULL,
        limited: false,
        threads: [
          thread({ kind: 'ack', line: null, text: undefined, posted: false, answerUrl: undefined }),
        ],
      },
      true,
    )

    expect(json.endsWith('}\n')).toBe(true)
    expect(JSON.parse(json)).toMatchObject({
      dryRun: true,
      threads: [{ kind: 'ack', line: null, text: null, posted: false, answerUrl: null }],
    })
  })
})
