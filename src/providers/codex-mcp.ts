import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const StringRecord = z.record(z.string(), z.string())

const StdioTransport = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).nullish(),
  cwd: z.string().nullish(),
  env: StringRecord.nullish(),
  env_vars: z.array(z.unknown()).nullish(),
})

const HttpTransport = z.object({
  type: z.literal('streamable_http'),
  url: z.string(),
  bearer_token_env_var: z.string().nullish(),
  http_headers: StringRecord.nullish(),
  env_http_headers: StringRecord.nullish(),
  http_headers_helper: z.unknown().optional(),
})

export const CodexMcpServerSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  disabled_reason: z.unknown().optional(),
  transport: z.discriminatedUnion('type', [StdioTransport, HttpTransport]),
  enabled_tools: z.array(z.string()).nullish(),
  disabled_tools: z.array(z.string()).nullish(),
  startup_timeout_sec: z.number().nullish(),
  tool_timeout_sec: z.number().nullish(),
  auth_status: z.unknown().optional(),
})
export type CodexMcpServer = z.infer<typeof CodexMcpServerSchema>

export interface CodexNamedServer {
  server: CodexMcpServer
  tools?: string[]
}

export interface CodexMcpRun {
  args: string[]
  env: Record<string, string>
}

export interface NodeLaunch {
  execPath: string
  execArgv: readonly string[]
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/
const LAUNCHER = fileURLToPath(new URL('./mcp-env-launcher.js', import.meta.url))

export async function codexMcpArgs(
  servers: readonly CodexNamedServer[],
  tempDir: string,
  node: NodeLaunch = { execPath: process.execPath, execArgv: process.execArgv },
): Promise<CodexMcpRun> {
  const run: CodexMcpRun = { args: [], env: {} }
  for (const [index, { server, tools }] of servers.entries()) {
    const key = `mcp_servers.${BARE_KEY.test(server.name) ? server.name : JSON.stringify(server.name)}`
    const set = (field: string, value: unknown) => {
      if (value !== null && value !== undefined)
        run.args.push('-c', `${key}.${field}=${tomlValue(value)}`)
    }
    const { transport } = server
    if (transport.type === 'stdio') {
      const env = transport.env ?? {}
      if (Object.keys(env).length === 0) {
        set('command', transport.command)
        set('args', transport.args)
      } else {
        const envFile = join(tempDir, `mcp-env-${index}.json`)
        await writeFile(envFile, JSON.stringify({ env }), { mode: 0o600 })
        set('command', node.execPath)
        set('args', [
          ...node.execArgv,
          LAUNCHER,
          envFile,
          transport.command,
          ...(transport.args ?? []),
        ])
      }
      set('cwd', transport.cwd)
      set('env_vars', transport.env_vars)
    } else {
      set('url', transport.url)
      set('bearer_token_env_var', transport.bearer_token_env_var)
      const headers: Record<string, string> = { ...transport.env_http_headers }
      for (const [header, value] of Object.entries(transport.http_headers ?? {})) {
        const variable = `PHADA_MCP_${Object.keys(run.env).length + 1}`
        run.env[variable] = value
        headers[header] = variable
      }
      set('env_http_headers', Object.keys(headers).length === 0 ? null : headers)
      set('http_headers_helper', transport.http_headers_helper)
    }
    set('startup_timeout_sec', server.startup_timeout_sec)
    set('tool_timeout_sec', server.tool_timeout_sec)
    set('enabled_tools', tools ?? server.enabled_tools)
    set('disabled_tools', server.disabled_tools)
  }
  return run
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`,
    )
    return `{${entries.join(', ')}}`
  }
  return JSON.stringify(value)
}
