import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeCliProvider } from './claude.js'
import type { ClaudeCliProviderOptions } from './claude.js'
import { ProviderError } from './types.js'
import type { ReviewPrompt } from './types.js'

const FAKE_CLAUDE = resolve('test/fixtures/bin/fake-claude')
const FAKE_SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const PROMPT: ReviewPrompt = {
  instructions: 'You are a careful reviewer. Trusted instructions only.',
  data: 'Review this diff, please: +const answer = 42',
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
}
const EXPECTED_ARGS = [
  '-p',
  '--output-format',
  'json',
  '--tools',
  '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--setting-sources=',
  '--disable-slash-commands',
]

interface Capture {
  argv: string[]
  stdin: string
  instructions: string | null
  cwd: string
  env: { GITHUB_TOKEN?: string; GH_TOKEN?: string }
}

let workDir: string
let capturePath: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'phada-claude-test-'))
  capturePath = join(workDir, 'capture.json')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function provider(mode: string, options: ClaudeCliProviderOptions = {}): ClaudeCliProvider {
  return new ClaudeCliProvider({
    command: FAKE_CLAUDE,
    homeDir: workDir,
    ...options,
    env: {
      PATH: process.env.PATH,
      FAKE_CLAUDE_MODE: mode,
      FAKE_CLAUDE_CAPTURE: capturePath,
      FAKE_CLAUDE_SECRET: FAKE_SECRET,
      ...options.env,
    },
  })
}

function readCapture(): Capture {
  return JSON.parse(readFileSync(capturePath, 'utf8')) as Capture
}

async function reviewError(claude: ClaudeCliProvider): Promise<ProviderError> {
  const error = await claude.review(PROMPT).then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof ProviderError)) {
    throw new Error('expected review() to reject with ProviderError')
  }
  return error
}

