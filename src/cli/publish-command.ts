import type { PublishRefusal, SavedPublication } from '../app/publish-saved-review.js'
import { toTerminalText } from '../app/terminal-text.js'
import type { SkipReason } from '../publish/types.js'
import type { IndexFormat } from './args.js'
import { PublishRefusedError, RunNotFoundError } from './errors.js'
import { formatPublishedMessage, formatResolvedMessage } from './format-publication.js'
import { publishedRunJson } from './format-json.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { printHistorySave, savedAsLine } from './print-history-save.js'
import type { TextOutput } from './progress.js'
import { publishSavedRun } from './publish-saved.js'
import type { PublishSavedDeps } from './publish-saved.js'
import { shortSha } from './review-text.js'

export interface PublishCommand {
  id: number
  force: boolean
  format: IndexFormat
}

export interface PublishCommandDeps extends PublishSavedDeps, GitHubTokenDeps {
  stdout: TextOutput
  stderr: TextOutput
}

export async function runPublish(command: PublishCommand, deps: PublishCommandDeps): Promise<void> {
  const { id } = command
  const token = await requireGitHubToken(deps)
  const warning = (message: string) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`)
  const { publication, history, json } = await publishSavedRun(
    id,
    command.force,
    token,
    deps,
    warning,
  )
  if (publication.status === 'refused') throw refusalError(id, publication.refusal)
  if (publication.status === 'skipped') {
    if (command.format === 'json') {
      deps.stdout.write(
        publishedRunJson(
          publication.saved.json,
          { status: 'skipped', reason: publication.reason },
          id,
        ),
      )
    }
    deps.stderr.write(`${skipText(id, publication)}\n`)
    return
  }
  if (command.format === 'json' && json !== undefined) deps.stdout.write(json)
  const reviewed = publication.saved.stored.pullRequest.headSha
  if (publication.headMoved !== undefined) {
    warning(
      `the pull request moved from ${shortSha(reviewed)} to ${shortSha(publication.headMoved)} since run ${id}; the review is on ${shortSha(reviewed)}, the commit the dry run reviewed.`,
    )
  }
  const { plan, rendered, url, resolved } = publication
  deps.stderr.write(
    `${formatPublishedMessage(toTerminalText(url), rendered.comments.length, plan.stillOpen.length, plan.dismissed.length)}\n`,
  )
  if (resolved.total > 0) {
    deps.stderr.write(`${formatResolvedMessage(resolved.resolved, resolved.total)}\n`)
  }
  if (history === undefined) return
  printHistorySave(deps.stderr, history)
  const saved = savedAsLine(history)
  if (saved !== undefined) deps.stderr.write(`${saved}\n`)
}

function skipText(id: number, { saved, reason }: Extract<SavedPublication, { status: 'skipped' }>) {
  const sha = shortSha(saved.stored.pullRequest.headSha)
  return `Not published: ${skipReasonText(sha, reason)}. Use --force to publish run ${id} anyway.`
}

function skipReasonText(sha: string, reason: SkipReason): string {
  switch (reason.kind) {
    case 'same-diff':
      return `the reviewed diff of ${sha} did not change since ${shortSha(reason.since)}, which Phada reviewed`
    case 'closed-or-draft':
      return 'the pull request is closed or a draft'
    default:
      return `Phada already reviewed ${sha}`
  }
}

const RUN_KINDS: Record<string, string> = {
  skipped: 'a skipped review',
  failed: 'a failed review',
  nothing: 'a review with nothing to review',
  'not-published': 'a review that was not published',
  superseded: 'a review of a commit the pull request had moved past',
}

function refusalError(id: number, refusal: PublishRefusal): Error {
  switch (refusal.kind) {
    case 'not-found':
      return new RunNotFoundError(id)
    case 'not-a-dry-run': {
      const what =
        refusal.status === 'published'
          ? `already published${refusal.url === undefined ? '' : ` (${toTerminalText(refusal.url)})`}`
          : `${RUN_KINDS[refusal.status] ?? 'not a dry run'}`
      return new PublishRefusedError(
        `Run ${id} is ${what}: phada publish takes the run of a phada review --dry-run.`,
      )
    }
    case 'nothing-to-publish':
      return new PublishRefusedError(
        `Run ${id} found nothing to review (every changed file was ignored): there is no review to publish.`,
      )
    case 'outdated':
      return new PublishRefusedError(
        `Run ${id} was kept by an older Phada without everything needed to publish it as it was found: review the pull request again.`,
      )
    case 'head-moved':
      return new PublishRefusedError(
        `The pull request moved from ${shortSha(refusal.from)} to ${shortSha(refusal.to)} since run ${id}: review it again, or use --force to publish run ${id} on ${shortSha(refusal.from)}.`,
      )
  }
}
