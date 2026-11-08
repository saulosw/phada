import type { RepliesRun, ThreadReply } from '../app/reply-to-threads.js'
import { toTerminalText } from '../app/terminal-text.js'
import { formatPullRequestRef, splitRepoName } from '../github/pull-request-ref.js'
import { formatCount } from './units.js'

export interface ReplyReport extends Pick<RepliesRun, 'threads' | 'limited'> {
  pullRequest: { repo: string; number: number }
}

export function formatReplyRun(run: ReplyReport, dryRun: boolean): string {
  const name = toTerminalText(nameOf(run))
  if (run.threads.length === 0) {
    return run.limited
      ? ''
      : `Nothing to answer on ${name}: no new reply in Phada's open threads.\n`
  }
  const blocks = run.threads.map((thread) => threadBlock(thread, dryRun))
  return `${[...blocks, summary(run, name, dryRun)].join('\n\n')}\n`
}

export function replyRunJson(run: ReplyReport, dryRun: boolean): string {
  const { repo, number } = run.pullRequest
  const threads = run.threads.map((thread) => ({
    threadId: thread.threadId,
    url: thread.url,
    file: thread.file,
    line: thread.line,
    kind: thread.kind,
    text: thread.text ?? null,
    posted: thread.posted,
    resolved: thread.resolved,
    answerUrl: thread.answerUrl ?? null,
    skipped: thread.skipped ?? null,
  }))
  const json = { pullRequest: { repo, number }, dryRun, limited: run.limited, threads }
  return `${JSON.stringify(json, null, 2)}\n`
}

export function replyPlace(thread: ThreadReply): string {
  return thread.line === null ? thread.file : `${thread.file}:${thread.line}`
}

function threadBlock(thread: ThreadReply, dryRun: boolean): string {
  const place = replyPlace(thread)
  const head = `${place} · ${thread.kind} · ${replyOutcome(thread, dryRun)}`
  const answer = thread.text === undefined ? [] : thread.text.split('\n')
  const link = thread.answerUrl === undefined ? [] : [thread.answerUrl]
  return toTerminalText([head, ...[...answer, ...link].map((line) => `  ${line}`)].join('\n'))
}

export function replyOutcome(thread: ThreadReply, dryRun: boolean): string {
  if (thread.text === undefined) return 'no answer needed'
  if (thread.skipped === 'resolved') return 'skipped (thread resolved)'
  if (dryRun) return 'not posted (dry run)'
  if (thread.resolved) return 'posted and resolved'
  return thread.posted ? 'posted' : 'not posted'
}

function summary(run: ReplyReport, name: string, dryRun: boolean): string {
  const threads = `${formatCount(run.threads.length, 'thread')} on ${name}`
  if (dryRun) return `${threads}: dry run, nothing was posted or kept.`
  const posted = run.threads.filter((thread) => thread.posted).length
  const resolved = run.threads.filter((thread) => thread.resolved).length
  const skipped = run.threads.filter((thread) => thread.skipped !== undefined).length
  const parts = [
    ...(posted === 0 ? [] : [formatCount(posted, 'answer') + ' posted']),
    ...(resolved === 0 ? [] : [formatCount(resolved, 'thread') + ' resolved']),
    ...(skipped === 0 ? [] : [`${skipped} skipped`]),
  ]
  return `${threads}: ${parts.length === 0 ? 'no answer posted' : parts.join(', ')}.`
}

function nameOf({ pullRequest }: ReplyReport): string {
  return formatPullRequestRef({ ...splitRepoName(pullRequest.repo), number: pullRequest.number })
}