describe('ClaudeCliProvider', () => {
  it('has the claude-cli id', () => {
    expect(new ClaudeCliProvider().id).toBe('claude-cli')
  })

  it('returns the review text, the model that answered, the duration and the token usage', async () => {
    const output = await provider('success').review(PROMPT)

    expect(output).toEqual({
      text: 'LGTM from fake',
      model: 'claude-fake-1',
      durationMs: expect.any(Number),
      usage: { inputTokens: 3512, outputTokens: 420 },
    })
    expect(output.durationMs).toBeGreaterThan(0)
  })

  it('leaves the usage out when Claude does not report it', async () => {
    const output = await provider('no_usage').review(PROMPT)

    expect(output).not.toHaveProperty('usage')
  })

  it('counts missing usage fields as zero', async () => {
    const output = await provider('partial_usage').review(PROMPT)

    expect(output.usage).toEqual({ inputTokens: 0, outputTokens: 7 })
  })

  it('names the model that wrote most of the answer and lists the others', async () => {
    const output = await provider('multi_model').review(PROMPT)

    expect(output.model).toBe('claude-fake-1')
    expect(output.additionalModels).toEqual(['claude-helper-1', 'claude-other-1'])
  })

  it('lists no additional models when only one model answered', async () => {
    const output = await provider('success').review(PROMPT)

    expect(output).not.toHaveProperty('additionalModels')
  })

  it('leaves the model out when Claude does not report it', async () => {
    const output = await provider('no_model').review(PROMPT)

    expect(output).not.toHaveProperty('model')
  })

  it('runs claude headless, without tools, MCP, session or user settings', async () => {
    await provider('success').review(PROMPT)

    const { argv, cwd } = readCapture()
    expect(argv).toEqual([
      ...EXPECTED_ARGS,
      '--append-system-prompt-file',
      join(cwd, 'instructions.md'),
      '--max-turns',
      '3',
      `--json-schema=${JSON.stringify(PROMPT.outputSchema)}`,
      '--model=opus',
    ])
  })

  it('sends the instructions as a system prompt file inside the temp dir', async () => {
    await provider('success').review(PROMPT)

    const { instructions, argv, cwd } = readCapture()
    const instructionsPath = argv[argv.indexOf('--append-system-prompt-file') + 1] ?? ''
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

  it('reports invalid-output when Claude answers with an empty review', async () => {
    const error = await reviewError(provider('empty_result'))

    expect(error.reason).toBe('invalid-output')
    expect(error.message).toBe('Claude returned an empty review.')
  })

  it('delivers a diff near the 1 MB limit intact on stdin', async () => {
    const data = 'x'.repeat(1_000_000)

    const output = await provider('echo_stdin_size').review({ ...PROMPT, data })

    expect(output.text).toBe('1000000')
  })

  it('passes the configured model', async () => {
    await provider('success', { model: 'claude-test-model' }).review(PROMPT)

    expect(readCapture().argv.at(-1)).toBe('--model=claude-test-model')
  })

  it('keeps a model that starts with a dash in a single argument', async () => {
    await provider('success', { model: '--tools=Bash' }).review(PROMPT)

    const { argv } = readCapture()
    expect(argv.at(-1)).toBe('--model=--tools=Bash')
    expect(argv).not.toContain('--tools=Bash')
  })

  it('falls back to the model from ANTHROPIC_MODEL', async () => {
    await provider('success', { env: { ANTHROPIC_MODEL: 'claude-env-model' } }).review(PROMPT)

    expect(readCapture().argv.at(-1)).toBe('--model=claude-env-model')
  })

  it("falls back to the model in the user's Claude settings", async () => {
    mkdirSync(join(workDir, '.claude'))
    writeFileSync(join(workDir, '.claude', 'settings.json'), '{"model":"claude-settings-model"}')

    await provider('success').review(PROMPT)

    expect(readCapture().argv.at(-1)).toBe('--model=claude-settings-model')
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
    expect(basename(cwd)).toMatch(/^phada-claude-/)
    expect(existsSync(cwd)).toBe(false)
  })

  it('removes the temp dir when the review fails', async () => {
    await reviewError(provider('exit1'))

    expect(existsSync(readCapture().cwd)).toBe(false)
  })

  it('reports not-authenticated when Claude answers "Not logged in" with exit 1', async () => {
    const error = await reviewError(provider('logged_out'))

    expect(error).toMatchObject({ providerId: 'claude-cli', reason: 'not-authenticated' })
    expect(error.message).toBe('Claude returned an error: Not logged in · Please run /login')
  })

  it('reports not-authenticated when a login problem only shows up on stderr', async () => {
    const error = await reviewError(provider('logged_out_stderr'))

    expect(error.reason).toBe('not-authenticated')
  })

  it('reports failed with the redacted Claude error for any other is_error result', async () => {
    const error = await reviewError(provider('is_error'))

    expect(error.reason).toBe('failed')
    expect(error.message).toBe('Claude returned an error: API Error: 500 [REDACTED]')
  })

  it('reports invalid-output when Claude gives up after too many answers off the schema', async () => {
    const error = await reviewError(provider('max_turns'))

    expect(error.reason).toBe('invalid-output')
    expect(error.message).toBe('Claude did not return a valid review in 3 attempts.')
  })

  it('reports failed with the exit code and the redacted stderr when there is no JSON', async () => {
    const error = await reviewError(provider('exit1'))

    expect(error.reason).toBe('failed')
    expect(error.message).toBe('Claude exited with code 1: boom [REDACTED]')
  })

  it('reports failed with only the exit code when stderr is empty', async () => {
    const error = await reviewError(provider('exit1_silent'))

    expect(error.message).toBe('Claude exited with code 1.')
  })

  it('reports invalid-output with a redacted preview when exit 0 is not JSON', async () => {
    const error = await reviewError(provider('invalid_json'))

    expect(error.reason).toBe('invalid-output')
    expect(error.message).toContain('not json [REDACTED]')
  })

  it('reports timeout and stops a Claude that never answers', async () => {
    const startedAt = performance.now()

    const error = await reviewError(provider('hang', { timeoutMs: 300 }))

    expect(error.reason).toBe('timeout')
    expect(error.message).toBe('Claude did not answer within 0.3s.')
    expect(performance.now() - startedAt).toBeLessThan(3_000)
  })

  it('reports failed and removes the temp dir when Claude is killed by a signal', async () => {
    const error = await reviewError(provider('crash'))

    expect(error).toMatchObject({ providerId: 'claude-cli', reason: 'failed' })
    expect(error.message).toContain('SIGKILL')
    expect(existsSync(readCapture().cwd)).toBe(false)
  })

  it('reports not-installed when the claude command does not exist', async () => {
    const error = await reviewError(
      provider('success', { command: join(workDir, 'no-such-claude') }),
    )

    expect(error.reason).toBe('not-installed')
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('redacts before truncating, so a token cut at the 500-character limit never leaks', async () => {
    const error = await reviewError(
      provider('is_error', { env: { FAKE_CLAUDE_DETAIL: 'x'.repeat(480) } }),
    )

    expect(error.message).not.toContain('ghp_')
  })

  it.each(['is_error', 'exit1', 'invalid_json', 'logged_out_stderr'])(
    'never puts a token in the %s error message',
    async (mode) => {
      const error = await reviewError(provider(mode))

      expect(error.message).not.toContain(FAKE_SECRET)
      expect(error.message).not.toContain('ghp_')
    },
  )
})
