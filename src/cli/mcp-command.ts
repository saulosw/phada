import { createInterface } from 'node:readline'
import { dataFiles } from '../config/data-paths.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { handleMcpMessage } from '../investigation/mcp/mcp-server.js'
import type { EnqueueCommandDeps } from './enqueue-command.js'
import { MissingGitHubTokenError } from './errors.js'
import { queueToolbox } from './queue-tools.js'
import { submitDeps, watchSettingsOf } from './request-wiring.js'

export interface McpCommandDeps extends EnqueueCommandDeps {
  stdin: NodeJS.ReadableStream
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export async function runMcp(deps: McpCommandDeps): Promise<number> {
  const layers = await loadTopLevelUserLayers(deps)
  const settings = watchSettingsOf(layers)
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
  const files = dataFiles(deps.env, deps.home)
  const history = await deps.openHistoryStore(files.history)
  const never = new AbortController().signal
  const toolbox = queueToolbox({
    history,
    ...(settings === undefined
      ? {}
      : token
        ? { submit: submitDeps(history, settings, token, deps) }
        : { unavailable: new MissingGitHubTokenError().message }),
    watchRunning: async () => (await deps.lockHolder(files.lock)) !== undefined,
    now: deps.clock,
    sleep: (ms) => deps.sleep(ms, never),
  })
  const pending = new Set<Promise<void>>()
  try {
    for await (const line of createInterface({ input: deps.stdin, crlfDelay: Infinity })) {
      if (line.trim() === '') continue
      const answered = handleMcpMessage(toolbox, line).then((response) => {
        if (response !== undefined) deps.stdout.write(`${response}\n`)
      })
      pending.add(answered)
      void answered.finally(() => pending.delete(answered))
    }
    await Promise.all(pending)
  } finally {
    history.close()
  }
  return 0
}
