import { replyToThreads } from '../app/reply-to-threads.js'
import { reportProgress } from '../app/review-progress.js'
import { toTerminalText } from '../app/terminal-text.js'
import { dataFiles } from '../config/data-paths.js'
import { historyEnabled } from '../config/watch-settings.js'
import { formatPullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { ReviewProvider } from '../providers/types.js'
import type { HistoryStore } from '../store/history-store.js'
import type { StopSignal } from '../tui/open-app.js'
import type { IndexFormat } from './args.js'
import { UsageError } from './errors.js'
import { formatReplyRun, replyRunJson } from './format-reply.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { existingHistory } from './history-access.js'
import { printReviewProgress } from './print-review-progress.js'
import type { TextOutput } from './progress.js'
import { modelOption } from './provider-choice.js'
import type { ProviderOptions } from './provider-choice.js'
import { threadReplyDeps, threadReplySetup } from './reply-wiring.js'
import type { ThreadReplyDeps } from './reply-wiring.js'

export interface ReplyCommand {
  ref: PullRequestRef
  dryRun: boolean
  format: IndexFormat
}

export interface ReplyCommandDeps extends GitHubTokenDeps, ThreadReplyDeps {
  stdout: TextOutput
  stderr: TextOutput
  onSignal: (handler: (signal?: StopSignal) => void) => void
  abort: (code: number) => void
  openHistoryStore: (path: string) => Promise<HistoryStore>
  createProvider: (name: string, options: ProviderOptions) => ReviewProvider
}

export async function runReply(command: ReplyCommand, deps: ReplyCommandDeps): Promise<number> {
  const { ref } = command
  const name = formatPullRequestRef(ref)
  const token = await requireGitHubToken(deps)
  deps.stderr.write(`Reading the threads of Phada on ${name}…\n`)
  const pullRequest = await deps.fetchPullRequestMetadata({ ...ref, token })
  if (pullRequest.state !== 'open') {
    throw new UsageError(`${name} is closed: phada reply answers on open pull requests only.`)
  }
  const { userLayers, choice, language } = await threadReplySetup(ref, pullRequest, token, deps)
  const provider = reportProgress(
    deps.createProvider(choice.provider, modelOption(choice)),
    'reply',
    printReviewProgress(deps.stderr, deps.clock),
  )
  const history = historyEnabled(userLayers) ? await openHistory(command, deps) : undefined
  deps.onSignal(() => deps.abort(130))
  const replyDeps = threadReplyDeps(
    {
      ref,
      token,
      pullRequest,
      provider,
      history,
      events: {
        warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
      },
    },
    deps,
  )
  try {
    const run = await replyToThreads(
      {
        ref,
        mode: 'auto',
        dryRun: command.dryRun,
        source: 'manual',
        ...(language === undefined ? {} : { language }),
      },
      replyDeps,
    )
    deps.stdout.write(
      command.format === 'json'
        ? replyRunJson(run, command.dryRun)
        : formatReplyRun(run, command.dryRun),
    )
    if (!run.limited) return 0
    deps.stderr.write(
      'phada: The AI usage limit stopped phada reply; the threads not answered are answered on the next run.\n',
    )
    return 1
  } finally {
    history?.close()
  }
}

async function openHistory(
  command: ReplyCommand,
  deps: ReplyCommandDeps,
): Promise<HistoryStore | undefined> {
  const path = dataFiles(deps.env, deps.home).history
  return command.dryRun ? existingHistory(path, deps) : deps.openHistoryStore(path)
}
