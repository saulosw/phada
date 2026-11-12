import type { ReviewedLocalChanges } from '../app/local-review.js'
import type { ReviewRun } from '../app/review-and-publish.js'
import type { PullRequestReview, ReviewOptions } from '../app/review-pull-request.js'
import { toTerminalText } from '../app/terminal-text.js'
import { formatPullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequest } from '../github/pull-request.js'
import { usageReport } from '../review/token-usage.js'
import type { UsageReport } from '../review/token-usage.js'
import type { ReviewOutcome } from '../review/types.js'
import type { StopSignal } from '../tui/open-app.js'
import type { CommandOf } from './args.js'
import { blockedFixer } from './blocked-fix.js'
import { formatGitHubPreview } from './format-github.js'
import { formatInvestigationLine } from './format-investigation.js'
import { ciJson, conversationJson } from './format-json.js'
import { formatSkillRunLines } from './format-passes.js'
import type { BlockedFix } from './format-passes.js'
import {
  formatPublishedMessage,
  formatRecheckMessage,
  formatResolvedMessage,
  formatSkipMessage,
  formatWouldResolveMessage,
} from './format-publication.js'
import { formatLocalReview, formatLocalReviewStart, formatReview } from './format-review.js'
import { formatRunSections } from './format-run-sections.js'
import type { RunSections } from './format-run-sections.js'
import { formatUsageLine } from './format-usage.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { messagesFor } from './i18n/messages.js'
import { runLocalReview } from './local-review-command.js'
import type { LocalReviewRunDeps } from './local-review-command.js'
import { prepareReview, runManualReview } from './manual-review.js'
import type { ManualReviewDeps } from './manual-review.js'
import { printHistorySave, savedAsLine } from './print-history-save.js'
import { printReviewProgress } from './print-review-progress.js'
import type { TextOutput } from './progress.js'
import { localReviewJson, publicationCounts, reviewRunJson } from './review-wiring.js'

type ReviewCommand = CommandOf<'review'>
type LocalReviewCommand = CommandOf<'review-local'>

export interface ReviewCommandDeps extends ManualReviewDeps, LocalReviewRunDeps, GitHubTokenDeps {
  cwd: string
  stdout: TextOutput
  stderr: TextOutput
  onSignal: (handler: (signal?: StopSignal) => void) => void
  abort: (code: number) => void
}

export async function runLocalReviewCommand(
  command: LocalReviewCommand,
  deps: ReviewCommandDeps,
): Promise<number> {
  const token = await requireGitHubToken(deps)
  deps.onSignal(() => deps.abort(130))
  const { review, history } = await runLocalReview(
    {
      cwd: deps.cwd,
      token,
      ...(command.base === undefined ? {} : { base: command.base }),
      uncommitted: command.uncommitted,
      ...(command.provider === undefined ? {} : { provider: command.provider }),
      ...(command.model === undefined ? {} : { model: command.model }),
      options: reviewOptions(command),
    },
    deps,
    {
      progress: printReviewProgress(deps.stderr, deps.clock),
      started: (local) => deps.stderr.write(`${formatLocalReviewStart(local)}\n`),
    },
  )
  printHistorySave(deps.stderr, history)
  try {
    printLocalReview(deps, command, review)
  } finally {
    const saved = savedAsLine(history)
    if (saved !== undefined) deps.stderr.write(`${saved}\n`)
  }
  return 0
}

