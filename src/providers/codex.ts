import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { RunCommandResult } from '../process/run-command.js'
import { runCli, snippet, withTempDir } from './cli-run.js'
import type { CliNames } from './cli-run.js'
import { resolveCodexModel } from './codex-model.js'
import { ProviderError } from './types.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider, TokenUsage } from './types.js'

const PROVIDER_ID = 'codex-cli'
const NAMES: CliNames = { product: 'Codex CLI', short: 'Codex' }
const DEFAULT_COMMAND = 'codex'
const DEFAULT_TIMEOUT_MS = 600_000
const TEMP_DIR_PREFIX = 'phada-codex-'
const INSTRUCTIONS_FILE = 'instructions.md'
const OUTPUT_FILE = 'last-message.txt'
const OUTPUT_SCHEMA_FILE = 'output-schema.json'
const MAX_DETAIL_LENGTH = 500
const DISABLED_FEATURES: readonly string[] = [
  'apps',
  'plugins',
  'shell_tool',
  'unified_exec',
  'multi_agent',
  'image_generation',
  'goals',
  'sleep_tool',
  'view_image',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'tool_suggest',
  'skill_search',
  'hooks',
]
const BASE_ARGS: readonly string[] = [
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '-s',
  'read-only',
  '--ignore-user-config',
  ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  '-c',
  'web_search="disabled"',
  '--json',
]
const NOT_AUTHENTICATED = /401 Unauthorized|missing bearer|not logged in|codex login/i

const CodexEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.completed'),
    usage: z.object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    }),
  }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
type CodexEvent = z.infer<typeof CodexEvent>

export interface CodexCliProviderOptions {
  command?: string
  model?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

export class CodexCliProvider implements ReviewProvider {
  readonly id = PROVIDER_ID
  readonly #command: string
  readonly #model: string | undefined
  readonly #timeoutMs: number
  readonly #env: NodeJS.ProcessEnv
  readonly #homeDir: string | undefined

  constructor(options: CodexCliProviderOptions = {}) {
    this.#command = options.command ?? DEFAULT_COMMAND
    this.#model = options.model
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#env = options.env ?? process.env
    this.#homeDir = options.homeDir
  }

  review(prompt: ReviewPrompt): Promise<ReviewOutput> {
    return withTempDir(TEMP_DIR_PREFIX, async (cwd) => {
      const instructionsPath = join(cwd, INSTRUCTIONS_FILE)
      const outputPath = join(cwd, OUTPUT_FILE)
      const schemaPath = join(cwd, OUTPUT_SCHEMA_FILE)
      await writeFile(instructionsPath, prompt.instructions)
      await writeFile(schemaPath, JSON.stringify(prompt.outputSchema))
      const model = await resolveCodexModel({
        model: this.#model,
        env: this.#env,
        homeDir: this.#homeDir,
      })
      const run = await runCli({
        providerId: PROVIDER_ID,
        names: NAMES,
        command: this.#command,
        args: codexArgs({ instructionsPath, schemaPath, outputPath, model }),
        stdin: prompt.data,
        cwd,
        env: this.#env,
        timeoutMs: this.#timeoutMs,
      })
      const events = parseEvents(run.stdout)
      if (run.exitCode !== 0) throw exitError(run, events)
      return toReviewOutput(run, events, model, await readOutput(outputPath))
    })
  }
}

interface CodexArgsOptions {
  instructionsPath: string
  schemaPath: string
  outputPath: string
  model: string | undefined
}

function codexArgs({ instructionsPath, schemaPath, outputPath, model }: CodexArgsOptions) {
  return [
    ...BASE_ARGS,
    '-c',
    `model_instructions_file=${JSON.stringify(instructionsPath)}`,
    '--output-schema',
    schemaPath,
    '-o',
    outputPath,
    ...(model === undefined ? [] : [`--model=${model}`]),
    '-',
  ]
}

async function readOutput(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function toReviewOutput(
  run: RunCommandResult,
  events: readonly CodexEvent[],
  model: string | undefined,
  text: string | undefined,
): ReviewOutput {
  if (text === undefined || text.trim() === '') {
    throw new ProviderError(PROVIDER_ID, 'invalid-output', noOutputMessage(events))
  }
  const usage = lastTurnUsage(events)
  return {
    text,
    durationMs: run.durationMs,
    ...(model === undefined ? {} : { model }),
    ...(usage === undefined ? {} : { usage }),
  }
}

function noOutputMessage(events: readonly CodexEvent[]): string {
  const detail = errorMessages(events).at(-1)
  return detail === undefined
    ? 'Codex produced no final message.'
    : `Codex produced no final message: ${snippet(detail, MAX_DETAIL_LENGTH)}`
}

function parseEvents(stdout: string): CodexEvent[] {
  return stdout.split('\n').flatMap((line) => {
    const parsed = CodexEvent.safeParse(parseJson(line))
    return parsed.success ? [parsed.data] : []
  })
}

function lastTurnUsage(events: readonly CodexEvent[]): TokenUsage | undefined {
  const turn = events.findLast((event) => event.type === 'turn.completed')
  return turn === undefined
    ? undefined
    : { inputTokens: turn.usage.input_tokens ?? 0, outputTokens: turn.usage.output_tokens ?? 0 }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function exitError({ stderr, exitCode }: RunCommandResult, events: readonly CodexEvent[]) {
  const lastStderrLine = stderr.trim().split('\n').at(-1) ?? ''
  const lastMessage = errorMessages(events).at(-1) ?? lastStderrLine
  const detail = snippet(lastMessage, MAX_DETAIL_LENGTH)
  const reason = NOT_AUTHENTICATED.test(lastMessage) ? 'not-authenticated' : 'failed'
  return new ProviderError(
    PROVIDER_ID,
    reason,
    detail === ''
      ? `Codex exited with code ${exitCode}.`
      : `Codex exited with code ${exitCode}: ${detail}`,
  )
}

function errorMessages(events: readonly CodexEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'error') return [event.message]
    if (event.type === 'turn.failed') return [event.error.message]
    return []
  })
}
