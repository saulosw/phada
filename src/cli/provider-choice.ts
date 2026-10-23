import type { ResolvedMcp } from '../config/mcp-servers.js'
import { UsageError } from './errors.js'
import type { CheckedNames } from './mcp-names.js'

const PROVIDERS = ['claude', 'codex', 'ollama'] as const

export interface ProviderOptions {
  model?: string
  mcpNames?: CheckedNames
  detached?: boolean
}

export function assertProviderChoice(
  name: string,
  options: { model?: string; mcp?: ResolvedMcp },
  source: 'flags' | 'config' = 'flags',
): void {
  if (!(PROVIDERS as readonly string[]).includes(name)) {
    throw new UsageError(`Unknown provider "${name}". Available: ${PROVIDERS.join(', ')}.`)
  }
  if (name === 'ollama' && options.model === undefined) {
    const fix =
      source === 'flags'
        ? '--provider ollama needs --model'
        : 'provider ollama needs a model: set model: in your config'
    throw new UsageError(
      `${fix}, e.g. qwen2.5-coder:7b, llama3.1:8b or gpt-oss:120b-cloud (see "ollama list").`,
    )
  }
  const [named] = options.mcp?.names ?? []
  if (name === 'ollama' && named !== undefined) {
    throw new UsageError(
      `MCP server ${named.name}: Ollama has no MCP servers of its own; declare it with command or url in your config.`,
    )
  }
}

export function providerRunsSkills(provider: string): boolean {
  return provider === 'claude'
}
