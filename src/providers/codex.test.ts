import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexCliProvider } from './codex.js'
import type { CodexCliProviderOptions } from './codex.js'
import { ProviderError } from './types.js'
import type { ReviewPrompt, Toolbox } from './types.js'

const FAKE_CODEX = resolve('test/fixtures/bin/fake-codex')
const FAKE_SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const PROMPT: ReviewPrompt = {
  instructions: 'You are a careful reviewer. Trusted instructions only.',
  data: 'Review this diff, please: +const answer = 42',
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
}
const DISABLED_FEATURES = [
  'apps',
  'plugins',
  'shell_tool',
  'unified_exec',
  'multi_agent',
  'image_generation',
  'goals',
  'sleep_tool',
  'view_image',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'tool_suggest',
  'skill_search',
  'hooks',
]

interface Capture {
  argv: string[]
  stdin: string
  instructions: string | null
  outputSchema: string | null
  cwd: string
  env: { GITHUB_TOKEN?: string; GH_TOKEN?: string }
}

let workDir: string
let capturePath: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'phada-codex-test-'))
  capturePath = join(workDir, 'capture.json')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function provider(mode: string, options: CodexCliProviderOptions = {}): CodexCliProvider {
  return new CodexCliProvider({
    command: FAKE_CODEX,
    homeDir: workDir,
    ...options,
    env: {
      PATH: process.env.PATH,
      FAKE_CODEX_MODE: mode,
      FAKE_CODEX_CAPTURE: capturePath,
      FAKE_CODEX_SECRET: FAKE_SECRET,
      ...options.env,
    },
  })
}

function readCapture(): Capture {
  return JSON.parse(readFileSync(capturePath, 'utf8')) as Capture
}

async function reviewError(codex: CodexCliProvider): Promise<ProviderError> {
  const error = await codex.review(PROMPT).then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof ProviderError)) {
    throw new Error('expected review() to reject with ProviderError')
  }
  return error
}

