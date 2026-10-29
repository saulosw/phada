import type { PullRequestReview } from './app/review-pull-request.js'
import { assertAppTerminal, runApp } from './cli/app-command.js'
import type { AppCommandDeps } from './cli/app-command.js'
import { parseCliArgs } from './cli/args.js'
import type { CliCommand } from './cli/args.js'
import { requireGitHubToken } from './cli/github-token.js'
import { formatError } from './cli/format-error.js'
import { formatGitHubPreview } from './cli/format-github.js'
import { formatCiSection } from './cli/format-ci.js'
import { formatClaimsSection } from './cli/format-claims.js'
import { formatCloseToCutSection } from './cli/format-close-to-cut.js'
import { formatContextSection } from './cli/format-context.js'
import { formatConversationSection } from './cli/format-conversation.js'
import { formatImpactSection } from './cli/format-impact.js'
import { formatInvestigationLine, formatInvestigationSection } from './cli/format-investigation.js'
import { formatRelatedSection } from './cli/format-related.js'
import { formatPassesSection, formatSkillRunLines } from './cli/format-passes.js'
import type { BlockedFix } from './cli/format-passes.js'
import { blockedFixer } from './cli/blocked-fix.js'
import { printReviewProgress } from './cli/print-review-progress.js'
import type { ReviewOutcome } from './review/types.js'
import {
  formatPublishedMessage,
  formatRecheckMessage,
  formatResolvedMessage,
  formatSkipMessage,
  formatWouldResolveMessage,
} from './cli/format-publication.js'
import { formatReview } from './cli/format-review.js'
import { messagesFor } from './cli/i18n/messages.js'
import { runIndex } from './cli/index-command.js'
import { runInit } from './cli/init.js'
import { runPrompt } from './cli/prompt-command.js'
import { runRules } from './cli/rules-command.js'
import { runHistory, runHistoryPrune } from './cli/history-command.js'
import { reviewRunJson } from './cli/review-wiring.js'
import { prepareReview, runManualReview } from './cli/manual-review.js'
import type { ReviewRun } from './app/review-and-publish.js'
import type { HistorySave } from './app/requested-review.js'
import { assertProviderChoice } from './cli/provider-choice.js'
import type { ProviderOptions } from './cli/provider-choice.js'
export { assertProviderChoice } from './cli/provider-choice.js'
export type { ProviderOptions } from './cli/provider-choice.js'
import { toTerminalText } from './app/terminal-text.js'
import { formatPullRequestRef } from './github/pull-request-ref.js'
import type { PullRequest } from './github/pull-request.js'
import { runEnqueue } from './cli/enqueue-command.js'
import { runMcp } from './cli/mcp-command.js'
import type { McpCommandDeps } from './cli/mcp-command.js'
import { runWatch } from './cli/watch-command.js'
import type { WatchCommandDeps } from './cli/watch-command.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import type { ReviewProvider } from './providers/types.js'

export interface MainDeps extends WatchCommandDeps, McpCommandDeps, AppCommandDeps {
  cwd: string
  pathSize: (path: string) => Promise<number>
  killDetachedChildren: () => void
}

export function createProvider(name: string, options: ProviderOptions): ReviewProvider {
  assertProviderChoice(name, options)
  switch (name) {
    case 'claude':
      return new ClaudeCliProvider({
        ...cliOptions(options),
        ...(options.mcpNames?.provider === 'claude' ? { mcpNames: options.mcpNames.names } : {}),
      })
    case 'codex':
      return new CodexCliProvider({
        ...cliOptions(options),
        ...(options.mcpNames?.provider === 'codex' ? { mcpNames: options.mcpNames.names } : {}),
      })
    default:
      return new OllamaProvider({ model: options.model ?? '' })
  }
}

export async function run(argv: readonly string[], deps: MainDeps): Promise<number> {
  let debug = false
  try {
    const command = parseCliArgs(argv)
    if (command.kind === 'help') {
      deps.stdout.write(`${command.text}\n`)
      return 0
    }
    if (command.kind === 'version') {
      deps.stdout.write(`${deps.version}\n`)
      return 0
    }
    if (command.kind === 'init') {
      const lines = await runInit(command, deps)
      deps.stderr.write(`${lines.join('\n')}\n`)
      return 0
    }
    if (command.kind === 'app') {
      assertAppTerminal(command, deps)
      debug = command.debug
      return await runApp(deps, { debug })
    }
    if (command.kind === 'setup') {
      debug = command.debug
      return await runApp(deps, { setup: true, debug })
    }
    debug = command.debug
    if (command.kind === 'index') {
      await runIndex(command, deps)
      return 0
    }
    if (command.kind === 'rules') {
      await runRules(command, deps)
      return 0
    }
    if (command.kind === 'prompt') {
      await runPrompt(command, deps)
      return 0
    }
    if (command.kind === 'watch') return await runWatch(command, deps)
    if (command.kind === 'enqueue') return await runEnqueue(command, deps)
    if (command.kind === 'mcp') return await runMcp(deps)
    if (command.kind === 'history') {
      await runHistory(command, deps)
      return 0
    }
    if (command.kind === 'history-prune') {
      await runHistoryPrune(command, deps)
      return 0
    }

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
    const { run: reviewRun, history } = await runManualReview(
      prepared,
      {
        force: command.force,
        dryRun: command.dryRun,
        waitCi: command.waitCi === true,
        options: {
          language: command.language,
          minConfidence: command.minConfidence,
          verify: command.verify,
          investigate: command.investigate,
          ...(command.resolveThreads === undefined
            ? {}
            : { resolveThreads: command.resolveThreads }),
          ...(command.conversation === undefined ? {} : { conversation: command.conversation }),
          ...(command.ci === undefined ? {} : { ci: command.ci }),
          ...(command.skills === undefined ? {} : { skills: command.skills }),
        },
      },
      deps,
      {
        progress: printReviewProgress(deps.stderr, deps.clock),
        reviewed: (reviewed, pullRequest) => printReviewed(deps, command, reviewed, pullRequest),
      },
    )
    printHistorySave(deps, history)
    printRun(deps, command, reviewRun)
    return 0
  } catch (error) {
    const { message, exitCode } = formatError(error, { debug })
    deps.stderr.write(`${message}\n`)
    return exitCode
  }
}

