import { reviewAndPublish } from './app/review-and-publish.js'
import type { ReviewAndPublishDeps, ReviewRun } from './app/review-and-publish.js'
import { errorMessage } from './app/error-message.js'
import { recordReviewFeedback } from './app/feedback.js'
import { historyRun } from './cli/history-run.js'
import type { RunMeta } from './cli/history-run.js'
import { dataFiles } from './config/data-paths.js'
import type { ConfigLayer } from './config/types.js'
import { historyEnabled } from './config/watch-settings.js'
import type { PullRequestReview } from './app/review-pull-request.js'
import { parseCliArgs } from './cli/args.js'
import type { CliCommand } from './cli/args.js'
import { MissingGitHubTokenError } from './cli/errors.js'
import { formatError } from './cli/format-error.js'
import { formatGitHubPreview } from './cli/format-github.js'
import { formatContextSection } from './cli/format-context.js'
import { formatImpactSection } from './cli/format-impact.js'
import { formatInvestigationLine, formatInvestigationSection } from './cli/format-investigation.js'
import { formatRelatedSection } from './cli/format-related.js'
import { formatPassesSection, formatSkillRunLines } from './cli/format-passes.js'
import type { BlockedFix } from './cli/format-passes.js'
import { blockedFixer } from './cli/blocked-fix.js'
import type { ReviewOutcome } from './review/types.js'
import {
  formatPublishedMessage,
  formatRecheckMessage,
  formatResolvedMessage,
  formatSkipMessage,
  formatWouldResolveMessage,
} from './cli/format-publication.js'
import { formatPullRequestSummary, formatReview } from './cli/format-review.js'
import { messagesFor } from './cli/i18n/messages.js'
import { runIndex } from './cli/index-command.js'
import { runInit } from './cli/init.js'
import { runPrompt } from './cli/prompt-command.js'
import { runRules } from './cli/rules-command.js'
import { runHistory, runHistoryPrune } from './cli/history-command.js'
import {
  mcpNameChecker,
  pullRequestReviewDeps,
  renderReview,
  reviewRunJson,
} from './cli/review-wiring.js'
import { assertProviderChoice } from './cli/provider-choice.js'
import type { ProviderOptions } from './cli/provider-choice.js'
export { assertProviderChoice } from './cli/provider-choice.js'
export type { ProviderOptions } from './cli/provider-choice.js'
import type { Choice } from './cli/review-wiring.js'
import { toTerminalText } from './cli/terminal-text.js'
import { resolveProvider } from './config/merge-config.js'
import { resolveMcp, userMcp } from './config/mcp-servers.js'
import { loadUserLayers } from './config/user-config.js'
import { formatPullRequestRef } from './github/pull-request-ref.js'
import type { PullRequest } from './github/pull-request.js'
import { runEnqueue } from './cli/enqueue-command.js'
import type { EnqueueCommandDeps } from './cli/enqueue-command.js'
import { runWatch } from './cli/watch-command.js'
import type { WatchCommandDeps } from './cli/watch-command.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import type { ReviewProvider } from './providers/types.js'

export interface MainDeps extends WatchCommandDeps, EnqueueCommandDeps {
  cwd: string
  pathSize: (path: string) => Promise<number>
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
    if (command.kind === 'history') {
      await runHistory(command, deps)
      return 0
    }
    if (command.kind === 'history-prune') {
      await runHistoryPrune(command, deps)
      return 0
    }

    const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
    if (!token) throw new MissingGitHubTokenError()
    const { owner, repo } = command.ref
    const userLayers = await loadUserLayers({
      env: deps.env,
      home: deps.home,
      owner,
      repo,
      files: deps.files,
    })
    const choice = resolveProvider({ provider: command.provider, model: command.model }, userLayers)
    const mcp = resolveMcp(userMcp(userLayers), deps.env)
    assertProviderChoice(choice.provider, {
      ...(choice.model === undefined ? {} : { model: choice.model }),
      mcp,
    })
    const mcpNames = await mcpNameChecker(deps)(choice.provider, mcp.names)
    const checked = mcpNames === undefined ? choice : { ...choice, mcpNames }

