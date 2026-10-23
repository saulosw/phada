import type { McpNameEntry } from '../config/mcp-servers.js'
import { CommandNotFoundError } from '../process/errors.js'
import { runCommand } from '../process/run-command.js'
import { withoutGitHubTokens, withTempDir } from '../providers/cli-run.js'
import { CodexMcpServerSchema } from '../providers/codex-mcp.js'
import type { CodexNamedServer } from '../providers/codex-mcp.js'
import { UsageError } from './errors.js'

export type CheckedNames =
  { provider: 'claude'; names: McpNameEntry[] } | { provider: 'codex'; names: CodexNamedServer[] }

export interface CheckMcpNamesDeps {
  env: NodeJS.ProcessEnv
  run?: typeof runCommand
  claudeCommand?: string
  codexCommand?: string
}

const CLAUDE_TIMEOUT_MS = 60_000
const CODEX_TIMEOUT_MS = 30_000
const CONFIGURED = /Configured servers:.*/

export async function checkMcpNames(
  provider: string,
  names: readonly McpNameEntry[],
  deps: CheckMcpNamesDeps,
): Promise<CheckedNames | undefined> {
  if (names.length === 0) return undefined
  const run = deps.run ?? runCommand
  const env = withoutGitHubTokens(deps.env)
  if (provider === 'claude') {
    const command = deps.claudeCommand ?? 'claude'
    await withTempDir('phada-mcp-check-', async (cwd) => {
      for (const { name } of names) {
        const result = await installed('Claude Code', command, name, () =>
          run(command, ['mcp', 'get', name], { cwd, env, timeoutMs: CLAUDE_TIMEOUT_MS }),
        )
        if (result.exitCode === 0) continue
        const configured = CONFIGURED.exec(`${result.stdout}\n${result.stderr}`)?.[0]
        throw new UsageError(
          `Claude Code has no MCP server named "${name}"${configured === undefined ? '.' : `. ${configured}`}`,
        )
      }
    })
    return { provider, names: [...names] }
  }
  if (provider === 'codex') {
    const command = deps.codexCommand ?? 'codex'
    const servers: CodexNamedServer[] = []
    for (const { name, tools } of names) {
      const result = await installed('Codex CLI', command, name, () =>
        run(command, ['mcp', 'get', name, '--json'], { env, timeoutMs: CODEX_TIMEOUT_MS }),
      )
      if (result.exitCode !== 0) {
        throw new UsageError(`Codex has no MCP server named "${name}" (see "codex mcp list").`)
      }
      const parsed = CodexMcpServerSchema.safeParse(parseJson(result.stdout))
      if (!parsed.success)
        throw new Error(`Codex printed an unexpected answer for MCP server ${name}.`)
      if (!parsed.data.enabled)
        throw new UsageError(`MCP server ${name} is disabled in your Codex config.`)
      servers.push(tools === undefined ? { server: parsed.data } : { server: parsed.data, tools })
    }
    return { provider, names: servers }
  }
  return undefined
}

async function installed<T>(
  product: string,
  command: string,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      throw new UsageError(
        `${product} was not found (command "${command}"); it is needed to read MCP server ${name}.`,
      )
    }
    throw error
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