export async function runReviewCommand(
  command: ReviewCommand,
  deps: ReviewCommandDeps,
): Promise<number> {
  const token = await requireGitHubToken(deps)
  const prepared = await prepareReview(
    command.ref,
    token,
    {
      ...(command.provider === undefined ? {} : { provider: command.provider }),
      ...(command.model === undefined ? {} : { model: command.model }),
    },
    deps,
  )

  deps.onSignal(() => deps.abort(130))
  deps.stderr.write(`Fetching ${formatPullRequestRef(command.ref)}…\n`)
  const { run, history } = await runManualReview(
    prepared,
    {
      force: command.force,
      dryRun: command.dryRun,
      waitCi: command.waitCi === true,
      ...(command.head === undefined ? {} : { head: command.head }),
      options: {
        ...reviewOptions(command),
        ...(command.resolveThreads === undefined ? {} : { resolveThreads: command.resolveThreads }),
        ...(command.conversation === undefined ? {} : { conversation: command.conversation }),
        ...(command.ci === undefined ? {} : { ci: command.ci }),
      },
    },
    deps,
    {
      progress: printReviewProgress(deps.stderr, deps.clock),
      reviewed: (reviewed, pullRequest) => printReviewed(deps, command, reviewed, pullRequest),
    },
  )
  printHistorySave(deps.stderr, history)
  try {
    printRun(deps, command, run)
    const usageLine = formatUsageLine(runUsage(run))
    if (usageLine !== undefined) deps.stderr.write(`${usageLine}\n`)
  } finally {
    const saved = savedAsLine(history)
    if (saved !== undefined) deps.stderr.write(`${saved}\n`)
  }
  return 0
}

function reviewOptions(command: ReviewCommand | LocalReviewCommand): ReviewOptions {
  return {
    language: command.language,
    minConfidence: command.minConfidence,
    verify: command.verify,
    ...(command.continuation === undefined ? {} : { continuation: command.continuation }),
    ...(command.groups === undefined ? {} : { groups: command.groups }),
    investigate: command.investigate,
    ...(command.skills === undefined ? {} : { skills: command.skills }),
  }
}

function fixerFor(
  deps: ReviewCommandDeps,
  pullRequest: PullRequest,
  reviewed: PullRequestReview | undefined,
): BlockedFix {
  const review = reviewed?.context.options.review
  return blockedFixer({
    pullRequest,
    env: deps.env,
    home: deps.home,
    ...(review === undefined ? {} : { review }),
  })
}

function printLocalReview(
  deps: ReviewCommandDeps,
  command: LocalReviewCommand,
  review: ReviewedLocalChanges,
): void {
  const { local, pullRequest, reviewed } = review
  const fixFor = printReviewNotes(deps, reviewed, pullRequest)
  const { outcome } = reviewed
  if (command.format === 'json') deps.stdout.write(localReviewJson(review, fixFor))
  if (outcome.status === 'skipped') return
  if (command.format === 'markdown') {
    deps.stdout.write(
      formatLocalReview(local, pullRequest.title, outcome.result, messagesFor(reviewed.language)),
    )
  }
  const usageLine = formatUsageLine(usageReport(outcome.result.passUsage, undefined))
  if (usageLine !== undefined) deps.stderr.write(`${usageLine}\n`)
}

function printReviewNotes(
  deps: ReviewCommandDeps,
  reviewed: PullRequestReview,
  pullRequest: PullRequest,
): BlockedFix {
  const fixFor = fixerFor(deps, pullRequest, reviewed)
  const { outcome } = reviewed
  if (outcome.status === 'skipped') {
    deps.stderr.write(`${toTerminalText(skipLine(outcome))}\n`)
    return fixFor
  }
  for (const warning of outcome.result.warnings ?? []) {
    deps.stderr.write(`Warning: ${toTerminalText(warning)}\n`)
  }
  for (const line of formatSkillRunLines(outcome.result.passes ?? [], fixFor)) {
    deps.stderr.write(`${line}\n`)
  }
  const investigationLine = formatInvestigationLine(reviewed.investigation)
  if (investigationLine !== undefined) deps.stderr.write(`${investigationLine}\n`)
  return fixFor
}

function printReviewed(
  deps: ReviewCommandDeps,
  command: ReviewCommand,
  reviewed: PullRequestReview,
  pullRequest: PullRequest,
): void {
  printReviewNotes(deps, reviewed, pullRequest)
  const { outcome } = reviewed
  if (outcome.status === 'skipped') return
  if (reviewed.recheck !== undefined) {
    deps.stderr.write(`${formatRecheckMessage(reviewed.recheck)}\n`)
  }
  if (!command.dryRun && command.format === 'markdown') {
    deps.stdout.write(formatReview(pullRequest, outcome.result, messagesFor(reviewed.language)))
  }
}

