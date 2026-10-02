import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { CommandError, CommandNotFoundError, CommandTimeoutError } from '../process/errors.js'
import { runCommand } from '../process/run-command.js'
import type { RunCommandResult } from '../process/run-command.js'
import { redactSecrets } from './redact-secrets.js'
import { ProviderError } from './types.js'
import type { ProviderErrorReason, ReviewOutput, ReviewProvider } from './types.js'

const PROVIDER_ID = 'claude-cli'
const DEFAULT_COMMAND = 'claude'
const DEFAULT_TIMEOUT_MS = 600_000
const TEMP_DIR_PREFIX = 'phada-claude-'
const MAX_DETAIL_LENGTH = 500
const MAX_OUTPUT_PREVIEW_LENGTH = 200
const BASE_ARGS: readonly string[] = [
  '-p',
  '--output-format',
  'json',
  '--tools',
  '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--setting-sources=',
  '--disable-slash-commands',
]
const GITHUB_TOKEN_KEYS: ReadonlySet<string> = new Set(['GITHUB_TOKEN', 'GH_TOKEN'])
const NOT_AUTHENTICATED = /not logged in|\/login|authenticat|api key/i

const ClaudeResult = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
})
type ClaudeResult = z.infer<typeof ClaudeResult>

export interface ClaudeCliProviderOptions {
  command?: string
  model?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export class ClaudeCliProvider implements ReviewProvider {
  readonly id = PROVIDER_ID
  readonly #command: string
  readonly #args: readonly string[]
  readonly #timeoutMs: number
  readonly #env: NodeJS.ProcessEnv

  constructor(options: ClaudeCliProviderOptions = {}) {
    this.#command = options.command ?? DEFAULT_COMMAND
    this.#args = options.model ? [...BASE_ARGS, '--model', options.model] : BASE_ARGS
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#env = options.env ?? process.env
  }

  async review(prompt: string): Promise<ReviewOutput> {
    const cwd = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX))
    try {
      return toReviewOutput(await this.#run(prompt, cwd))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  async #run(prompt: string, cwd: string): Promise<RunCommandResult> {
    try {
      return await runCommand(this.#command, this.#args, {
        stdin: prompt,
        cwd,
        env: withoutGitHubTokens(this.#env),
        timeoutMs: this.#timeoutMs,
      })
    } catch (error) {
      throw toProviderError(error)
    }
  }
}

function withoutGitHubTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !GITHUB_TOKEN_KEYS.has(key)))
}

function toProviderError(error: unknown): unknown {
  if (error instanceof CommandNotFoundError) {
    return new ProviderError(
      PROVIDER_ID,
      'not-installed',
      `Claude Code was not found (command "${error.command}").`,
      { cause: error },
    )
  }
  if (error instanceof CommandTimeoutError) {
    return new ProviderError(
      PROVIDER_ID,
      'timeout',
      `Claude did not answer within ${error.timeoutMs / 1000}s.`,
      { cause: error },
    )
  }
  if (error instanceof CommandError) {
    return new ProviderError(PROVIDER_ID, 'failed', error.message, { cause: error })
  }
  return error
}

function toReviewOutput(run: RunCommandResult): ReviewOutput {
  const parsed = ClaudeResult.safeParse(parseJson(run.stdout))
  if (!parsed.success) throw unreadableOutputError(run)

  const claude = parsed.data
  if (claude.is_error || claude.result === undefined) throw claudeError(claude)

  const model = Object.keys(claude.modelUsage ?? {})[0]
  const output: ReviewOutput = { text: claude.result, durationMs: run.durationMs }
  return model === undefined ? output : { ...output, model }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function claudeError(claude: ClaudeResult): ProviderError {
  const detail = claude.result ?? claude.subtype
  return new ProviderError(
    PROVIDER_ID,
    reasonFor(detail),
    `Claude returned an error: ${snippet(detail, MAX_DETAIL_LENGTH)}`,
  )
}

function unreadableOutputError({ stdout, stderr, exitCode }: RunCommandResult): ProviderError {
  if (exitCode === 0) {
    return new ProviderError(
      PROVIDER_ID,
      'invalid-output',
      `Claude returned output that is not the expected JSON: ${snippet(stdout, MAX_OUTPUT_PREVIEW_LENGTH)}`,
    )
  }
  const detail = snippet(stderr, MAX_DETAIL_LENGTH)
  return new ProviderError(
    PROVIDER_ID,
    reasonFor(stderr),
    detail === ''
      ? `Claude exited with code ${exitCode}.`
      : `Claude exited with code ${exitCode}: ${detail}`,
  )
}

function reasonFor(detail: string): ProviderErrorReason {
  return NOT_AUTHENTICATED.test(detail) ? 'not-authenticated' : 'failed'
}

function snippet(text: string, maxLength: number): string {
  return redactSecrets(text).trim().slice(0, maxLength)
}