    deps.onSignal(() => deps.abort(130))
    deps.stderr.write(`Fetching ${formatPullRequestRef(command.ref)}…\n`)
    const startedAt = deps.clock().toISOString()
    const reviewRun = await reviewAndPublish(
      {
        ref: command.ref,
        mode: 'manual',
        force: command.force,
        dryRun: command.dryRun,
        publish: true,
        options: {
          language: command.language,
          minConfidence: command.minConfidence,
          verify: command.verify,
          investigate: command.investigate,
          ...(command.resolveThreads === undefined
            ? {}
            : { resolveThreads: command.resolveThreads }),
          ...(command.skills === undefined ? {} : { skills: command.skills }),
        },
        userLayers,
        mcp,
      },
      reviewAndPublishDeps(deps, token, checked, command),
    )
    await saveRun(deps, userLayers, reviewRun, {
      source: 'manual',
      startedAt,
      finishedAt: deps.clock().toISOString(),
      provider: choice.provider,
      ...(choice.model === undefined ? {} : { model: choice.model }),
    })
    printRun(deps, command, reviewRun)
    return 0
  } catch (error) {
    const { message, exitCode } = formatError(error, { debug })
    deps.stderr.write(`${message}\n`)
    return exitCode
  }
}

type ReviewCommand = Extract<CliCommand, { kind: 'review' }>

function reviewAndPublishDeps(
  deps: MainDeps,
  token: string,
  choice: Choice,
  command: ReviewCommand,
): ReviewAndPublishDeps {
  const target = { ...command.ref, token }
  return {
    fetchPullRequest: (ref) => deps.fetchPullRequest({ ...ref, token }),
    fetchReviewState: (ref) => deps.fetchReviewState({ ...ref, token }),
    reviewDeps: (pullRequest) => pullRequestReviewDeps(deps, target, choice, pullRequest),
    render: renderReview,
    createReview: (pullRequest, rendered) =>
      deps.createReview({
        ...target,
        commitSha: pullRequest.headSha,
        body: rendered.body,
        comments: rendered.comments,
      }),
    compare: (pullRequest, base) =>
      deps.fetchComparison({
        owner: command.ref.owner,
        repo: command.ref.repo,
        token,
        base,
        head: pullRequest.headSha,
      }),
    replyAndResolve: (threadId, body) => deps.replyAndResolve({ token, threadId, body }),
    events: {
      fetched: (pullRequest) => deps.stderr.write(`${formatPullRequestSummary(pullRequest)}\n`),
      reviewed: (reviewed, pullRequest) => printReviewed(deps, command, reviewed, pullRequest),
      publishing: () => deps.stderr.write('Publishing the review…\n'),
      warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
    },
  }
}

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
            : `${formatGitHubPreview(rendered, messages)}\n${formatContextSection(reviewed.context.report)}\n${formatImpactSection(reviewed.impact, reviewed.impactText)}\n${reviewed.related.status === 'none' ? '' : `${formatRelatedSection(reviewed.related)}\n`}${passesSection(run, fixFor)}${formatInvestigationSection(reviewed.investigation)}`,
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

function passesSection(run: ReviewRun, fixFor: BlockedFix): string {
  if (run.status !== 'reviewed') return ''
  const outcome = run.reviewed.outcome
  const passes = outcome.status === 'reviewed' ? outcome.result.passes : undefined
  return passes === undefined ? '' : `${formatPassesSection(passes, fixFor)}\n`
}

async function saveRun(
  deps: MainDeps,
  userLayers: readonly ConfigLayer[],
  run: ReviewRun,
  meta: RunMeta,
): Promise<void> {
  if (!historyEnabled(userLayers)) return
  try {
    const history = await deps.openHistoryStore(dataFiles(deps.env, deps.home).history)
    try {
      const runId = history.addRun(historyRun(run, reviewRunJson(run), meta))
      saveFeedback(deps, () =>
        recordReviewFeedback(history, run, { runId, source: 'manual', now: meta.finishedAt }),
      )
    } finally {
      history.close()
    }
  } catch (error) {
    deps.stderr.write(
      `Warning: ${toTerminalText(errorMessage(error))}. This review is not saved in the history.\n`,
    )
  }
}

function saveFeedback(deps: Pick<MainDeps, 'stderr'>, save: () => void): void {
  try {
    save()
  } catch (error) {
    deps.stderr.write(
      `Warning: could not save the comments' feedback in the history (${toTerminalText(errorMessage(error))}).\n`,
    )
  }
}

function cliOptions({ model, detached }: ProviderOptions): { model?: string; detached?: boolean } {
  return {
    ...(model === undefined ? {} : { model }),
    ...(detached === undefined ? {} : { detached }),
  }
}
