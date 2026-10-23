import { describe, expect, it } from 'vitest'
import { CommandNotFoundError } from '../process/errors.js'
import type { RunCommandOptions, RunCommandResult } from '../process/run-command.js'
import { UsageError } from './errors.js'
import { checkMcpNames } from './mcp-names.js'

interface Call {
  command: string
  args: readonly string[]
  options: RunCommandOptions
}

function fakeRun(answers: Record<string, Partial<RunCommandResult>>) {
  const calls: Call[] = []
  const run = async (command: string, args: readonly string[], options: RunCommandOptions = {}) => {
    calls.push({ command, args, options })
    const answer = answers[args[2] ?? ''] ?? { exitCode: 1, stdout: '' }
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 1, ...answer }
  }
  return { run, calls }
}

const CODEX_JSON = {
  name: 'stitch',
  enabled: true,
  disabled_reason: null,
  transport: {
    type: 'streamable_http',
    url: 'https://stitch.example/mcp',
    bearer_token_env_var: null,
    http_headers: null,
    env_http_headers: null,
    http_headers_helper: null,
  },
  enabled_tools: null,
  disabled_tools: null,
  startup_timeout_sec: null,
  tool_timeout_sec: null,
  auth_status: 'unsupported',
}

const env = { PATH: '/bin', GITHUB_TOKEN: 'gh-token', GH_TOKEN: 'gh-token' }

describe('checkMcpNames', () => {
  it('runs nothing without names', async () => {
    const { run, calls } = fakeRun({})

    expect(await checkMcpNames('claude', [], { env, run })).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('checks each Claude Code server in a temporary folder without GitHub tokens', async () => {
    const { run, calls } = fakeRun({ linear: { exitCode: 0, stdout: 'linear:\n  Status: ✓' } })

    expect(
      await checkMcpNames('claude', [{ name: 'linear', tools: ['get_issue'] }], { env, run }),
    ).toEqual({
      provider: 'claude',
      names: [{ name: 'linear', tools: ['get_issue'] }],
    })
    expect(calls[0]?.command).toBe('claude')
    expect(calls[0]?.args).toEqual(['mcp', 'get', 'linear'])
    expect(calls[0]?.options.env).toEqual({ PATH: '/bin' })
    expect(calls[0]?.options.cwd).toMatch(/phada-mcp-check-/)
    expect(calls[0]?.options.timeoutMs).toBe(60_000)
  })

  it('names the servers Claude Code has when one is unknown', async () => {
    const { run } = fakeRun({
      nope: {
        exitCode: 1,
        stdout:
          'No MCP server named "nope". Configured servers: claude.ai Gmail, linear (and 2 more — run `claude mcp list` to see all)\n',
      },
    })

    const error = await checkMcpNames('claude', [{ name: 'nope' }], { env, run }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(UsageError)
    expect(String(error)).toContain(
      'Claude Code has no MCP server named "nope". Configured servers: claude.ai Gmail, linear (and 2 more — run `claude mcp list` to see all)',
    )
  })

  it('reads a Codex server as JSON', async () => {
    const { run, calls } = fakeRun({ stitch: { exitCode: 0, stdout: JSON.stringify(CODEX_JSON) } })

    const checked = await checkMcpNames('codex', [{ name: 'stitch', tools: ['a'] }], { env, run })

    expect(calls[0]?.args).toEqual(['mcp', 'get', 'stitch', '--json'])
    expect(calls[0]?.options.timeoutMs).toBe(30_000)
    expect(checked).toMatchObject({
      provider: 'codex',
      names: [
        {
          server: { name: 'stitch', transport: { url: 'https://stitch.example/mcp' } },
          tools: ['a'],
        },
      ],
    })
  })

  it('refuses a Codex server that does not exist or is disabled', async () => {
    const { run } = fakeRun({
      off: { exitCode: 0, stdout: JSON.stringify({ ...CODEX_JSON, name: 'off', enabled: false }) },
    })

    await expect(checkMcpNames('codex', [{ name: 'nope' }], { env, run })).rejects.toThrow(
      'Codex has no MCP server named "nope" (see "codex mcp list").',
    )
    await expect(checkMcpNames('codex', [{ name: 'off' }], { env, run })).rejects.toThrow(
      'MCP server off is disabled in your Codex config.',
    )
  })

  it('says when the AI CLI is not installed', async () => {
    const run = async (): Promise<RunCommandResult> => {
      throw new CommandNotFoundError('codex')
    }

    await expect(checkMcpNames('codex', [{ name: 'x' }], { env, run })).rejects.toThrow(
      'Codex CLI was not found (command "codex"); it is needed to read MCP server x.',
    )
  })
})
