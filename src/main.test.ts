import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { findingFixture } from '../test/support/finding.js'
import { pullRequestFixture } from '../test/support/pull-request.js'
import { reviewReportJson } from '../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../test/support/verification.js'
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
  text: reviewReportJson({ findings: [] }),
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
        'acme/shop#12 · a1b2c3d · 2 files · +15 −1 · 523 B diff',
        'Reviewing with fake-cli… (this can take a few minutes)',
        '',
      ].join('\n'),
    )
    expect(h.stdout()).toBe(
      [
        '# Review of acme/shop#12: Let users spend crystals',
        'https://github.com/acme/shop/pull/12 · head a1b2c3d · open',
        '',
        '**Confidence score: 5/5** (ready to merge): no problems found',
        '',
        '## Summary',
        '',
        'Adds a spend endpoint.',
        '',
        '## Files',
        '',
        '| File | Change | Findings |',
        '| --- | --- | --- |',
        '| src/shop.ts | Adds the spend endpoint | 0 |',
        '',
        '---',
        '0 findings',
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
    expect(h.prompts[0]?.instructions).toContain(
      'Write summary, change, title, why and fix in pt-BR;',
    )
  })

  it('applies --min-confidence to the review', async () => {
    const text = reviewReportJson({ findings: [findingFixture({ confidence: 85 })] })
    const h = harness({ review: () => Promise.resolve({ ...OUTPUT, text }) })

    expect(await run(['acme/shop#12', '--min-confidence', '90'], h.deps)).toBe(0)
    expect(h.stdout()).toContain(
      '## Worth checking (confidence below 90)\n\n- **P1** · src/shop.ts:1: spend has no auth (confidence 85)\n',
    )
    expect(h.stdout()).toContain('\n0 findings · 1 worth checking\n')
  })

  it('checks the findings with a second call to the same provider with --verify', async () => {
    const answers: ReviewOutput[] = [
      { ...OUTPUT, text: reviewReportJson({ findings: [findingFixture({ confidence: 55 })] }) },
      { text: verificationJson([verdictFixture({ confidence: 95 })]), durationMs: 1000 },
    ]
    const h = harness({ review: () => Promise.resolve(answers.shift() ?? OUTPUT) })

    expect(await run(['acme/shop#12', '--verify'], h.deps)).toBe(0)
    expect(h.providers).toHaveLength(1)
    expect(h.prompts.map(({ data }) => data.includes('<<<PHADA_FINDINGS_'))).toEqual([false, true])
    expect(h.stderr()).toContain(
      [
        'Reviewing with fake-cli… (this can take a few minutes)',
        'Verifying findings with fake-cli… (this can take a few minutes)',
        '',
      ].join('\n'),
    )
    expect(h.stdout()).toContain('1. **src/shop.ts:1**: spend has no auth (confidence 95)')
    expect(h.stdout()).toContain(
      '\nfake-cli · claude-fake-1 · verified · 43.1s · 3.5k in / 420 out\n',
    )
  })

  it('fails the review and points to --debug when the verification has no verdicts', async () => {
    const answers = () => [
      { ...OUTPUT, text: reviewReportJson({ findings: [findingFixture({ confidence: 55 })] }) },
      { text: 'All of them look fine to me.', durationMs: 1000 },
    ]
    const quietAnswers = answers()
    const debugAnswers = answers()
    const quiet = harness({ review: () => Promise.resolve(quietAnswers.shift() ?? OUTPUT) })
    const debug = harness({ review: () => Promise.resolve(debugAnswers.shift() ?? OUTPUT) })

    expect(await run(['acme/shop#12', '--verify', '--format', 'json'], quiet.deps)).toBe(1)
    expect(await run(['acme/shop#12', '--verify', '--debug'], debug.deps)).toBe(1)
    expect(quiet.stdout()).toBe('')
    expect(quiet.stderr().split('\n').at(-2)).toBe(
      'phada: The AI did not return a valid review (no verdicts in the verification). Run with --debug to see its answer.',
    )
    expect(quiet.stderr()).not.toContain('All of them look fine')
    expect(debug.stderr()).toContain('AI answer (start):\nAll of them look fine to me.')
  })

  it('prints only the JSON review on stdout with --format json', async () => {
    const h = harness()

    expect(await run(['acme/shop#12', '--format', 'json'], h.deps)).toBe(0)
    expect(JSON.parse(h.stdout())).toMatchObject({
      schemaVersion: 1,
      status: 'reviewed',
      pullRequest: { repo: 'acme/shop', number: 12 },
      review: { score: { value: 5 }, minConfidence: 60, findings: [] },
    })
    expect(h.stderr()).toContain('Reviewing with fake-cli…')
  })

  it('prints a skipped review as JSON when the pull request has no changes', async () => {
    const h = harness({ pullRequest: () => Promise.resolve(pullRequestFixture({ diff: '' })) })

    expect(await run(['acme/shop#12', '--format', 'json'], h.deps)).toBe(0)
    expect(JSON.parse(h.stdout())).toMatchObject({ status: 'skipped', reason: 'empty-diff' })
    expect(h.stderr()).toContain('Nothing to review: the pull request has no changes.\n')
  })

  it('keeps errors on stderr and stdout empty with --format json', async () => {
    const h = harness({
      review: () =>
        Promise.reject(new ProviderError('claude-cli', 'not-authenticated', 'Not logged in')),
    })

    expect(await run(['acme/shop#12', '--format', 'json'], h.deps)).toBe(1)
    expect(h.stdout()).toBe('')
    expect(h.stderr()).toContain('phada: Claude Code is not logged in.')
  })

  it('rejects an unknown format with exit 2 before fetching', async () => {
    const h = harness()

    expect(await run(['acme/shop#12', '--format', 'xml'], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: Invalid --format "xml". Use markdown or json. Run with --help for usage.\n',
    )
    expect(h.fetches).toHaveLength(0)
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
