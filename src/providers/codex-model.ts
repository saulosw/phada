import { readFile as readFileFromDisk } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TABLE_HEADER = /^\s*\[/
const TOP_LEVEL_MODEL = /^\s*model\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/

export interface ResolveCodexModelOptions {
  model?: string
  env: NodeJS.ProcessEnv
  homeDir?: string
  readFile?: (path: string) => Promise<string>
}

export async function resolveCodexModel(
  options: ResolveCodexModelOptions,
): Promise<string | undefined> {
  return nonEmpty(options.model) ?? (await readConfigModel(options))
}

async function readConfigModel(options: ResolveCodexModelOptions): Promise<string | undefined> {
  const codexHome = nonEmpty(options.env.CODEX_HOME) ?? join(options.homeDir ?? homedir(), '.codex')
  const readFile = options.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'))
  try {
    return topLevelModel(await readFile(join(codexHome, 'config.toml')))
  } catch {
    return undefined
  }
}

function topLevelModel(toml: string): string | undefined {
  for (const line of toml.split(/\r?\n/)) {
    if (TABLE_HEADER.test(line)) return undefined
    const match = TOP_LEVEL_MODEL.exec(line)
    if (match !== null) return nonEmpty(match[1] ?? match[2])
  }
  return undefined
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