type ReviewCommand = Extract<CliCommand, { kind: 'review' }>

function printReviewed(
  deps: MainDeps,
  command: ReviewCommand,
  reviewed: PullRequestReview,
  pullRequest: PullRequest,
): void {
  const { outcome } = reviewed
  if (outcome.status === 'skipped') {
    deps.stderr.write(`${toTerminalText(skipLine(outcome))}\n`)
    return
  }
  for (const warning of outcome.result.warnings ?? []) {
    deps.stderr.write(`Warning: ${toTerminalText(warning)}\n`)
  }
  const review = reviewed.context.options.review
  const fixFor = blockedFixer({
    pullRequest,
    env: deps.env,
    home: deps.home,
    ...(review === undefined ? {} : { review }),
  })
  for (const line of formatSkillRunLines(outcome.result.passes ?? [], fixFor)) {
    deps.stderr.write(`${line}\n`)
  }
  const investigationLine = formatInvestigationLine(reviewed.investigation)
  if (investigationLine !== undefined) deps.stderr.write(`${investigationLine}\n`)
  if (reviewed.recheck !== undefined) {
    deps.stderr.write(`${formatRecheckMessage(reviewed.recheck)}\n`)
  }
  if (!command.dryRun && command.format === 'markdown') {
    deps.stdout.write(formatReview(pullRequest, outcome.result, messagesFor(reviewed.language)))
  }
}

function printRun(deps: MainDeps, command: ReviewCommand, run: ReviewRun): void {
  const json = command.format === 'json'
  const review = run.status === 'skipped' ? undefined : run.reviewed.context.options.review
  const fixFor = blockedFixer({
    pullRequest: run.pullRequest,
    env: deps.env,
    home: deps.home,
    ...(review === undefined ? {} : { review }),
  })
  if (json) deps.stdout.write(reviewRunJson(run, fixFor))
  const { pullRequest } = run
  if (run.status === 'skipped') {
    deps.stderr.write(`${formatSkipMessage(pullRequest.headSha, run.reason)}\n`)
    return
  }
  const { publication, rendered } = run
  if (publication === undefined || rendered === undefined) return
  const { reviewed } = run
  const messages = messagesFor(reviewed.language)
  const counts =
    run.status === 'reviewed'
      ? {
          comments: rendered.comments.length,
          stillOpen: run.plan.stillOpen.length,
          dismissed: run.plan.dismissed.length,
        }
      : { comments: 0, stillOpen: 0, dismissed: 0 }
  switch (publication.status) {
    case 'dry-run':
      if (!json) {
        deps.stdout.write(
          run.status === 'nothing'
            ? formatGitHubPreview(rendered, messages)
            : `${formatGitHubPreview(rendered, messages)}\n${closeToCutSection(run)}${claimsSection(run)}${formatContextSection(reviewed.context.report)}\n${formatConversationSection(reviewed.conversation)}\n${formatCiSection(reviewed.ci)}\n${formatImpactSection(reviewed.impact, reviewed.impactText)}\n${reviewed.related.status === 'none' ? '' : `${formatRelatedSection(reviewed.related)}\n`}${passesSection(run, fixFor)}${formatInvestigationSection(reviewed.investigation)}`,
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
    case 'published':
      deps.stderr.write(
        `${formatPublishedMessage(publication.url, counts.comments, counts.stillOpen, counts.dismissed)}\n`,
      )
      if (publication.resolved.total > 0) {
        const { resolved, total } = publication.resolved
        deps.stderr.write(`${formatResolvedMessage(resolved, total)}\n`)
      }
      return
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

function closeToCutSection(run: ReviewRun): string {
  if (run.status !== 'reviewed') return ''
  const outcome = run.reviewed.outcome
  if (outcome.status !== 'reviewed') return ''
  const { findings, minConfidence } = outcome.result
  return `${formatCloseToCutSection(findings, minConfidence)}\n`
}

function claimsSection(run: ReviewRun): string {
  if (run.status !== 'reviewed') return ''
  const outcome = run.reviewed.outcome
  return outcome.status === 'reviewed' ? `${formatClaimsSection(outcome.result.claims)}\n` : ''
}

function passesSection(run: ReviewRun, fixFor: BlockedFix): string {
  if (run.status !== 'reviewed') return ''
  const outcome = run.reviewed.outcome
  const passes = outcome.status === 'reviewed' ? outcome.result.passes : undefined
  return passes === undefined ? '' : `${formatPassesSection(passes, fixFor)}\n`
}

function printHistorySave(deps: Pick<MainDeps, 'stderr'>, history: HistorySave): void {
  if (history.status === 'not-saved') {
    deps.stderr.write(
      `Warning: ${toTerminalText(history.error)}. This review is not saved in the history.\n`,
    )
  }
  if (history.status === 'saved' && history.feedbackError !== undefined) {
    deps.stderr.write(
      `Warning: could not save the comments' feedback in the history (${toTerminalText(history.feedbackError)}).\n`,
    )
  }
}

function cliOptions({ model, detached }: ProviderOptions): { model?: string; detached?: boolean } {
  return {
    ...(model === undefined ? {} : { model }),
    ...(detached === undefined ? {} : { detached }),
  }
}
