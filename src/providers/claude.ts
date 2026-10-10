import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { MCP_SERVER_NAME, serveMcp } from '../investigation/mcp/mcp-server.js'
import type { McpServer } from '../investigation/mcp/mcp-server.js'
import type { RunCommandResult } from '../process/run-command.js'
import { runCli, snippet, withTempDir } from './cli-run.js'
import type { CliNames } from './cli-run.js'
import { resolveClaudeModel } from './claude-model.js'
import { ProviderError } from './types.js'
import type {
  ExternalToolCall,
  ProviderErrorReason,
  ReviewOutput,
  ReviewPrompt,
  ReviewProvider,
  TokenUsage,
} from './types.js'

const PROVIDER_ID = 'claude-cli'
const NAMES: CliNames = { product: 'Claude Code', short: 'Claude' }
const DEFAULT_COMMAND = 'claude'
const DEFAULT_TIMEOUT_MS = 900_000
const TEMP_DIR_PREFIX = 'phada-claude-'
const INSTRUCTIONS_FILE = 'instructions.md'
const MCP_CONFIG_FILE = 'mcp.json'
const MAX_DETAIL_LENGTH = 500
const MAX_OUTPUT_PREVIEW_LENGTH = 200
const MAX_ATTEMPTS = 3
export const MAX_TOOL_TURNS = 40
const MAX_TURNS_SUBTYPE = 'error_max_turns'
const PHADA_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`
const MCP_TOOL = /^mcp__(.+?)__(.+)$/
const NOT_AUTHENTICATED = /not logged in|\/login|authenticat|api key/i

const ClaudeUsage = z.object({
  input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
})
type ClaudeUsage = z.infer<typeof ClaudeUsage>

const ModelOutputTokens = z.object({ outputTokens: z.number().optional() })

const ClaudeResult = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  usage: ClaudeUsage.optional(),
})
type ClaudeResult = z.infer<typeof ClaudeResult>

const ClaudeAssistant = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(z.object({ type: z.string(), name: z.string().optional() })),
  }),
})

export interface ClaudeCliProviderOptions {
  command?: string
  model?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  homeDir?: string
  userMcpServers?: string[]
}

export function mcpToolPrefix(server: string): string {
  return `mcp__${mcpServerKey(server)}`
}

function mcpServerKey(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, '_')
}

export class ClaudeCliProvider implements ReviewProvider {
  readonly id = PROVIDER_ID
  readonly #command: string
  readonly #model: string | undefined
  readonly #timeoutMs: number
  readonly #env: NodeJS.ProcessEnv
  readonly #homeDir: string | undefined
  readonly #userMcpServers: readonly string[]

  constructor(options: ClaudeCliProviderOptions = {}) {
    this.#command = options.command ?? DEFAULT_COMMAND
    this.#model = options.model
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#env = options.env ?? process.env
    this.#homeDir = options.homeDir
    this.#userMcpServers = options.userMcpServers ?? []
  }

  review(prompt: ReviewPrompt): Promise<ReviewOutput> {
    return withTempDir(TEMP_DIR_PREFIX, async (cwd) => {
      const instructionsPath = join(cwd, INSTRUCTIONS_FILE)
      await writeFile(instructionsPath, prompt.instructions)
      const model = await resolveClaudeModel({
        model: this.#model,
        env: this.#env,
        homeDir: this.#homeDir,
      })
      const server = prompt.tools === undefined ? undefined : await serveMcp(prompt.tools)
      try {
        const mcpArgs = await this.#mcpArgs(cwd, prompt, server)
        const withTools = server !== undefined || this.#userMcpServers.length > 0
        const maxTurns = withTools ? MAX_TOOL_TURNS + MAX_ATTEMPTS : MAX_ATTEMPTS
        const run = await runCli({
          providerId: PROVIDER_ID,
          names: NAMES,
          command: this.#command,
          args: [
            '-p',
            '--output-format',
            'stream-json',
            '--verbose',
            '--tools',
            '',
            ...(this.#userMcpServers.length === 0 ? ['--strict-mcp-config'] : []),
            '--no-session-persistence',
            '--setting-sources=',
            '--disable-slash-commands',
            '--append-system-prompt-file',
            instructionsPath,
            '--max-turns',
            String(maxTurns),
            `--json-schema=${JSON.stringify(prompt.outputSchema)}`,
            `--model=${model}`,
            ...mcpArgs,
          ],
          stdin: prompt.data,
          cwd,
          env: this.#env,
          timeoutMs: this.#timeoutMs,
        })
        const serverNames = new Map(this.#userMcpServers.map((name) => [mcpServerKey(name), name]))
        return toReviewOutput(run, maxTurns, withTools, serverNames)
      } finally {
        await server?.close()
      }
    })
  }

  async #mcpArgs(cwd: string, prompt: ReviewPrompt, server: McpServer | undefined) {
    const allowed = [
      ...(prompt.tools?.definitions ?? []).map(({ name }) => `${PHADA_TOOL_PREFIX}${name}`),
      ...this.#userMcpServers.map(mcpToolPrefix),
    ]
    const args: string[] = []
    if (server !== undefined) {
      const configPath = join(cwd, MCP_CONFIG_FILE)
      const config = { mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', ...server.launch } } }
      await writeFile(configPath, JSON.stringify(config))
      args.push('--mcp-config', configPath)
    }
    if (allowed.length > 0) args.push('--allowedTools', allowed.join(','))
    return args
  }
}

function toReviewOutput(
  run: RunCommandResult,
  maxTurns: number,
  withTools: boolean,
  serverNames: ReadonlyMap<string, string>,
): ReviewOutput {
  const events = run.stdout.split('\n').map(parseJson)
  const parsed = events.findLast((event) => ClaudeResult.safeParse(event).success)
  if (parsed === undefined) throw unreadableOutputError(run)

  const claude = ClaudeResult.parse(parsed)
  if (claude.subtype === MAX_TURNS_SUBTYPE) {
    throw new ProviderError(
      PROVIDER_ID,
      'invalid-output',
      withTools
        ? `Claude did not finish the review within ${maxTurns} turns.`
        : `Claude did not return a valid review in ${MAX_ATTEMPTS} attempts.`,
    )
  }
  if (claude.is_error || claude.result === undefined) throw claudeError(claude)
  if (claude.result.trim() === '') {
    throw new ProviderError(PROVIDER_ID, 'invalid-output', 'Claude returned an empty review.')
  }

  const [model, ...additionalModels] = modelsByOutput(claude.modelUsage ?? {})
  const externalCalls = externalCallsOf(events, serverNames)
  return {
    text: claude.result,
    durationMs: run.durationMs,
    ...(model === undefined ? {} : { model }),
    ...(additionalModels.length === 0 ? {} : { additionalModels }),
    ...(claude.usage === undefined ? {} : { usage: toTokenUsage(claude.usage) }),
    ...(externalCalls.length === 0 ? {} : { externalCalls }),
  }
}

function externalCallsOf(
  events: readonly unknown[],
  serverNames: ReadonlyMap<string, string>,
): ExternalToolCall[] {
  return events.flatMap((event) => {
    const parsed = ClaudeAssistant.safeParse(event)
    if (!parsed.success) return []
    return parsed.data.message.content.flatMap(({ type, name }) => {
      if (type !== 'tool_use' || name === undefined || name.startsWith(PHADA_TOOL_PREFIX)) return []
      const [, server, tool] = MCP_TOOL.exec(name) ?? []
      if (server === undefined || tool === undefined) return []
      return [{ server: serverNames.get(server) ?? server, tool }]
    })
  })
}

function modelsByOutput(modelUsage: Record<string, unknown>): string[] {
  return Object.entries(modelUsage)
    .map(([name, usage], index) => ({ name, outputTokens: outputTokensOf(usage), index }))
    .sort((a, b) => b.outputTokens - a.outputTokens || a.index - b.index)
    .map(({ name }) => name)
}

function outputTokensOf(usage: unknown): number {
  const parsed = ModelOutputTokens.safeParse(usage)
  return parsed.success ? (parsed.data.outputTokens ?? 0) : 0
}

function toTokenUsage(usage: ClaudeUsage): TokenUsage {
  return {
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  }
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
