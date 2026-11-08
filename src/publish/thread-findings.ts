import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import type { Severity, SuggestedEdit } from '../review/types.js'
import { findingSeverity, findingTitle, withoutFindingMarker } from './markers.js'
import { openPhadaThreads } from './phada-state.js'

type ThreadSuggestion = Omit<SuggestedEdit, 'original'>

export interface ThreadFinding {
  number: number
  thread: { id: string; url: string; outdated: boolean }
  finding: {
    severity?: Severity
    file: string
    line: number
    title: string
    why: string
    fix: null
    suggestion?: ThreadSuggestion
  }
}

const SUGGESTION_OPENING = /^(`{3,})suggestion[ \t]*$/

export function threadFindings(state: PullRequestReviewState): ThreadFinding[] {
  return openPhadaThreads(state)
    .map((thread) => ({ thread, line: thread.line ?? thread.originalLine ?? 0 }))
    .sort((a, b) => compareText(a.thread.path, b.thread.path) || a.line - b.line)
    .map(({ thread, line }, index) => ({
      number: index + 1,
      thread: { id: thread.id, url: thread.url, outdated: thread.isOutdated },
      finding: findingOf(thread, line),
    }))
}

function findingOf(thread: ReviewThread, line: number): ThreadFinding['finding'] {
  const lines = withoutFindingMarker(thread.body.replace(/\r/g, '')).split('\n')
  const [first = ''] = lines
  const severity = findingSeverity(thread.body)
  const suggestion = currentSuggestion(thread, lines)
  return {
    ...(severity === undefined ? {} : { severity }),
    file: thread.path,
    line,
    title: findingTitle(thread.body) ?? first.trim(),
    why: lines.slice(1).join('\n').trim(),
    fix: null,
    ...(suggestion === undefined ? {} : { suggestion }),
  }
}

function currentSuggestion(
  thread: ReviewThread,
  lines: readonly string[],
): ThreadSuggestion | undefined {
  if (thread.isOutdated || thread.line === null) return undefined
  const replacement = suggestionBlock(lines)
  if (replacement === undefined) return undefined
  return { startLine: thread.startLine ?? thread.line, endLine: thread.line, replacement }
}

function suggestionBlock(lines: readonly string[]): string | undefined {
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    const fence = SUGGESTION_OPENING.exec(lines[start] ?? '')?.[1]
    if (fence === undefined) continue
    const end = lines.findIndex((line, index) => index > start && line.trimEnd() === fence)
    if (end !== -1) return lines.slice(start + 1, end).join('\n')
  }
  return undefined
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
