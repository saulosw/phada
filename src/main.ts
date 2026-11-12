import { assertAppTerminal, runApp } from './cli/app-command.js'
import type { AppCommandDeps } from './cli/app-command.js'
import { parseCliArgs } from './cli/args.js'
import type { CliCommand, CommandOf } from './cli/args.js'
import { formatError } from './cli/format-error.js'
import { runIndex } from './cli/index-command.js'
import { runInit } from './cli/init.js'
import { runPrompt } from './cli/prompt-command.js'
import { runRules } from './cli/rules-command.js'
import { runHistory, runHistoryPrune, runHistoryShow } from './cli/history-command.js'
import { runMisses, runMissesDismiss } from './cli/misses-command.js'
import type { MissesCommandDeps } from './cli/misses-command.js'
import { runMissesReplay } from './cli/misses-replay-command.js'
import { runLessons, runLessonsAccept, runLessonsDiscard } from './cli/lessons-command.js'
import { reviewReplayer } from './cli/miss-replayer.js'
import { runPublish } from './cli/publish-command.js'
import { runLocalReviewCommand, runReviewCommand } from './cli/review-command.js'
import type { ReviewCommandDeps } from './cli/review-command.js'
import { runLocalFix } from './cli/local-fix-command.js'
import { runPullRequestFix } from './cli/pull-request-fix-command.js'
import type { PullRequestFixCommandDeps } from './cli/pull-request-fix-command.js'
import { runReply } from './cli/reply-command.js'
import type { ReplyCommandDeps } from './cli/reply-command.js'
import { assertProviderChoice } from './cli/provider-choice.js'
import type { ProviderOptions } from './cli/provider-choice.js'
export { assertProviderChoice } from './cli/provider-choice.js'
export type { ProviderOptions } from './cli/provider-choice.js'
import { runEnqueue } from './cli/enqueue-command.js'
import { runMcp } from './cli/mcp-command.js'
import type { McpCommandDeps } from './cli/mcp-command.js'
import { runWatch } from './cli/watch-command.js'
import type { WatchCommandDeps } from './cli/watch-command.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import type { ReviewProvider } from './providers/types.js'

export interface MainDeps
  extends
    WatchCommandDeps,
    McpCommandDeps,
    AppCommandDeps,
    MissesCommandDeps,
    PullRequestFixCommandDeps,
    ReplyCommandDeps,
    ReviewCommandDeps {
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

type CommandKind = CliCommand['kind']
type CommandHandler<K extends CommandKind> = (
  command: CommandOf<K>,
  deps: MainDeps,
) => Promise<number>

const COMMANDS: { [K in CommandKind]: CommandHandler<K> } = {
  help: async (command, deps) => printed(deps.stdout, command.text),
  version: async (_command, deps) => printed(deps.stdout, deps.version),
  init: async (command, deps) => printed(deps.stderr, (await runInit(command, deps)).join('\n')),
  app: (command, deps) => runApp(deps, { debug: command.debug }),
  setup: (command, deps) => runApp(deps, { setup: true, debug: command.debug }),
  index: exitZero(runIndex),
  rules: exitZero(runRules),
  prompt: exitZero(runPrompt),
  watch: runWatch,
  enqueue: runEnqueue,
  mcp: (_command, deps) => runMcp(deps),
  history: exitZero(runHistory),
  'history-show': exitZero(runHistoryShow),
  'history-prune': exitZero(runHistoryPrune),
  misses: exitZero(runMisses),
  'misses-dismiss': exitZero(runMissesDismiss),
  'misses-replay': (command, deps) => runMissesReplay(command, deps, reviewReplayer(deps)),
  lessons: exitZero(runLessons),
  'lessons-accept': exitZero(runLessonsAccept),
  'lessons-discard': exitZero(runLessonsDiscard),
  publish: exitZero(runPublish),
  fix: exitZero(runFix),
  reply: runReply,
  review: runReviewCommand,
  'review-local': runLocalReviewCommand,
}

export async function run(argv: readonly string[], deps: MainDeps): Promise<number> {
  let debug = false
  try {
    const command = parseCliArgs(argv)
    if (command.kind === 'app') assertAppTerminal(command, deps)
    debug = 'debug' in command && command.debug
    const handle = COMMANDS[command.kind] as CommandHandler<CommandKind>
    return await handle(command, deps)
  } catch (error) {
    const { message, exitCode } = formatError(error, { debug })
    deps.stderr.write(`${message}\n`)
    return exitCode
  }
}

async function runFix(command: CommandOf<'fix'>, deps: MainDeps): Promise<void> {
  const { ref } = command
  if (ref === undefined) await runLocalFix(command, deps)
  else await runPullRequestFix({ ...command, ref }, deps)
}

function exitZero<C>(
  runCommand: (command: C, deps: MainDeps) => Promise<unknown>,
): (command: C, deps: MainDeps) => Promise<number> {
  return async (command, deps) => {
    await runCommand(command, deps)
    return 0
  }
}

function printed(output: MainDeps['stdout'], text: string): number {
  output.write(`${text}\n`)
  return 0
}

function cliOptions({ model, detached }: ProviderOptions): { model?: string; detached?: boolean } {
  return {
    ...(model === undefined ? {} : { model }),
    ...(detached === undefined ? {} : { detached }),
  }
}
