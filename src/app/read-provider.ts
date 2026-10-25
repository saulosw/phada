import { userMcp } from '../config/mcp-servers.js'
import { resolveProvider } from '../config/merge-config.js'
import type { ConfigLayer } from '../config/types.js'
import type { ProviderName } from '../providers/types.js'
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

export interface ProviderReport {
  choice: ProviderChoiceView
  providers: CheckedProvider[]
}

export interface NextStep {
  kind: 'install' | 'login' | 'serve' | 'pull'
  command: string
}

export interface ProviderConfigInput {
  layers: readonly ConfigLayer[]
  configPath: string
}

const PROVIDERS: readonly ProviderName[] = ['claude', 'codex', 'ollama']
const INSTALL: Readonly<Record<'claude' | 'codex', string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
}
const LOGIN: Readonly<Record<'claude' | 'codex', string>> = {
  claude: 'claude auth login',
  codex: 'codex login',
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
  return { choice, providers: await checkProviders(input.checkers, choice.provider) }
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
  if (status.login.state === 'logged-out') return { kind: 'login', command: LOGIN[status.provider] }
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

function hasModel(models: readonly string[], model: string): boolean {
  return models.some((name) => name === model || name === `${model}:latest`)
}
