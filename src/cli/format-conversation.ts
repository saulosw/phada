import { CONVERSATION_BODY_BYTES, CONVERSATION_BUDGET_BYTES } from '../publish/conversation.js'
import type { ConversationBlock, ConversationEntry } from '../app/read-run-report.js'
import type { Conversation } from '../publish/types.js'
import { toTerminalText } from '../app/terminal-text.js'
import { formatBytes, formatCount } from './units.js'

const BUDGET = `${CONVERSATION_BUDGET_BYTES / 1024} KB`
const BODY = `${CONVERSATION_BODY_BYTES / 1024} KB`

export function formatConversationLine({ report }: Conversation): string | undefined {
  if (report.items === 0 && report.omitted === 0) return undefined
  const details = [
    ...(report.resolved > 0 ? [`${report.resolved} resolved`] : []),
    ...(report.bots > 0 ? [formatCount(report.bots, 'bot')] : []),
    ...(report.omitted > 0 ? [`${report.omitted} left out over ${BUDGET}`] : []),
    ...(report.truncated > 0 ? [`${report.truncated} cut at ${BODY}`] : []),
  ]
  return `Conversation: ${formatCount(report.items, 'comment')}${details.length === 0 ? '' : ` (${details.join(', ')})`}`
}

const HEADING = '## Conversation sent to the AI\n\n'

export function formatConversationSection(conversation: ConversationBlock | null): string {
  if (conversation === null) return `${HEADING}Off.\n`
  const { items, count, omitted, truncated, budget } = conversation
  if (count === 0 && omitted === 0) return `${HEADING}No comments, reviews or threads.\n`
  const totals = [
    `Sent: ${formatBytes(budget.used)} of ${BUDGET}`,
    ...(omitted > 0
      ? [
          `Left out: ${formatCount(omitted, 'item')} over ${BUDGET} (resolved threads, then outdated ones, then the oldest)`,
        ]
      : []),
    ...(truncated > 0
      ? [`Cut: ${truncated} ${truncated === 1 ? 'body' : 'bodies'} at ${BODY}`]
      : []),
  ]
  return `${HEADING}${items.map(itemLine).join('\n')}\n\n${totals.join('\n')}\n`
}

function itemLine(item: ConversationEntry): string {
  const by = `by ${toTerminalText(item.author)} (${toTerminalText(item.role)}), ${when(item.at)}`
  switch (item.kind) {
    case 'comment':
      return `- comment ${by}`
    case 'review':
      return `- review ${toTerminalText(item.state)} ${by}`
    case 'thread': {
      const where = `${toTerminalText(item.file)}${item.line === null ? '' : `:${item.line}`}`
      const notes = [
        ...(item.resolved ? ['resolved'] : []),
        ...(item.outdated ? ['outdated'] : []),
        ...(item.replies === 0 ? [] : [replies(item.replies)]),
        ...(item.omittedReplies === 0
          ? []
          : [`${replies(item.omittedReplies, 'earlier ')} not read`]),
      ]
      return `- thread on ${where} ${by}${notes.length === 0 ? '' : `: ${notes.join(', ')}`}`
    }
  }
}

function when(at: string): string {
  return toTerminalText(at.slice(0, 16).replace('T', ' '))
}

function replies(count: number, kind = ''): string {
  return `${count} ${kind}${count === 1 ? 'reply' : 'replies'}`
}
