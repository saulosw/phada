import { userMcp } from '../config/mcp-servers.js'
import { resolveProvider } from '../config/merge-config.js'
import type { ConfigLayer } from '../config/types.js'
import type { OllamaPullProgress, OllamaPullResult, ProviderName } from '../providers/types.js'
import { checkProviders } from './check-providers.js'
import type { CheckedProvider, ProviderCheckers } from './check-providers.js'

export type ChoiceOrigin = { kind: 'user-config'; path: string } | { kind: 'default' }

export interface ProviderChoiceView {
  provider: ProviderName
  model: string | null
  origin: ChoiceOrigin
}

export type McpServerKind = 'named' | 'command' | 'http'

export interface McpServerView {
  name: string
  kind: McpServerKind
  tools: string[]
  description: string | null
}

export interface ProviderSetup {
  choice: ProviderChoiceView
  mcp: McpServerView[]
}

export type ReportedProvider = CheckedProvider & { next: NextStep | null }

export interface ProviderChecks {
  providers: ReportedProvider[]
}

export interface ProviderReport extends ProviderChecks {
  choice: ProviderChoiceView
}

export interface NextStep {
  kind: 'install' | 'login' | 'serve' | 'pull'
  command: string
}

export type { OllamaPullProgress, OllamaPullResult }

export interface ModelPullOptions {
  signal: AbortSignal
  onProgress(progress: OllamaPullProgress): void
}

export const SUGGESTED_OLLAMA_MODEL = { name: 'qwen2.5-coder:7b', bytes: 4_683_087_332 }

export interface ProviderConfigInput {
  layers: readonly ConfigLayer[]
  configPath: string
}

const PROVIDERS: readonly ProviderName[] = ['claude', 'codex', 'ollama']
const INSTALL: Readonly<Record<'claude' | 'codex', string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
}
const LOGIN: Readonly<Record<'claude' | 'codex', LoginCommand>> = {
  claude: { command: 'claude', args: ['auth', 'login'] },
  codex: { command: 'codex', args: ['login'] },
}

export interface LoginCommand {
  command: string
  args: readonly string[]
}

export function loginCommand(provider: 'claude' | 'codex'): LoginCommand {
  return LOGIN[provider]
}

export function providerSetup(input: ProviderConfigInput): ProviderSetup {
  return {
    choice: providerChoice(input),
    mcp: userMcp(input.layers).map((entry) =>
      typeof entry === 'string'
        ? { name: entry, kind: 'named', tools: [], description: null }
        : {
            name: entry.name,
            kind:
              entry.command !== undefined ? 'command' : entry.url !== undefined ? 'http' : 'named',
            tools: entry.tools ?? [],
            description: entry.description ?? null,
          },
    ),
  }
}

export async function readProviders(
  input: ProviderConfigInput & { checkers: ProviderCheckers },
): Promise<ProviderReport> {
  const choice = providerChoice(input)
  const providers = await checkProviders(input.checkers, choice.provider)
  return {
    choice,
    providers: providers.map((status) => ({
      ...status,
      next: nextStep(status, choice.model) ?? null,
    })),
  }
}

export async function readProviderChecks(checkers: ProviderCheckers): Promise<ProviderChecks> {
  const providers = await checkProviders(checkers, null)
  return {
    providers: providers.map((status) => ({ ...status, next: nextStep(status, null) ?? null })),
  }
}

export function nextStep(status: CheckedProvider, model: string | null): NextStep | undefined {
  if (status.provider === 'ollama') {
    const { server } = status
    if (server.state === 'stopped') return { kind: 'serve', command: 'ollama serve' }
    if (server.state !== 'running') return undefined
    if (server.models.length === 0) {
      return {
        kind: 'pull',
        command: `ollama pull ${status.chosen && model !== null ? model : '<model>'}`,
      }
    }
    if (status.chosen && model !== null && !hasModel(server.models, model)) {
      return { kind: 'pull', command: `ollama pull ${model}` }
    }
    return undefined
  }
  if (status.install.state === 'missing') {
    return { kind: 'install', command: INSTALL[status.provider] }
  }
  if (status.login.state === 'logged-out') {
    const { command, args } = LOGIN[status.provider]
    return { kind: 'login', command: [command, ...args].join(' ') }
  }
  return undefined
}

function providerChoice({ layers, configPath }: ProviderConfigInput): ProviderChoiceView {
  const { provider, model } = resolveProvider({}, layers)
  const configured = layers.some(
    ({ config }) => config.provider !== undefined || config.model !== undefined,
  )
  return {
    provider: PROVIDERS.find((name) => name === provider) ?? 'claude',
    model: model ?? null,
    origin: configured ? { kind: 'user-config', path: configPath } : { kind: 'default' },
  }
}

export function hasModel(models: readonly string[], model: string): boolean {
  return models.some((name) => name === model || name === `${model}:latest`)
}
