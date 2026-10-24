import { submitRequest } from '../app/submit-request.js'
import { dataFiles } from '../config/data-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { formatPullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { FetchPullRequestOptions, PullRequestMetadata } from '../github/pull-request.js'
import type { HistoryStore } from '../store/history-store.js'
import type { PublishTarget } from '../watch/types.js'
import type { IndexFormat } from './args.js'
import { MissingGitHubTokenError } from './errors.js'
import { formatSubmitJson, formatSubmitText, NO_WATCH_WARNING } from './format-request.js'
import type { TextOutput } from './progress.js'
import { requireWatchSettings, submitDeps } from './request-wiring.js'

export interface EnqueueCommand {
  ref: PullRequestRef
  publish: PublishTarget
  format: IndexFormat
}

export interface EnqueueCommandDeps {
  env: NodeJS.ProcessEnv
  home: string
  files: LocalFileSystem
  stdout: TextOutput
  stderr: TextOutput
  clock: () => Date
  openHistoryStore: (path: string) => Promise<HistoryStore>
  fetchPullRequestMetadata: (options: FetchPullRequestOptions) => Promise<PullRequestMetadata>
  lockHolder: (path: string) => Promise<number | undefined>
}

export async function runEnqueue(
  command: EnqueueCommand,
  deps: EnqueueCommandDeps,
): Promise<number> {
  const settings = requireWatchSettings(await loadTopLevelUserLayers(deps))
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
  if (!token) throw new MissingGitHubTokenError()
  const files = dataFiles(deps.env, deps.home)
  const { owner, repo, number } = command.ref
  const history = await deps.openHistoryStore(files.history)
  try {
    const result = await submitRequest(
      { repo: `${owner}/${repo}`, number, source: 'enqueue', publish: command.publish },
      submitDeps(history, settings, token, deps),
    )
    const watchRunning = (await deps.lockHolder(files.lock)) !== undefined
    if (command.format === 'json') {
      deps.stdout.write(formatSubmitJson(result, watchRunning))
    } else if (result.status === 'refused') {
      deps.stderr.write(`${formatSubmitText(formatPullRequestRef(command.ref), result)}\n`)
    } else {
      deps.stdout.write(`${formatSubmitText(formatPullRequestRef(command.ref), result)}\n`)
    }
    if (!watchRunning && result.status !== 'refused' && command.format === 'text') {
      deps.stderr.write(`${NO_WATCH_WARNING}\n`)
    }
    return result.status === 'refused' ? 1 : 0
  } finally {
    history.close()
  }
}
