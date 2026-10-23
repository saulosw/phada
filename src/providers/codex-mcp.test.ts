import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexMcpArgs, CodexMcpServerSchema } from './codex-mcp.js'
import type { CodexMcpServer } from './codex-mcp.js'

const API_KEY = `AIza${'k'.repeat(35)}`
const ENV_TOKEN = `ghp_${'t'.repeat(36)}`
const NODE = { execPath: '/usr/bin/node', execArgv: ['--no-warnings'] }

let temp: string

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'phada-codex-mcp-'))
})

afterEach(() => {
  rmSync(temp, { recursive: true, force: true })
})

function server(
  fields: Partial<CodexMcpServer> & Pick<CodexMcpServer, 'transport'>,
): CodexMcpServer {
  return CodexMcpServerSchema.parse({
    name: 'docs',
    enabled: true,
    disabled_reason: null,
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'unsupported',
    ...fields,
  })
}

const settings = (args: readonly string[]) =>
  args.flatMap((arg, index) => (args[index - 1] === '-c' ? [arg] : []))

describe('codexMcpArgs', () => {
  it('copies a stdio server without env as it is', async () => {
    const { args, env } = await codexMcpArgs(
      [
        {
          server: server({
            name: 'files',
            transport: {
              type: 'stdio',
              command: 'npx',
              args: ['-y', '@acme/files'],
              cwd: '/srv',
              env: null,
              env_vars: ['HOME'],
            },
            startup_timeout_sec: 20,
          }),
        },
      ],
      temp,
      NODE,
    )

    expect(settings(args)).toEqual([
      'mcp_servers.files.command="npx"',
      'mcp_servers.files.args=["-y","@acme/files"]',
      'mcp_servers.files.cwd="/srv"',
      'mcp_servers.files.env_vars=["HOME"]',
      'mcp_servers.files.startup_timeout_sec=20',
    ])
    expect(args.filter((arg) => arg === '-c')).toHaveLength(5)
    expect(env).toEqual({})
  })

  it('runs a stdio server with env through the launcher and a private env file', async () => {
    const { args } = await codexMcpArgs(
      [
        {
          server: server({
            name: 'gh',
            transport: {
              type: 'stdio',
              command: 'gh-mcp',
              args: ['serve'],
              cwd: null,
              env: { GITHUB_PAT: ENV_TOKEN },
              env_vars: null,
            },
          }),
        },
      ],
      temp,
      NODE,
    )

    const values = settings(args)
    expect(values[0]).toBe('mcp_servers.gh.command="/usr/bin/node"')
    const launch = JSON.parse(values[1]?.slice('mcp_servers.gh.args='.length) ?? '[]') as string[]
    expect(launch[0]).toBe('--no-warnings')
    expect(launch[1]).toMatch(/mcp-env-launcher\.js$/)
    expect(launch.slice(3)).toEqual(['gh-mcp', 'serve'])
    const envFile = launch[2] ?? ''
    expect(envFile.startsWith(temp)).toBe(true)
    expect(JSON.parse(readFileSync(envFile, 'utf8'))).toEqual({ env: { GITHUB_PAT: ENV_TOKEN } })
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
  })

  it('moves literal headers of an HTTP server to generated environment variables', async () => {
    const { args, env } = await codexMcpArgs(
      [
        {
          server: server({
            name: 'stitch',
            transport: {
              type: 'streamable_http',
              url: 'https://stitch.example/mcp',
              bearer_token_env_var: 'STITCH_TOKEN',
              http_headers: { 'X-Goog-Api-Key': API_KEY },
              env_http_headers: { 'X-Org': 'STITCH_ORG' },
              http_headers_helper: null,
            },
          }),
        },
      ],
      temp,
      NODE,
    )

    expect(settings(args)).toEqual([
      'mcp_servers.stitch.url="https://stitch.example/mcp"',
      'mcp_servers.stitch.bearer_token_env_var="STITCH_TOKEN"',
      'mcp_servers.stitch.env_http_headers={"X-Org" = "STITCH_ORG", "X-Goog-Api-Key" = "PHADA_MCP_1"}',
    ])
    expect(env).toEqual({ PHADA_MCP_1: API_KEY })
  })

  it('never puts header or env values of a Codex server in argv', async () => {
    const { args } = await codexMcpArgs(
      [
        {
          server: server({
            name: 'a',
            transport: {
              type: 'streamable_http',
              url: 'https://a/mcp',
              bearer_token_env_var: null,
              http_headers: { Authorization: `Bearer ${API_KEY}` },
              env_http_headers: null,
              http_headers_helper: null,
            },
          }),
        },
        {
          server: server({
            name: 'b',
            transport: {
              type: 'stdio',
              command: 'b',
              args: [],
              cwd: null,
              env: { TOKEN: ENV_TOKEN },
              env_vars: null,
            },
          }),
        },
      ],
      temp,
      NODE,
    )

    expect(args.join(' ')).not.toContain(API_KEY)
    expect(args.join(' ')).not.toContain(ENV_TOKEN)
  })

  it('prefers the tools Phada was given over the enabled tools of Codex, and quotes odd names', async () => {
    const { args } = await codexMcpArgs(
      [
        {
          server: server({
            name: 'my docs',
            transport: {
              type: 'stdio',
              command: 'd',
              args: [],
              cwd: null,
              env: null,
              env_vars: null,
            },
            enabled_tools: ['a', 'b'],
            disabled_tools: ['c'],
            tool_timeout_sec: 45.5,
          }),
          tools: ['a'],
        },
      ],
      temp,
      NODE,
    )

    expect(settings(args)).toEqual([
      'mcp_servers."my docs".command="d"',
      'mcp_servers."my docs".args=[]',
      'mcp_servers."my docs".tool_timeout_sec=45.5',
      'mcp_servers."my docs".enabled_tools=["a"]',
      'mcp_servers."my docs".disabled_tools=["c"]',
    ])
  })

  it('reads the JSON that codex mcp get prints', () => {
    const parsed = CodexMcpServerSchema.parse({
      name: 'context7',
      enabled: true,
      disabled_reason: null,
      transport: {
        type: 'streamable_http',
        url: 'https://mcp.context7.com/mcp',
        bearer_token_env_var: null,
        http_headers: null,
        env_http_headers: null,
        http_headers_helper: null,
      },
      enabled_tools: null,
      disabled_tools: null,
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      auth_status: 'not_logged_in',
    })

    expect(parsed.transport.type).toBe('streamable_http')
  })
})
