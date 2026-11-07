import { createInterface } from 'node:readline'
import { dataFiles } from '../config/data-paths.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { handleMcpMessage } from '../investigation/mcp/mcp-server.js'
import type { Toolbox } from '../investigation/toolbox.js'
import { MissingGitHubTokenError } from './errors.js'
import { readGitHubToken } from './github-token.js'
import { runLocalReview } from './local-review-command.js'
import type { LocalReviewRunDeps } from './local-review-command.js'
import { localReviewToolbox } from './local-review-tools.js'
import type { LocalChangesRequest, LocalChangesReview } from './local-review-tools.js'
import { queueToolbox } from './queue-tools.js'
import { submitDeps, watchSettingsOf } from './request-wiring.js'
import type { RequestCommandDeps } from './request-wiring.js'
import { localReviewJson } from './review-wiring.js'

export interface McpCommandDeps extends RequestCommandDeps, LocalReviewRunDeps {
  cwd: string
  stdin: NodeJS.ReadableStream
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export async function runMcp(deps: McpCommandDeps): Promise<number> {
  const layers = await loadTopLevelUserLayers(deps)
  const settings = watchSettingsOf(layers)
  const token = settings === undefined ? undefined : await readGitHubToken(deps)
  const files = dataFiles(deps.env, deps.home)
  const history = await deps.openHistoryStore(files.history)
  const never = new AbortController().signal
  const sleep = (ms: number) => deps.sleep(ms, never)
  const reviewing = new Set<Promise<unknown>>()
  const review = (request: LocalChangesRequest): Promise<LocalChangesReview> => {
    const running = runDetachedLocalReview(request, deps)
    reviewing.add(running)
    void running.catch(() => undefined).finally(() => reviewing.delete(running))
    return running
  }
  const toolbox = joinToolboxes(
    queueToolbox({
      history,
      ...(settings === undefined
        ? {}
        : token
          ? { submit: submitDeps(history, settings, token, deps) }
          : { unavailable: new MissingGitHubTokenError().message }),
      watchRunning: async () => (await deps.lockHolder(files.lock)) !== undefined,
      now: deps.clock,
      sleep,
    }),
    localReviewToolbox({ readToken: () => readGitHubToken(deps), review, now: deps.clock, sleep }),
  )
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
    await Promise.allSettled(reviewing)
  } finally {
    history.close()
  }
  return 0
}

async function runDetachedLocalReview(
  { token, base, uncommitted }: LocalChangesRequest,
  deps: McpCommandDeps,
): Promise<LocalChangesReview> {
  const warnings: string[] = []
  const { review, history } = await runLocalReview(
    {
      cwd: deps.cwd,
      token,
      ...(base === undefined ? {} : { base }),
      uncommitted,
      detached: true,
      options: {},
    },
    deps,
    {
      progress: (event) => {
        if (event.kind === 'warning') warnings.push(event.message)
      },
    },
  )
  return { json: localReviewJson(review), history, warnings }
}

function joinToolboxes(...toolboxes: readonly Toolbox[]): Toolbox {
  const owner = new Map(
    toolboxes.flatMap((toolbox) => toolbox.definitions.map(({ name }) => [name, toolbox] as const)),
  )
  return {
    definitions: toolboxes.flatMap(({ definitions }) => definitions),
    touchedPaths: () => [],
    call: async (name, args, options) =>
      (await owner.get(name)?.call(name, args, options)) ?? {
        text: `Unknown tool ${name}.`,
        isError: true,
      },
  }
}
