import type { CliStatus, OllamaStatus, ProviderName, ProviderStatus } from '../providers/types.js'

export interface ProviderCheckers {
  claude: () => Promise<CliStatus>
  codex: () => Promise<CliStatus>
  ollama: () => Promise<OllamaStatus>
}

export type CheckedProvider = ProviderStatus & { chosen: boolean }

export async function checkProviders(
  checkers: ProviderCheckers,
  chosen: ProviderName | null,
): Promise<CheckedProvider[]> {
  const statuses = await Promise.all([
    checkers.claude().catch(() => failedCli('claude')),
    checkers.codex().catch(() => failedCli('codex')),
    checkers.ollama().catch(failedOllama),
  ])
  return statuses.map((status) => ({ ...status, chosen: status.provider === chosen }))
}

function failedCli(provider: CliStatus['provider']): CliStatus {
  return {
    provider,
    install: { state: 'unknown', problem: 'failed' },
    login: { state: 'unknown', problem: 'failed' },
  }
}

function failedOllama(): OllamaStatus {
  return { provider: 'ollama', baseUrl: null, server: { state: 'unknown', problem: 'failed' } }
}
