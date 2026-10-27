import type { ReportedProvider } from '../app/read-provider.js'

export const PROVIDER_NAMES: Readonly<Record<ReportedProvider['provider'], string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  ollama: 'Ollama',
}
