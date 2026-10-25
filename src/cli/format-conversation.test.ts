import { describe, expect, it } from 'vitest'
import type { Conversation, ConversationReport } from '../publish/types.js'
import { formatConversationLine, formatConversationSection } from './format-conversation.js'

function report(overrides: Partial<ConversationReport> = {}): ConversationReport {
  return { items: 6, omitted: 0, resolved: 2, bots: 1, truncated: 0, bytes: 4200, ...overrides }
}

function conversation(overrides: Partial<ConversationReport> = {}): Conversation {
  return { items: [], report: report(overrides) }
}

describe('formatConversationLine', () => {
  it('counts the comments, the resolved threads and the bots', () => {
    expect(formatConversationLine(conversation())).toBe(
      'Conversation: 6 comments (2 resolved, 1 bot)',
    )
  })

  it('says how many items were left out over the budget and how many bodies were cut', () => {
    expect(
      formatConversationLine(
        conversation({ items: 1, resolved: 0, bots: 0, omitted: 3, truncated: 1 }),
      ),
    ).toBe('Conversation: 1 comment (3 left out over 16 KB, 1 cut at 2 KB)')
  })

  it('prints no line for a pull request without conversation', () => {
    expect(
      formatConversationLine(conversation({ items: 0, resolved: 0, bots: 0, bytes: 0 })),
    ).toBeUndefined()
  })
})

describe('formatConversationSection', () => {
  it('lists each item that went in and what was left out', () => {
    const items: Conversation['items'] = [
      {
        kind: 'comment',
        at: '2026-10-20T10:00:00Z',
        author: 'alice',
        role: 'member',
        body: 'Looks fine',
      },
      {
        kind: 'review',
        at: '2026-10-20T11:30:00Z',
        author: 'bob',
        role: 'owner',
        state: 'changes-requested',
      },
      {
        kind: 'thread',
        at: '2026-10-21T09:05:00Z',
        author: 'renovate[bot]',
        role: 'bot',
        file: 'src/a.ts',
        line: 12,
        resolved: true,
        outdated: true,
        body: 'x',
        replies: [{ at: '2026-10-21T10:00:00Z', author: 'carol', role: 'author', body: 'ok' }],
        omittedReplies: 2,
      },
      {
        kind: 'thread',
        at: '2026-10-22T09:05:00Z',
        author: 'phada-owner',
        role: 'phada',
        file: 'src/b.ts',
        line: null,
        resolved: false,
        outdated: false,
        body: 'Missing null check',
      },
    ]

    expect(
      formatConversationSection({
        items,
        report: { items: 4, omitted: 3, resolved: 1, bots: 1, truncated: 1, bytes: 4200 },
      }),
    ).toBe(
      [
        '## Conversation sent to the AI',
        '',
        '- comment by alice (member), 2026-10-20 10:00',
        '- review changes-requested by bob (owner), 2026-10-20 11:30',
        '- thread on src/a.ts:12 by renovate[bot] (bot), 2026-10-21 09:05: resolved, outdated, 1 reply, 2 earlier replies not read',
        '- thread on src/b.ts by phada-owner (phada), 2026-10-22 09:05',
        '',
        'Sent: 4.1 KB of 16 KB',
        'Left out: 3 items over 16 KB (resolved threads, then outdated ones, then the oldest)',
        'Cut: 1 body at 2 KB',
        '',
      ].join('\n'),
    )
  })

  it('says when the pull request has no conversation and when it is off', () => {
    expect(formatConversationSection(conversation({ items: 0, bytes: 0 }))).toBe(
      '## Conversation sent to the AI\n\nNo comments, reviews or threads.\n',
    )
    expect(formatConversationSection(undefined)).toBe('## Conversation sent to the AI\n\nOff.\n')
  })

  it('strips control characters from authors and files', () => {
    const section = formatConversationSection({
      items: [
        {
          kind: 'comment',
          at: '2026-10-20T10:00:00Z',
          author: 'ev\u001bil',
          role: 'external',
          body: '',
        },
      ],
      report: report({ items: 1 }),
    })
    expect(section).toContain('- comment by evil (external)')
  })
})
