import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../test/support/pull-request.js'
import { USAGE } from './cli/args.js'
import { UsageError } from './cli/errors.js'
import { PullRequestNotFoundError } from './github/errors.js'
import type { FetchPullRequestOptions, PullRequest } from './github/pull-request.js'
import { createProvider, run } from './main.js'
import type { MainDeps, ProviderOptions } from './main.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import { ProviderError } from './providers/types.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from './providers/types.js'

const execFileAsync = promisify(execFile)
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const OUTPUT: ReviewOutput = {
  text: 'No significant problems found.',
  durationMs: 42_149,
  model: 'claude-fake-1',
  usage: { inputTokens: 3512, outputTokens: 420 },
}

interface Harness {
  deps: MainDeps
  stdout: () => string
  stderr: () => string
  fetches: FetchPullRequestOptions[]
  providers: { name: string; options: ProviderOptions }[]
  prompts: ReviewPrompt[]
}

function harness(
  overrides: {
    env?: NodeJS.ProcessEnv
    pullRequest?: () => Promise<PullRequest>
    review?: () => Promise<ReviewOutput>
  } = {},
): Harness {
  const out: string[] = []
  const err: string[] = []
  const fetches: FetchPullRequestOptions[] = []
  const providers: { name: string; options: ProviderOptions }[] = []
  const prompts: ReviewPrompt[] = []
  const deps: MainDeps = {
    env: overrides.env ?? { GITHUB_TOKEN: TOKEN },
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    fetchPullRequest: (options) => {
      fetches.push(options)
      return overrides.pullRequest?.() ?? Promise.resolve(pullRequestFixture())
    },
    createProvider: (name, options) => {
      providers.push({ name, options })
      if (name !== 'claude') return createProvider(name, options)
      const provider: ReviewProvider = {
        id: 'fake-cli',
        review: (prompt) => {
          prompts.push(prompt)
          return overrides.review?.() ?? Promise.resolve(OUTPUT)
        },
      }
      return provider
    },
  }
  return {
    deps,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    fetches,
    providers,
    prompts,
  }
}