function printRun(deps: ReviewCommandDeps, command: ReviewCommand, run: ReviewRun): void {
  const json = command.format === 'json'
  const fixFor = fixerFor(
    deps,
    run.pullRequest,
    run.status === 'skipped' ? undefined : run.reviewed,
  )
  if (json) deps.stdout.write(reviewRunJson(run, fixFor))
  const { pullRequest } = run
  if (run.status === 'skipped') {
    deps.stderr.write(`${formatSkipMessage(pullRequest.headSha, run.reason)}\n`)
    return
  }
  const { publication, rendered } = run
  if (publication === undefined || rendered === undefined) return
  const messages = messagesFor(run.reviewed.language)
  switch (publication.status) {
    case 'dry-run':
      if (!json) {
        deps.stdout.write(
          run.status === 'nothing'
            ? formatGitHubPreview(rendered, messages)
            : [
                formatGitHubPreview(rendered, messages),
                ...formatRunSections(dryRunSections(run, fixFor)),
              ].join('\n'),
        )
      }
      deps.stderr.write('Dry run: nothing was posted.\n')
      if (publication.wouldResolve.length > 0) {
        deps.stderr.write(`${formatWouldResolveMessage(publication.wouldResolve.length)}\n`)
      }
      if (run.status === 'reviewed' && run.wouldSkip !== undefined) {
        deps.stderr.write(
          `Without --dry-run: ${formatSkipMessage(pullRequest.headSha, run.wouldSkip)}\n`,
        )
      }
      return
    case 'failed':
      throw publication.error
    case 'published': {
      const { comments, stillOpen, dismissed } = publicationCounts(run)
      deps.stderr.write(
        `${formatPublishedMessage(publication.url, comments, stillOpen, dismissed)}\n`,
      )
      if (publication.resolved.total > 0) {
        const { resolved, total } = publication.resolved
        deps.stderr.write(`${formatResolvedMessage(resolved, total)}\n`)
      }
      return
    }
    default:
      return
  }
}

function skipLine(outcome: Extract<ReviewOutcome, { status: 'skipped' }>): string {
  if (outcome.reason === 'all-ignored') return 'Nothing to review: every changed file is ignored.'
  if (outcome.reason === 'empty-diff') return 'Nothing to review: the pull request has no changes.'
  const skipped = (outcome.passes ?? []).map(({ skill, reason }) => `${skill} — ${reason ?? ''}`)
  return `Nothing to review: no skill applies to the changed files (${skipped.join('; ')}).`
}

function runUsage(run: ReviewRun): UsageReport {
  if (run.status === 'skipped') return { passes: [] }
  const { outcome, recheck } = run.reviewed
  return usageReport(outcome.status === 'reviewed' ? outcome.result.passUsage : undefined, recheck)
}

function dryRunSections(
  run: Extract<ReviewRun, { status: 'reviewed' }>,
  fixFor: BlockedFix,
): RunSections {
  const { reviewed } = run
  const { outcome } = reviewed
  const result = outcome.status === 'reviewed' ? outcome.result : undefined
  return {
    ...(result === undefined
      ? {}
      : {
          closeToCut: { findings: result.findings, minConfidence: result.minConfidence },
          claims: result.claims,
        }),
    context: reviewed.context.report,
    conversation:
      reviewed.conversation === undefined ? null : conversationJson(reviewed.conversation),
    ci: reviewed.ci === undefined ? null : ciJson(reviewed.ci),
    impact: {
      report: reviewed.impact,
      ...(reviewed.impactText === undefined ? {} : { text: reviewed.impactText }),
    },
    related: reviewed.related,
    ...(result?.passes === undefined ? {} : { passes: { reports: result.passes, fixFor } }),
    ...(result?.groups === undefined ? {} : { groups: result.groups }),
    investigation: reviewed.investigation,
    ...(result?.coverage === undefined ? {} : { coverage: result.coverage }),
    usage: runUsage(run),
  }
}