describe('CodexCliProvider', () => {
  it('has the codex-cli id', () => {
    expect(new CodexCliProvider().id).toBe('codex-cli')
  })

  it('returns the final message, the model it asked for, the duration and the token usage', async () => {
    const output = await provider('success', { model: 'gpt-test-model' }).review(PROMPT)

    expect(output).toEqual({
      text: 'LGTM from fake codex',
      model: 'gpt-test-model',
      durationMs: expect.any(Number),
      usage: { inputTokens: 8739, outputTokens: 410 },
    })
    expect(output.durationMs).toBeGreaterThan(0)
  })

  it('leaves the model out when Codex uses its own default', async () => {
    const output = await provider('success').review(PROMPT)

    expect(output).not.toHaveProperty('model')
  })

  it('leaves the usage out when Codex reports no completed turn', async () => {
    const output = await provider('no_usage').review(PROMPT)

    expect(output).not.toHaveProperty('usage')
  })

  it('takes the usage of the last completed turn and skips lines it does not know', async () => {
    const output = await provider('noisy_stdout').review(PROMPT)

    expect(output.usage).toEqual({ inputTokens: 8739, outputTokens: 410 })
  })

  it('runs codex exec read-only, ephemeral, without user config, tools or web search', async () => {
    await provider('success').review(PROMPT)

    const { argv, cwd } = readCapture()
    expect(argv).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '-s',
      'read-only',
      '--ignore-user-config',
      ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      '-c',
      'web_search="disabled"',
      '--json',
      '-c',
      `model_instructions_file=${JSON.stringify(join(cwd, 'instructions.md'))}`,
      '--output-schema',
      join(cwd, 'output-schema.json'),
      '-o',
      join(cwd, 'last-message.txt'),
      '-',
    ])
  })

  it('writes the output schema to a file inside the temp dir', async () => {
    await provider('success').review(PROMPT)

    const { outputSchema, argv, cwd } = readCapture()
    const schemaPath = argv[argv.indexOf('--output-schema') + 1] ?? ''
    expect(JSON.parse(outputSchema ?? 'null')).toEqual(PROMPT.outputSchema)
    expect(dirname(schemaPath)).toBe(cwd)
    expect(existsSync(schemaPath)).toBe(false)
  })

  it('sends the instructions as the model instructions file inside the temp dir', async () => {
    await provider('success').review(PROMPT)

    const { instructions, argv, cwd } = readCapture()
    const setting = argv.find((arg) => arg.startsWith('model_instructions_file=')) ?? ''
    const instructionsPath = JSON.parse(setting.slice('model_instructions_file='.length)) as string
    expect(instructions).toBe(PROMPT.instructions)
    expect(dirname(instructionsPath)).toBe(cwd)
    expect(existsSync(instructionsPath)).toBe(false)
  })

  it('sends only the data on stdin and keeps both parts out of argv', async () => {
    await provider('success').review(PROMPT)

    const capture = readCapture()
    expect(capture.stdin).toBe(PROMPT.data)
    expect(capture.argv.join(' ')).not.toContain('Review this diff')
    expect(capture.argv.join(' ')).not.toContain('Trusted instructions')
  })

  it('delivers a diff near the 1 MB limit intact on stdin', async () => {
    const data = 'x'.repeat(1_000_000)

    const output = await provider('echo_stdin_size').review({ ...PROMPT, data })

    expect(output.text).toBe('1000000')
  })

  it('passes the configured model as a single argument before the stdin marker', async () => {
    await provider('success', { model: 'gpt-test-model' }).review(PROMPT)

    expect(readCapture().argv.slice(-2)).toEqual(['--model=gpt-test-model', '-'])
  })

  it('keeps a model that starts with a dash in a single argument', async () => {
    await provider('success', { model: '--dangerously-bypass-approvals-and-sandbox' }).review(
      PROMPT,
    )

    const { argv } = readCapture()
    expect(argv.at(-2)).toBe('--model=--dangerously-bypass-approvals-and-sandbox')
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it("falls back to the model in the user's Codex config", async () => {
    mkdirSync(join(workDir, '.codex'))
    writeFileSync(join(workDir, '.codex', 'config.toml'), 'model = "gpt-config-model"\n')

    await provider('success').review(PROMPT)

    expect(readCapture().argv.at(-2)).toBe('--model=gpt-config-model')
  })

  it('passes no model when neither the flag nor the config has one', async () => {
    await provider('success').review(PROMPT)

    expect(readCapture().argv.some((arg) => arg.startsWith('--model'))).toBe(false)
  })

  it('removes GITHUB_TOKEN and GH_TOKEN from the child env', async () => {
    await provider('success', {
      env: { GITHUB_TOKEN: FAKE_SECRET, GH_TOKEN: FAKE_SECRET },
    }).review(PROMPT)

    expect(readCapture().env).toEqual({})
  })

  it('runs in a fresh empty temp dir and removes it afterwards', async () => {
    await provider('success').review(PROMPT)

    const { cwd } = readCapture()
    expect(cwd).not.toBe(process.cwd())
    expect(basename(cwd)).toMatch(/^phada-codex-/)
    expect(existsSync(cwd)).toBe(false)
  })

  it('removes the temp dir when the review fails', async () => {
    await reviewError(provider('turn_failed'))

    expect(existsSync(readCapture().cwd)).toBe(false)
  })

  it('reports invalid-output when Codex writes no final message', async () => {
    const error = await reviewError(provider('no_output'))

    expect(error).toMatchObject({ providerId: 'codex-cli', reason: 'invalid-output' })
    expect(error.message).toBe('Codex produced no final message.')
  })

  it('keeps the Codex error when it exits 0 with no final message', async () => {
    const error = await reviewError(provider('no_output_with_error'))

    expect(error).toMatchObject({ providerId: 'codex-cli', reason: 'invalid-output' })
    expect(error.message).toBe('Codex produced no final message: model context window exceeded')
  })

  it('reports invalid-output when the final message is blank', async () => {
    const error = await reviewError(provider('empty_output'))

    expect(error.reason).toBe('invalid-output')
  })

  it('reports not-authenticated when Codex gets a 401', async () => {
    const error = await reviewError(provider('logged_out'))

    expect(error).toMatchObject({ providerId: 'codex-cli', reason: 'not-authenticated' })
    expect(error.message).toBe(
      'Codex exited with code 1: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
    )
  })

  it('reports failed with the redacted message of the failed turn', async () => {
    const error = await reviewError(provider('turn_failed'))

    expect(error.reason).toBe('failed')
    expect(error.message).toBe('Codex exited with code 1: stream failed: boom [REDACTED]')
  })

  it('reports failed when a later message overrides an earlier login retry', async () => {
    const error = await reviewError(
      provider('turn_failed_custom', {
        env: { FAKE_CODEX_FAILURE: 'stream failed: quota exceeded' },
      }),
    )

    expect(error.reason).toBe('failed')
    expect(error.message).toBe('Codex exited with code 1: stream failed: quota exceeded')
  })

  it.each([
    'Missing bearer or basic authentication in header',
    'Not logged in',
    'Please run codex login',
  ])('reports not-authenticated when the final turn.failed message is %s', async (message) => {
    const error = await reviewError(
      provider('turn_failed_custom', { env: { FAKE_CODEX_FAILURE: message } }),
    )

    expect(error.reason).toBe('not-authenticated')
  })

  it('falls back to the last redacted stderr line when there is no error event', async () => {
    const error = await reviewError(provider('stderr_only'))

    expect(error.reason).toBe('failed')
    expect(error.message).toBe(
      "Codex exited with code 2: error: unexpected argument '--nope' found [REDACTED]",
    )
  })

  it.each(['turn_failed', 'stderr_only'])(
    'never puts a token in the %s error message',
    async (mode) => {
      const error = await reviewError(provider(mode))

      expect(error.message).not.toContain(FAKE_SECRET)
      expect(error.message).not.toContain('ghp_')
    },
  )

  it('reports failed with only the exit code when Codex says nothing', async () => {
    const error = await reviewError(provider('exit1_silent'))

    expect(error.message).toBe('Codex exited with code 1.')
  })

  it('reports timeout and stops a Codex that never answers', async () => {
    const error = await reviewError(provider('hang', { timeoutMs: 300 }))

    expect(error.reason).toBe('timeout')
    expect(error.message).toBe('Codex did not answer within 0.3s.')
  })

  it('reports not-installed when the codex command does not exist', async () => {
    const error = await reviewError(
      provider('success', { command: join(workDir, 'no-such-codex') }),
    )

    expect(error.reason).toBe('not-installed')
    expect(error.message).toBe(
      `Codex CLI was not found (command "${join(workDir, 'no-such-codex')}").`,
    )
  })

  describe('with the repository tools', () => {
    const toolbox: Toolbox = {
      definitions: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }],
      call: async () => ({ text: 'ok', isError: false }),
      touchedPaths: () => [],
    }
    const withTools: ReviewPrompt = { ...PROMPT, tools: toolbox }

    function settings(argv: string[]): string[] {
      return argv.flatMap((arg, index) => (argv[index - 1] === '-c' ? [arg] : []))
    }

    it('adds the Phada MCP server to the run', async () => {
      await provider('success', { model: 'gpt-test-model' }).review(withTools)

      const { argv } = readCapture()
      const command = settings(argv).find((arg) => arg.startsWith('mcp_servers.phada.command='))
      const args = settings(argv).find((arg) => arg.startsWith('mcp_servers.phada.args='))
      expect(command).toBe(`mcp_servers.phada.command=${JSON.stringify(process.execPath)}`)
      const launchArgs = JSON.parse(
        args?.slice('mcp_servers.phada.args='.length) ?? '[]',
      ) as string[]
      expect(launchArgs.at(-2)).toMatch(/mcp-bridge\.js$/)
      expect(argv.slice(-2)).toEqual(['--model=gpt-test-model', '-'])
    })

    it('leaves the MCP server out without tools', async () => {
      await provider('success').review(PROMPT)

      expect(settings(readCapture().argv).some((arg) => arg.startsWith('mcp_servers.'))).toBe(false)
    })

    it('reports calls to MCP servers other than Phada', async () => {
      const output = await provider('mcp_calls').review(withTools)

      expect(output.externalCalls).toEqual([{ server: 'linear', tool: 'get_issue' }])
    })

    it('closes the MCP server when Codex fails', async () => {
      await provider('turn_failed')
        .review(withTools)
        .catch(() => undefined)

      const args = settings(readCapture().argv).find((arg) =>
        arg.startsWith('mcp_servers.phada.args='),
      )
      const socket =
        (JSON.parse(args?.slice('mcp_servers.phada.args='.length) ?? '[]') as string[]).at(-1) ?? ''
      expect(socket).not.toBe('')
      expect(existsSync(dirname(socket))).toBe(false)
    })
  })
})
