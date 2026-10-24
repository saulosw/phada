import type { SlackEmojis, SlackReply } from '../config/watch-settings.js'
import type { ReviewedFinding, ReviewEvent } from './review-event.js'
import { shortSha } from './review-text.js'
import { toTerminalText } from './terminal-text.js'
import { formatCount } from './units.js'

export const MAX_SLACK_MESSAGE = 3_500
export const MAX_SLACK_MESSAGES = 10
const MAX_WHY = 1_500

const LABELS = {
  clean: 'No findings',
  comments: 'Comments',
  blocking: 'Blocking findings',
  failed: 'Review failed',
  skipped: 'Skipped',
} as const

const SKIP_REASONS: Readonly<Record<string, string>> = {
  'already-reviewed': 'This commit was already reviewed.',
  'same-diff': 'The diff did not change since the last review.',
  closed: 'The pull request was closed.',
  'closed-or-draft': 'The pull request was closed or went back to draft.',
  superseded: 'A newer commit replaced this one.',
}

interface ReviewView {
  summary?: string
  score?: { value: number }
  findings: ReviewedFinding[]
  worthChecking: ReviewedFinding[]
}

export function slackReplies(event: ReviewEvent, reply: SlackReply, emojis: SlackEmojis): string[] {
  const header = headerText(event, emojis)
  const review = reviewView(event)
  if (event.event === 'review.failed') {
    return [event.error === undefined ? header : `${header}\n${escape(event.error)}`]
  }
  if (event.event === 'review.skipped') {
    const why = event.reason === undefined ? undefined : SKIP_REASONS[event.reason]
    return [`${header}\n${why ?? `Not reviewed (${escape(event.reason ?? 'no reason')}).`}`]
  }
  if (reply === 'link' || review === undefined) return [header]
  const summary = [header, ...(review.summary ? [escape(review.summary)] : []), countsLine(review)]
  const opening = summary.join('\n')
  if (reply === 'summary') return [opening]
  const blocks = [
    ...review.findings.map((finding) => findingBlock(finding, event)),
    ...review.worthChecking.map((finding, index) =>
      index === 0
        ? `*Worth checking*\n${findingBlock(finding, event)}`
        : findingBlock(finding, event),
    ),
  ]
  return chunk(opening, blocks, event.publication?.url !== undefined)
}

function headerText(event: ReviewEvent, emojis: SlackEmojis): string {
  const verdict = event.verdict ?? 'skipped'
  const { job } = event
  const parts = [
    `:${emojis[verdict]}: *${LABELS[verdict]}*`,
    `<${job.url}|${job.repo}#${job.number}> at \`${shortSha(job.headSha)}\``,
  ]
  const url = event.publication?.url
  if (url !== undefined) parts.push(`<${url}|review on GitHub>`)
  return parts.join(' · ')
}

function countsLine(review: ReviewView): string {
  const bySeverity = ['P0', 'P1', 'P2']
    .map((severity) => [severity, review.findings.filter((f) => f.severity === severity).length])
    .filter(([, count]) => count !== 0)
    .map(([severity, count]) => `${count} ${severity}`)
  const parts = [
    ...(review.score === undefined ? [] : [`Score ${review.score.value}/5`]),
    review.findings.length === 0
      ? 'no findings'
      : `${formatCount(review.findings.length, 'finding')} (${bySeverity.join(', ')})`,
    ...(review.worthChecking.length === 0 ? [] : [`${review.worthChecking.length} worth checking`]),
  ]
  return parts.join(' · ')
}

function findingBlock(finding: ReviewedFinding, event: ReviewEvent): string {
  const { repo, headSha } = event.job
  const place = `${finding.file}:${finding.line}`
  const link = `https://github.com/${repo}/blob/${headSha}/${encodeURI(finding.file)}#L${finding.line}`
  const why = finding.why.length > MAX_WHY ? `${finding.why.slice(0, MAX_WHY)}…` : finding.why
  return `*${escape(finding.severity)}* <${link}|${escape(place)}> ${escape(finding.title)}\n${escape(why)}`
}

function chunk(opening: string, blocks: readonly string[], published: boolean): string[] {
  const messages: string[][] = []
  let last = [opening]
  let placed = 0
  for (const block of blocks) {
    if (size([...last, block]) <= MAX_SLACK_MESSAGE) {
      last.push(block)
      placed += 1
      continue
    }
    if (messages.length === MAX_SLACK_MESSAGES - 1) break
    messages.push(last)
    last = [block.slice(0, MAX_SLACK_MESSAGE)]
    placed += 1
  }
  let left = blocks.length - placed
  if (left > 0) {
    const more = () =>
      published ? `+${left} more findings: see the review on GitHub.` : `+${left} more findings.`
    while (size([...last, more()]) > MAX_SLACK_MESSAGE && last.length > 1) {
      last.pop()
      left += 1
    }
    last.push(more())
  }
  return [...messages, last].map((parts) => parts.join('\n\n'))
}

function size(parts: readonly string[]): number {
  return parts.join('\n\n').length
}

function reviewView(event: ReviewEvent): ReviewView | undefined {
  const review = event.review?.review
  if (review === undefined) return undefined
  return {
    ...(review.summary === undefined ? {} : { summary: review.summary }),
    ...(review.score === undefined ? {} : { score: review.score }),
    findings: review.findings ?? [],
    worthChecking: review.worthChecking ?? [],
  }
}

function escape(text: string): string {
  return toTerminalText(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