describe('run', () => {
  it('prints the usage and exits with 0 for --help', async () => {
    const h = harness()

    expect(await run(['--help'], h.deps)).toBe(0)
    expect(h.stdout()).toBe(`${USAGE}\n`)
    expect(h.fetches).toHaveLength(0)
  })

  it('reviews a pull request: progress on stderr, the review on stdout', async () => {
    const h = harness()

    expect(await run(['acme/shop#12'], h.deps)).toBe(0)
    expect(h.stderr()).toBe(
      [
        'Fetching acme/shop#12…',
        'acme/shop#12 · a1b2c3d · 2 files · +15 −1 · 70 B diff',
        'Reviewing with fake-cli… (this can take a few minutes)',
        '',
      ].join('\n'),
    )
    expect(h.stdout()).toBe(
      [
        '# Review of acme/shop#12: Let users spend crystals',
        'https://github.com/acme/shop/pull/12 · head a1b2c3d · open',
        '',
        'No significant problems found.',
        '',
        '---',
        'fake-cli · claude-fake-1 · 42.1s · 3.5k in / 420 out',
        '',
      ].join('\n'),
    )
    expect(h.fetches).toEqual([{ owner: 'acme', repo: 'shop', number: 12, token: TOKEN }])
  })

  it('passes --model to the provider and --language to the prompt', async () => {
    const h = harness()

    await run(['acme/shop#12', '--model', 'opus', '--language', 'pt-BR'], h.deps)

    expect(h.providers).toEqual([{ name: 'claude', options: { model: 'opus' } }])
    expect(h.prompts[0]?.instructions).toContain('Write the review in pt-BR.')
  })

  it.each([{}, { GITHUB_TOKEN: '' }, { GITHUB_TOKEN: '  \n' }])(
    'asks for GITHUB_TOKEN when the environment is %j',
    async (env) => {
      const h = harness({ env })

      expect(await run(['acme/shop#12'], h.deps)).toBe(1)
      expect(h.stderr()).toBe(
        'phada: GITHUB_TOKEN is not set. Run: export GITHUB_TOKEN=$(gh auth token)\n',
      )
      expect(h.fetches).toHaveLength(0)
    },
  )

  it('trims the token read from the environment', async () => {
    const h = harness({ env: { GITHUB_TOKEN: `${TOKEN}\n` } })

    await run(['acme/shop#12'], h.deps)

    expect(h.fetches[0]?.token).toBe(TOKEN)
  })

  it('asks for --model with exit 2 before fetching when the provider is ollama', async () => {
    const h = harness()

    expect(await run(['acme/shop#12', '--provider', 'ollama'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('phada: --provider ollama needs --model')
    expect(h.fetches).toHaveLength(0)
  })

  it('rejects an unknown provider with exit 2 before fetching', async () => {
    const h = harness()

    expect(await run(['acme/shop#12', '--provider', 'gpt'], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: Unknown provider "gpt". Available: claude, codex, ollama. Run with --help for usage.\n',
    )
    expect(h.fetches).toHaveLength(0)
  })

  it('exits with 2 on a usage error', async () => {
    const h = harness()

    expect(await run([], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: Missing the pull request to review. Run with --help for usage.\n',
    )
  })

  it('does not call the AI when the pull request has no changes', async () => {
    const h = harness({ pullRequest: () => Promise.resolve(pullRequestFixture({ diff: '' })) })

    expect(await run(['acme/shop#12'], h.deps)).toBe(0)
    expect(h.prompts).toHaveLength(0)
    expect(h.stderr()).toContain('Nothing to review: the pull request has no changes.\n')
    expect(h.stdout()).toBe('')
  })

  it.each([
    [
      'a GitHub error',
      { pullRequest: () => Promise.reject(new PullRequestNotFoundError('acme/shop#12')) },
      'phada: Pull request acme/shop#12 was not found.',
    ],
    [
      'a provider error',
      {
        review: () =>
          Promise.reject(new ProviderError('claude-cli', 'not-authenticated', 'Not logged in')),
      },
      'phada: Claude Code is not logged in.',
    ],
  ])('turns %s into one line and exit 1', async (_case, overrides, message) => {
    const h = harness(overrides)

    expect(await run(['acme/shop#12'], h.deps)).toBe(1)
    expect(h.stderr().split('\n').at(-2)).toContain(message)
    expect(h.stdout()).toBe('')
  })

  it('shows the stack only with --debug', async () => {
    const failure = { pullRequest: () => Promise.reject(new Error('socket hang up')) }
    const quiet = harness(failure)
    const debug = harness(failure)

    await run(['acme/shop#12'], quiet.deps)
    await run(['acme/shop#12', '--debug'], debug.deps)

    expect(quiet.stderr()).not.toContain('    at ')
    expect(debug.stderr()).toContain('    at ')
  })

  it('never prints the token', async () => {
    const h = harness({
      pullRequest: () => Promise.reject(new Error('socket hang up')),
    })

    await run(['acme/shop#12', '--debug'], h.deps)

    expect(h.stdout() + h.stderr()).not.toContain(TOKEN)
  })
})

describe('createProvider', () => {
  it('creates the Claude provider for "claude"', () => {
    expect(createProvider('claude', {})).toBeInstanceOf(ClaudeCliProvider)
  })

  it('creates the Codex provider for "codex"', () => {
    expect(createProvider('codex', { model: 'gpt-x' })).toBeInstanceOf(CodexCliProvider)
  })

  it('creates the Ollama provider for "ollama" with a model', () => {
    expect(createProvider('ollama', { model: 'qwen2.5-coder:7b' })).toBeInstanceOf(OllamaProvider)
  })

  it('asks for --model when the provider is ollama', () => {
    expect(() => createProvider('ollama', {})).toThrow(UsageError)
    expect(() => createProvider('ollama', {})).toThrow(
      '--provider ollama needs --model, e.g. qwen2.5-coder:7b, llama3.1:8b or gpt-oss:120b-cloud (see "ollama list").',
    )
  })
})

describe('main as a script', () => {
  it('prints the usage and exits with 0 for --help', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      'src/main.ts',
      '--help',
    ])

    expect(stdout).toBe(`${USAGE}\n`)
  }, 20_000)

  it('exits with 2 and a usage error when no pull request is given', async () => {
    const failure = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/main.ts']).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toMatchObject({
      code: 2,
      stderr: 'phada: Missing the pull request to review. Run with --help for usage.\n',
    })
  }, 20_000)
})
