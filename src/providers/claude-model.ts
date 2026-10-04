import { readFile as readFileFromDisk } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CLAUDE_MODEL = 'opus'

export interface ResolveClaudeModelOptions {
  model?: string
  env: NodeJS.ProcessEnv
  homeDir?: string
  readFile?: (path: string) => Promise<string>
}

export async function resolveClaudeModel(options: ResolveClaudeModelOptions): Promise<string> {
  return (
    nonEmpty(options.model) ??
    nonEmpty(options.env.ANTHROPIC_MODEL) ??
    (await readSettingsModel(options)) ??
    DEFAULT_CLAUDE_MODEL
  )
}

async function readSettingsModel(options: ResolveClaudeModelOptions): Promise<string | undefined> {
  const configDir =
    nonEmpty(options.env.CLAUDE_CONFIG_DIR) ?? join(options.homeDir ?? homedir(), '.claude')
  const readFile = options.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'))
  try {
    const settings: unknown = JSON.parse(await readFile(join(configDir, 'settings.json')))
    return isRecord(settings) && typeof settings.model === 'string'
      ? nonEmpty(settings.model)
      : undefined
  } catch {
    return undefined
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
