import { UsageError } from './errors.js'

const PROVIDERS = ['claude', 'codex', 'ollama'] as const

export interface ProviderOptions {
  model?: string
  userMcpServers?: string[]
  detached?: boolean
}

export function assertProviderChoice(
  name: string,
  options: { model?: string; userMcpServers?: readonly string[] },
): void {
  if (!(PROVIDERS as readonly string[]).includes(name)) {
    throw new UsageError(`Unknown provider "${name}". Available: ${PROVIDERS.join(', ')}.`)
  }
  if (name === 'ollama' && options.model === undefined) {
    throw new UsageError(
      '--provider ollama needs --model, e.g. qwen2.5-coder:7b, llama3.1:8b or gpt-oss:120b-cloud (see "ollama list").',
    )
  }
  if ((options.userMcpServers?.length ?? 0) > 0 && name !== 'claude') {
    throw new UsageError('mcp in your config works only with --provider claude for now.')
  }
}
