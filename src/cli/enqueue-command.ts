import { submitRequest } from '../app/submit-request.js'
import { dataFiles } from '../config/data-paths.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { formatPullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PublishTarget } from '../watch/types.js'
import type { IndexFormat } from './args.js'
import { requireGitHubToken } from './github-token.js'
import { formatSubmitJson, formatSubmitText, NO_WATCH_WARNING } from './format-request.js'
import { requireWatchSettings, submitDeps } from './request-wiring.js'
import type { RequestCommandDeps } from './request-wiring.js'

export interface EnqueueCommand {
  ref: PullRequestRef
  publish: PublishTarget
  format: IndexFormat
}

export async function runEnqueue(
  command: EnqueueCommand,
  deps: RequestCommandDeps,
): Promise<number> {
  const settings = requireWatchSettings(await loadTopLevelUserLayers(deps))
  const token = await requireGitHubToken(deps)
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
