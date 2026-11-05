import type { AiRun, ReviewProgress, ReviewProgressSink } from '../app/review-progress.js'
import { toTerminalText } from '../app/terminal-text.js'
import { ciWaitProgress } from './ci-wait-progress.js'
import { formatCiLine } from './format-ci.js'
import { formatContextLine } from './format-context.js'
import { formatConversationLine } from './format-conversation.js'
import { groupSize } from './format-groups.js'
import { formatImpactLine } from './format-impact.js'
import { formatPassesLine } from './format-passes.js'
import { formatRelatedLine } from './format-related.js'
import { formatPullRequestSummary } from './format-review.js'
import { CLEAR_LINE, indexProgress, liveProgress } from './progress.js'
import type { TextOutput } from './progress.js'

const AI_LABELS: Readonly<Record<AiRun, string>> = {
  review: 'Reviewing',
  verify: 'Verifying findings',
  recheck: 'Rechecking open comments',
  skill: 'Running the skill',
}

export function printReviewProgress(
  output: TextOutput,
  clock: () => Date = () => new Date(),
): ReviewProgressSink {
  const index = indexProgress(output)
  const ciWait = ciWaitProgress(output, clock)
  let stopAi: (() => void) | undefined
  let runningAi = 0
  const writeLine = (line: string | undefined) => {
    if (line !== undefined) output.write(`${line}\n`)
  }
  const warn = (message: string) => output.write(`Warning: ${toTerminalText(message)}\n`)
  return (event) => {
    switch (event.kind) {
      case 'fetched':
        return writeLine(formatPullRequestSummary(event.pullRequest))
      case 'conversationRead':
        return writeLine(formatConversationLine(event.conversation))
      case 'ciRead':
        return writeLine(formatCiLine(event.ci))
      case 'ciWaiting':
        return ciWait.waiting(event.wait)
      case 'ciWaited':
        return ciWait.waited(event.wait)
      case 'contextLoaded':
        for (const warning of event.report.warnings) warn(warning)
        return writeLine(formatContextLine(event.report, event.baseSha))
      case 'indexing':
        return index.extracting(event.total)
      case 'indexed':
        return index.extracted(event.done, event.total)
      case 'relatedReady':
        return writeLine(formatRelatedLine(event.report))
      case 'impactReady':
        return writeLine(formatImpactLine(event.report))
      case 'passesPlanned':
        return writeLine(formatPassesLine(event.plan))
      case 'passStarted':
        if (event.total > 1) {
          writeLine(toTerminalText(`Skill ${event.index + 1}/${event.total}: ${event.skill}`))
        }
        return
      case 'groupStarted':
        return writeLine(
          `${stopAi !== undefined && output.isTTY === true ? CLEAR_LINE : ''}${toTerminalText(startedGroupLine(event))}`,
        )
      case 'aiStarted':
        runningAi += 1
        if (runningAi > 1 && stopAi !== undefined) return
        stopAi?.()
        stopAi = liveProgress(`${AI_LABELS[event.run]} with ${event.provider}…`, output)
        return
      case 'aiFinished':
        runningAi = Math.max(0, runningAi - 1)
        if (runningAi > 0) return
        stopAi?.()
        stopAi = undefined
        return
      case 'publishing':
        return writeLine('Publishing the review…')
      case 'warning':
        return warn(event.message)
    }
  }
}

function startedGroupLine(group: Extract<ReviewProgress, { kind: 'groupStarted' }>): string {
  return `Group ${group.index + 1}/${group.total}: ${group.label} (${groupSize(group.files, group.bytes)})`
}
