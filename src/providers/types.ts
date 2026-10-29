import type { Toolbox } from '../investigation/toolbox.js'

export type JsonSchema = Readonly<Record<string, unknown>>

export interface ReviewPrompt {
  instructions: string
  data: string
  outputSchema: JsonSchema
  tools?: Toolbox
  signal?: AbortSignal
}

export type NativeSkillRef =
  | { kind: 'plugin'; pluginDir: string; invoke: string }
  | { kind: 'file'; fileKind: 'skill' | 'command'; path: string; dir: string; name: string }
  | { kind: 'builtin'; invoke: string }

export interface ExternalToolCall {
  server: string
  tool: string
}

export interface TokenUsage {
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
}

export interface ReviewOutput {
  text: string
  durationMs: number
  model?: string
  additionalModels?: string[]
  usage?: TokenUsage
  externalCalls?: ExternalToolCall[]
  warnings?: string[]
  withoutTools?: true
}

export type CommandPolicy = 'read-only' | 'all' | readonly string[]

export interface BlockedCommand {
  tool: string
  input: string
}

export interface SkillRunRequest {
  skill: NativeSkillRef
  arguments: string
  context: string
  cwd: string
  readDirs: readonly string[]
  commands: CommandPolicy
  env: Readonly<Record<string, string>>
  tools?: Toolbox
  timeoutMs: number
  maxTurns: number
}

export interface SkillRunOutput {
  text: string
  durationMs: number
  model?: string
  usage?: TokenUsage
  blocked: BlockedCommand[]
  externalCalls?: ExternalToolCall[]
  warnings?: string[]
}

export interface ReviewProvider {
  readonly id: string
  review(prompt: ReviewPrompt): Promise<ReviewOutput>
  runSkill?(request: SkillRunRequest): Promise<SkillRunOutput>
}

export type ProviderErrorReason =
  | 'not-installed'
  | 'not-authenticated'
  | 'timeout'
  | 'failed'
  | 'invalid-output'
  | 'prompt-too-large'
  | 'usage-limit'

export class ProviderError extends Error {
  override readonly name = 'ProviderError'
  readonly providerId: string
  readonly reason: ProviderErrorReason

  constructor(
    providerId: string,
    reason: ProviderErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.providerId = providerId
    this.reason = reason
  }
}

export type ProviderName = 'claude' | 'codex' | 'ollama'

export type StatusProblem = 'timeout' | 'failed' | 'unexpected-output' | 'invalid-host'

export type CliInstall =
  | { state: 'installed'; version: string | null }
  | { state: 'missing' }
  | { state: 'unknown'; problem: StatusProblem }

export type CliLogin =
  | { state: 'logged-in'; method: string | null }
  | { state: 'logged-out' }
  | { state: 'unknown'; problem: StatusProblem | 'not-installed' }

export interface CliStatus {
  provider: 'claude' | 'codex'
  install: CliInstall
  login: CliLogin
}

export type OllamaServer =
  | { state: 'running'; version: string | null; models: string[] }
  | { state: 'stopped' }
  | { state: 'unknown'; problem: StatusProblem }

export interface OllamaStatus {
  provider: 'ollama'
  baseUrl: string | null
  server: OllamaServer
}

export type ProviderStatus = CliStatus | OllamaStatus

export interface OllamaPullProgress {
  status: string
  completed: number | null
  total: number | null
}

export type OllamaPullResult =
  | { kind: 'pulled' }
  | { kind: 'cancelled' }
  | { kind: 'stopped' }
  | { kind: 'failed'; message: string | null }
