import { describe, expect, it } from 'vitest'
import { findingFixture } from '../test/support/finding.js'
import { memoryFiles } from '../test/support/memory-files.js'
import type { MemoryFiles } from '../test/support/memory-files.js'
import { pullRequestFixture } from '../test/support/pull-request.js'
import { reviewReportJson } from '../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../test/support/verification.js'
import { REVIEW_USAGE, USAGE } from './cli/args.js'
import { UsageError } from './cli/errors.js'
import { formatAlreadyReviewedJson } from './cli/format-json.js'
import type { CreateReviewOptions, CreatedReview } from './github/create-review.js'
import { PullRequestNotFoundError, ReviewPermissionError } from './github/errors.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
  ReviewThread,
} from './github/pull-request-reviews.js'
import type { FetchPullRequestOptions, PullRequest } from './github/pull-request.js'
import type { RepositoryTree } from './github/repository-files.js'
import type { Checkout } from './investigation/checkout.js'
import { CheckoutUnavailableError } from './investigation/git-checkout.js'
import type { OpenGitCheckoutOptions } from './investigation/git-checkout.js'
import { FINDING_MARKER, reviewMarker } from './publish/markers.js'
import { createProvider, run } from './main.js'
import type { MainDeps, ProviderOptions } from './main.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import { ProviderError } from './providers/types.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from './providers/types.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const OUTPUT: ReviewOutput = {
  text: reviewReportJson({ findings: [] }),
  durationMs: 42_149,
  model: 'claude-fake-1',
  usage: { inputTokens: 3512, outputTokens: 420 },
}

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const REVIEW_URL = 'https://github.com/acme/shop/pull/12#pullrequestreview-1'
const EMPTY_STATE: PullRequestReviewState = { viewer: 'octocat', reviews: [], threads: [] }

interface Harness {
  deps: MainDeps
  files: MemoryFiles
  treeFetches: { sha: string }[]
  fileFetches: { path: string; ref: string }[]
  stdout: () => string
  stderr: () => string
  fetches: FetchPullRequestOptions[]
  stateFetches: FetchReviewStateOptions[]
  posts: CreateReviewOptions[]
  events: string[]
  providers: { name: string; options: ProviderOptions }[]
  prompts: ReviewPrompt[]
  checkouts: OpenGitCheckoutOptions[]
  closed: () => number
}

function memoryCheckout(onClose: () => void): Checkout {
  return {
    commit: HEAD_SHA,
    readText: async (path) => `contents of ${path}\n`,
    grep: async () => [],
    listDir: async () => [],
    close: async () => onClose(),
  }
}

function harness(
  overrides: {
    env?: NodeJS.ProcessEnv
    pullRequest?: () => Promise<PullRequest>
    review?: () => Promise<ReviewOutput>
    reviewState?: () => Promise<PullRequestReviewState>
    createReview?: () => Promise<CreatedReview>
    files?: MemoryFiles
    repoFiles?: Record<string, string>
    tree?: () => Promise<RepositoryTree>
    openCheckout?: (options: OpenGitCheckoutOptions) => Promise<Checkout>
  } = {},
): Harness {
  const checkouts: OpenGitCheckoutOptions[] = []
  let closed = 0
  const files = overrides.files ?? memoryFiles()
  const repoFiles = overrides.repoFiles ?? {}
  const treeFetches: { sha: string }[] = []
  const fileFetches: { path: string; ref: string }[] = []
  const out: string[] = []
  const err: string[] = []
  const fetches: FetchPullRequestOptions[] = []
  const stateFetches: FetchReviewStateOptions[] = []
  const posts: CreateReviewOptions[] = []
  const events: string[] = []
  const providers: { name: string; options: ProviderOptions }[] = []
  const prompts: ReviewPrompt[] = []
  const deps: MainDeps = {
    env: overrides.env ?? { GITHUB_TOKEN: TOKEN, PHADA_CONFIG_HOME: '/cfg' },
    version: '1.2.3',
    cwd: '/w/shop',
    home: '/home/u',
    files,
    stdout: {
      write: (text: string) => {
        events.push('stdout')
        return out.push(text)
      },
    },
    stderr: { write: (text: string) => err.push(text) },
    fetchPullRequest: (options) => {
      fetches.push(options)
      return overrides.pullRequest?.() ?? Promise.resolve(pullRequestFixture())
    },
    fetchReviewState: (options) => {
      stateFetches.push(options)
      return overrides.reviewState?.() ?? Promise.resolve(EMPTY_STATE)
    },
    createReview: (options) => {
      events.push('post')
      posts.push(options)
      return overrides.createReview?.() ?? Promise.resolve({ url: REVIEW_URL })
    },
    fetchRepositoryTree: (options) => {
      treeFetches.push({ sha: options.sha })
      if (overrides.tree !== undefined) return overrides.tree()
      return Promise.resolve({
        entries: Object.entries(repoFiles).map(([path, text]) => ({ path, size: text.length })),
        truncated: false,
      })
    },
    fetchRepositoryFile: (options) => {
      fileFetches.push({ path: options.path, ref: options.ref })
      return Promise.resolve(repoFiles[options.path] ?? null)
    },
    openCheckout: (options) => {
      checkouts.push(options)
      return (
        overrides.openCheckout?.(options) ??
        Promise.resolve(
          memoryCheckout(() => {
            closed += 1
          }),
        )
      )
    },
    createProvider: (name, options) => {
      providers.push({ name, options })
      if (name !== 'claude') return createProvider(name, options)
      const provider: ReviewProvider = {
        id: 'fake-cli',
        review: (prompt) => {
          events.push('provider')
          prompts.push(prompt)
          return overrides.review?.() ?? Promise.resolve(OUTPUT)
        },
      }
      return provider
    },
  }
  return {
    deps,
    files,
    treeFetches,
    fileFetches,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    checkouts,
    closed: () => closed,
    fetches,
    stateFetches,
    posts,
    events,
    providers,
    prompts,
  }
}

function phadaState(threads: Partial<ReviewThread>[], findings = 1): PullRequestReviewState {
  return {
    viewer: 'octocat',
    reviews: [
      {
        id: 'R1',
        author: 'octocat',
        body: `Review\n\n${reviewMarker({ sha: HEAD_SHA, findings })}`,
        commitSha: HEAD_SHA,
      },
    ],
    threads: threads.map((thread) => ({
      isResolved: false,
      path: 'src/shop.ts',
      line: 3,
      author: 'octocat',
      body: `**P1** · spend has no auth · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
      reviewId: 'R1',
      ...thread,
    })),
  }
}

const WITH_FINDING: ReviewOutput = {
  ...OUTPUT,
  text: reviewReportJson({ findings: [findingFixture({ line: 3 })] }),
}

describe('run', () => {
  it('prints the usage and exits with 0 for --help', async () => {
    const h = harness()

    expect(await run(['--help'], h.deps)).toBe(0)
    expect(h.stdout()).toBe(`${USAGE}\n`)
    expect(h.fetches).toHaveLength(0)
  })

  it('prints the review usage for review --help', async () => {
    const h = harness()

    expect(await run(['review', '--help'], h.deps)).toBe(0)
    expect(h.stdout()).toBe(`${REVIEW_USAGE}\n`)
  })

  it('prints the version and exits with 0 for --version', async () => {
    const h = harness()

    expect(await run(['--version'], h.deps)).toBe(0)
    expect(h.stdout()).toBe('1.2.3\n')
    expect(h.stderr()).toBe('')
  })

  it('suggests the review command for a pull request given without it', async () => {
    const h = harness()

    expect(await run(['acme/shop#12'], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: Unknown command "acme/shop#12". Did you mean "phada review acme/shop#12"? Run with --help for usage.\n',
    )
    expect(h.fetches).toHaveLength(0)
  })

  it('reviews a pull request: progress on stderr, the review on stdout', async () => {
    const h = harness()

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.stderr()).toBe(
      [
        'Fetching acme/shop#12…',
        'acme/shop#12 · a1b2c3d · 2 files · +15 −1 · 523 B diff',
        'Context: no rules or docs',
        'Reviewing with fake-cli… (this can take a few minutes)',
        'Investigated: no tool calls',
        'Publishing the review…',
        `Published the review: ${REVIEW_URL}`,
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

    await run(['review', 'acme/shop#12', '--model', 'opus', '--language', 'pt-BR'], h.deps)

    expect(h.providers).toEqual([{ name: 'claude', options: { model: 'opus' } }])
    expect(h.prompts[0]?.instructions).toContain(
      'Write summary, change, title, why and fix in pt-BR;',
    )
    expect(h.posts[0]?.body).toContain('## Revisão do Phada 🦋: 5/5 (pronto para merge)')
    expect(h.posts[0]?.body).toContain('### Resumo')
    expect(h.stdout()).toContain(
      '**Nota de confiança: 5/5** (pronto para merge): nenhum problema encontrado',
    )
  })

  it('applies --min-confidence to the review', async () => {
    const text = reviewReportJson({ findings: [findingFixture({ confidence: 85 })] })
    const h = harness({ review: () => Promise.resolve({ ...OUTPUT, text }) })

    expect(await run(['review', 'acme/shop#12', '--min-confidence', '90'], h.deps)).toBe(0)
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

    expect(await run(['review', 'acme/shop#12', '--verify'], h.deps)).toBe(0)
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

    expect(await run(['review', 'acme/shop#12', '--verify', '--format', 'json'], quiet.deps)).toBe(
      1,
    )
    expect(await run(['review', 'acme/shop#12', '--verify', '--debug'], debug.deps)).toBe(1)
    expect(quiet.stdout()).toBe('')
    expect(quiet.stderr().split('\n').at(-2)).toBe(
      'phada: The AI did not return a valid review (no verdicts in the verification). Run with --debug to see its answer.',
    )
    expect(quiet.stderr()).not.toContain('All of them look fine')
    expect(debug.stderr()).toContain('AI answer (start):\nAll of them look fine to me.')
  })

  it('prints only the JSON review on stdout with --format json', async () => {
    const h = harness()

    expect(await run(['review', 'acme/shop#12', '--format', 'json'], h.deps)).toBe(0)
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

    expect(await run(['review', 'acme/shop#12', '--format', 'json'], h.deps)).toBe(0)
    expect(JSON.parse(h.stdout())).toMatchObject({ status: 'skipped', reason: 'empty-diff' })
    expect(h.stderr()).toContain('Nothing to review: the pull request has no changes.\n')
  })

  it('keeps errors on stderr and stdout empty with --format json', async () => {
    const h = harness({
      review: () =>
        Promise.reject(new ProviderError('claude-cli', 'not-authenticated', 'Not logged in')),
    })

    expect(await run(['review', 'acme/shop#12', '--format', 'json'], h.deps)).toBe(1)
    expect(h.stdout()).toBe('')
    expect(h.stderr()).toContain('phada: Claude Code is not logged in.')
  })

  it('rejects an unknown format with exit 2 before fetching', async () => {
    const h = harness()

    expect(await run(['review', 'acme/shop#12', '--format', 'xml'], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: Invalid --format "xml". Use markdown or json. Run with --help for usage.\n',
    )
    expect(h.fetches).toHaveLength(0)
  })

  it.each([{}, { GITHUB_TOKEN: '' }, { GITHUB_TOKEN: '  \n', GH_TOKEN: ' ' }])(
    'asks for a GitHub token when the environment is %j',
    async (env) => {
      const h = harness({ env })

      expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(1)
      expect(h.stderr()).toBe(
        'phada: No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN) to a token that can read the pull request and write reviews (read-only is enough with --dry-run), e.g. export GITHUB_TOKEN=$(gh auth token)\n',
      )
      expect(h.fetches).toHaveLength(0)
    },
  )

  it.each([
    ['only GH_TOKEN is set', { GH_TOKEN: TOKEN }],
    ['GITHUB_TOKEN is blank', { GITHUB_TOKEN: ' ', GH_TOKEN: TOKEN }],
    ['both are set', { GITHUB_TOKEN: TOKEN, GH_TOKEN: 'ghp_other' }],
  ])('reads GITHUB_TOKEN, then GH_TOKEN, when %s', async (_case, env) => {
    const h = harness({ env })

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.fetches[0]?.token).toBe(TOKEN)
  })

  it('trims the token read from the environment', async () => {
    const h = harness({ env: { GITHUB_TOKEN: `${TOKEN}\n` } })

    await run(['review', 'acme/shop#12'], h.deps)

    expect(h.fetches[0]?.token).toBe(TOKEN)
  })

  it('asks for --model with exit 2 before fetching when the provider is ollama', async () => {
    const h = harness()

    expect(await run(['review', 'acme/shop#12', '--provider', 'ollama'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('phada: --provider ollama needs --model')
    expect(h.fetches).toHaveLength(0)
  })

  it('rejects an unknown provider with exit 2 before fetching', async () => {
    const h = harness()

    expect(await run(['review', 'acme/shop#12', '--provider', 'gpt'], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: Unknown provider "gpt". Available: claude, codex, ollama. Run with --help for usage.\n',
    )
    expect(h.fetches).toHaveLength(0)
  })

  it('exits with 2 on a usage error', async () => {
    const h = harness()

    expect(await run(['review'], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: Missing the pull request to review. Run with --help for usage.\n',
    )
  })

  it('does not call the AI when the pull request has no changes', async () => {
    const h = harness({ pullRequest: () => Promise.resolve(pullRequestFixture({ diff: '' })) })

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(0)
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

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(1)
    expect(h.stderr().split('\n').at(-2)).toContain(message)
    expect(h.stdout()).toBe('')
  })

  it('shows the stack only with --debug', async () => {
    const failure = { pullRequest: () => Promise.reject(new Error('socket hang up')) }
    const quiet = harness(failure)
    const debug = harness(failure)

    await run(['review', 'acme/shop#12'], quiet.deps)
    await run(['review', 'acme/shop#12', '--debug'], debug.deps)

    expect(quiet.stderr()).not.toContain('    at ')
    expect(debug.stderr()).toContain('    at ')
  })

  it('never prints the token', async () => {
    const h = harness({
      pullRequest: () => Promise.reject(new Error('socket hang up')),
    })

    await run(['review', 'acme/shop#12', '--debug'], h.deps)

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

describe('run publishing', () => {
  const REVIEW = ['review', 'acme/shop#12']

  it('publishes the review after printing it', async () => {
    const h = harness({ review: () => Promise.resolve(WITH_FINDING) })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(h.events).toEqual(['provider', 'stdout', 'post'])
    expect(h.stdout()).toContain('# Review of acme/shop#12')
    expect(h.posts).toHaveLength(1)
    const [post] = h.posts
    expect(post).toMatchObject({
      owner: 'acme',
      repo: 'shop',
      number: 12,
      token: TOKEN,
      commitSha: HEAD_SHA,
      comments: [{ path: 'src/shop.ts', line: 3 }],
    })
    expect(post?.comments[0]?.body).toContain('**P1** · spend has no auth · confidence 90')
    expect(post?.body.endsWith(reviewMarker({ sha: HEAD_SHA, findings: 1 }))).toBe(true)
    expect(h.stderr()).toContain(
      `Publishing the review…\nPublished the review with 1 inline comment: ${REVIEW_URL}\n`,
    )
  })

  it('fetches the review state with the token and the ref', async () => {
    const h = harness()

    await run(REVIEW, h.deps)

    expect(h.stateFetches).toEqual([{ owner: 'acme', repo: 'shop', number: 12, token: TOKEN }])
  })

  it('skips before the provider when the same commit has open Phada threads', async () => {
    const h = harness({ reviewState: () => Promise.resolve(phadaState([{}])) })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(h.prompts).toHaveLength(0)
    expect(h.posts).toHaveLength(0)
    expect(h.stdout()).toBe('')
    expect(h.stderr().split('\n').at(-2)).toBe(
      'a1b2c3d already reviewed by Phada; 1 thread still open. Use --force to review again.',
    )
  })

  it('skips the same commit when its review found nothing', async () => {
    const h = harness({ reviewState: () => Promise.resolve(phadaState([], 0)) })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(h.prompts).toHaveLength(0)
    expect(h.stderr()).toContain('a1b2c3d already reviewed by Phada; nothing was found.')
  })

  it('prints a skipped run as JSON with --format json', async () => {
    const h = harness({ reviewState: () => Promise.resolve(phadaState([{}])) })

    expect(await run([...REVIEW, '--format', 'json'], h.deps)).toBe(0)
    expect(h.stdout()).toBe(
      formatAlreadyReviewedJson(pullRequestFixture(), { kind: 'open-threads', openThreads: 1 }),
    )
  })

  it('reviews the same commit again once every thread is resolved', async () => {
    const h = harness({
      reviewState: () => Promise.resolve(phadaState([{ isResolved: true }])),
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(h.prompts).toHaveLength(1)
    expect(h.posts[0]?.comments).toHaveLength(1)
  })

  it('reviews again with --force', async () => {
    const h = harness({ reviewState: () => Promise.resolve(phadaState([{}])) })

    expect(await run([...REVIEW, '--force'], h.deps)).toBe(0)
    expect(h.prompts).toHaveLength(1)
    expect(h.posts).toHaveLength(1)
  })

  it('never skips with --dry-run and posts nothing', async () => {
    const h = harness({
      reviewState: () =>
        Promise.resolve(phadaState([{ line: 40, body: `Other\n\n${FINDING_MARKER}` }])),
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run([...REVIEW, '--dry-run'], h.deps)).toBe(0)
    expect(h.prompts).toHaveLength(1)
    expect(h.posts).toHaveLength(0)
    expect(h.stdout()).toContain('## 🦋 Phada review: 3/5 (implementation issues)')
    expect(h.stdout()).toContain('===== Inline comment 1/1 · src/shop.ts:3 =====')
    expect(h.stderr()).toContain(
      'Dry run: nothing was posted.\nWithout --dry-run: a1b2c3d already reviewed by Phada; 1 thread still open. Use --force to review again.\n',
    )
  })

  it('prints the dry run as JSON with the review and the publication preview', async () => {
    const h = harness({ review: () => Promise.resolve(WITH_FINDING) })

    expect(await run([...REVIEW, '--dry-run', '--format', 'json'], h.deps)).toBe(0)
    const json = JSON.parse(h.stdout()) as Record<string, unknown>
    expect(json).toMatchObject({
      status: 'reviewed',
      review: { findings: [{ line: 3 }] },
      publication: {
        status: 'dry-run',
        comments: [{ path: 'src/shop.ts', line: 3 }],
        wouldSkip: null,
      },
    })
    expect(h.posts).toHaveLength(0)
  })

  it('does not repost a finding that has an open Phada thread', async () => {
    const old = phadaState([{ reviewId: 'old' }])
    const h = harness({
      reviewState: () => Promise.resolve({ ...old, reviews: [] }),
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(h.posts[0]?.comments).toEqual([])
    expect(h.posts[0]?.body).toContain(
      'No new problems in a1b2c3d. 1 Phada comment from previous reviews is still open',
    )
    expect(h.stderr()).toContain(
      `Published the review: ${REVIEW_URL} (1 finding still open from previous reviews)`,
    )
  })

  it('prints the review before a failing POST and exits with 1', async () => {
    const h = harness({
      review: () => Promise.resolve(WITH_FINDING),
      createReview: () => Promise.reject(new ReviewPermissionError('acme/shop#12')),
    })

    expect(await run(REVIEW, h.deps)).toBe(1)
    expect(h.stdout()).toContain('# Review of acme/shop#12')
    expect(h.stdout()).toContain('spend has no auth')
    expect(h.stderr().split('\n').at(-2)).toContain(
      'phada: GitHub denied publishing the review on acme/shop#12 (HTTP 403)',
    )
  })

  it('prints the JSON with the failed publication when the POST fails', async () => {
    const error = new ReviewPermissionError('acme/shop#12')
    const h = harness({ createReview: () => Promise.reject(error) })

    expect(await run([...REVIEW, '--format', 'json'], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout())).toMatchObject({
      status: 'reviewed',
      publication: { status: 'failed', error: error.message },
    })
  })

  it('prints the JSON after a successful POST with the URL', async () => {
    const h = harness({ review: () => Promise.resolve(WITH_FINDING) })

    expect(await run([...REVIEW, '--format', 'json'], h.deps)).toBe(0)
    expect(h.events).toEqual(['provider', 'post', 'stdout'])
    expect(JSON.parse(h.stdout())).toMatchObject({
      publication: { status: 'published', url: REVIEW_URL, comments: 1, stillOpen: 0 },
    })
  })

  it('does not post when the pull request has no changes', async () => {
    const h = harness({ pullRequest: () => Promise.resolve(pullRequestFixture({ diff: '' })) })

    expect(await run([...REVIEW, '--format', 'json'], h.deps)).toBe(0)
    expect(h.posts).toHaveLength(0)
    expect(JSON.parse(h.stdout())).toMatchObject({ status: 'skipped', publication: null })
  })

  it('stops before the provider when the review state cannot be read', async () => {
    const h = harness({
      reviewState: () => Promise.reject(new PullRequestNotFoundError('acme/shop#12')),
    })

    expect(await run(REVIEW, h.deps)).toBe(1)
    expect(h.prompts).toHaveLength(0)
    expect(h.posts).toHaveLength(0)
  })
})

describe('run init', () => {
  it('creates the repository config without a GitHub token', async () => {
    const h = harness({ env: {}, files: memoryFiles({}, ['/w/shop/.git']) })

    const exitCode = await run(['init'], h.deps)

    expect(exitCode).toBe(0)
    expect(h.stderr()).toBe('Created .phada/config.yml\nCreated .phada/rules.md\n')
    expect(h.files.files.has('/w/shop/.phada/config.yml')).toBe(true)
    expect(h.fetches).toEqual([])
  })

  it('fails with a usage error outside a git repository', async () => {
    const h = harness({ env: {} })

    expect(await run(['init'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('Not inside a git repository.')
  })
})

describe('run with config and repository context', () => {
  const BASE_SHA = '0000000000000000000000000000000000000000'

  it('fails with a usage error for an invalid user config before fetching the pull request', async () => {
    const h = harness({ files: memoryFiles({ '/cfg/config.yml': 'colour: red' }) })

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('Invalid config /cfg/config.yml: colour:')
    expect(h.fetches).toEqual([])
  })

  it('takes the provider and model from the user config, and the flags over them', async () => {
    const configured = harness({
      files: memoryFiles({ '/cfg/repos/acme/shop/config.yml': 'provider: claude\nmodel: sonnet' }),
    })
    await run(['review', 'acme/shop#12', '--dry-run'], configured.deps)

    const flagged = harness({ files: memoryFiles({ '/cfg/config.yml': 'model: sonnet' }) })
    await run(['review', 'acme/shop#12', '--dry-run', '--model', 'opus'], flagged.deps)

    expect(configured.providers).toEqual([{ name: 'claude', options: { model: 'sonnet' } }])
    expect(flagged.providers).toEqual([{ name: 'claude', options: { model: 'opus' } }])
  })

  it('reads the repository config and docs at the base commit and sends them to the AI', async () => {
    const h = harness({
      repoFiles: {
        '.phada/config.yml': 'language: pt-BR\nrules:\n  - id: orm-only\n    rule: Use the ORM.',
        'AGENTS.md': 'Keep handlers thin.',
      },
    })

    expect(await run(['review', 'acme/shop#12', '--dry-run'], h.deps)).toBe(0)

    expect(h.treeFetches).toEqual([{ sha: BASE_SHA }])
    expect(h.fileFetches.every((fetch) => fetch.ref === BASE_SHA)).toBe(true)
    expect(h.prompts[0]?.instructions).toContain('[orm-only] (files: **)\nUse the ORM.')
    expect(h.prompts[0]?.instructions).toContain('in pt-BR')
    expect(h.prompts[0]?.data).toContain('=== AGENTS.md ===\nKeep handlers thin.')
    expect(h.stderr()).toContain('Context: 1 rule · 1 doc (19 B)\n')
  })

  it('strips control characters from warnings about the repository config', async () => {
    const h = harness({ repoFiles: { '.phada/config.yml': '"\\e]8;;x\\a": 1' } })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.stderr()).toContain('Warning: Ignoring .phada/config.yml at 0000000:')
    expect(h.stderr()).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F]/)
  })

  it('lets --language win over the repository config', async () => {
    const h = harness({ repoFiles: { '.phada/config.yml': 'language: pt-BR' } })

    await run(['review', 'acme/shop#12', '--dry-run', '--language', 'en'], h.deps)

    expect(h.prompts[0]?.instructions).toContain('in en')
  })

  it('turns verification on from the config and off with --no-verify', async () => {
    const files = () => memoryFiles({ '/cfg/config.yml': 'verify: true' })
    const on = harness({ files: files(), review: () => Promise.resolve(WITH_FINDING) })
    const off = harness({ files: files(), review: () => Promise.resolve(WITH_FINDING) })

    await run(['review', 'acme/shop#12', '--dry-run'], on.deps)
    await run(['review', 'acme/shop#12', '--dry-run', '--no-verify'], off.deps)

    expect(on.prompts).toHaveLength(2)
    expect(off.prompts).toHaveLength(1)
  })

  it('skips a reviewed commit before reading the repository', async () => {
    const h = harness({ reviewState: () => Promise.resolve(phadaState([{}])) })

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.treeFetches).toEqual([])
  })

  it('reviews without the repository context when the token cannot read it', async () => {
    const h = harness({
      tree: () => Promise.reject(new Error('GitHub rejected the token (HTTP 403)')),
    })

    expect(await run(['review', 'acme/shop#12', '--dry-run'], h.deps)).toBe(0)
    expect(h.stderr()).toContain(
      'Could not read the repository at 0000000 (GitHub rejected the token (HTTP 403)): reviewing without its rules and docs.',
    )
    expect(h.prompts).toHaveLength(1)
  })

  it('posts a short note without calling the AI when every changed file is ignored', async () => {
    const diff = pullRequestFixture().diff.replaceAll('src/shop.ts', 'package-lock.json')
    const h = harness({ pullRequest: () => Promise.resolve(pullRequestFixture({ diff })) })

    expect(await run(['review', 'acme/shop#12', '--format', 'json'], h.deps)).toBe(0)
    expect(h.stderr()).toContain('Nothing to review: every changed file is ignored.')
    expect(h.stderr()).toContain(`Published the review: ${REVIEW_URL}`)
    expect(h.prompts).toEqual([])
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]).toMatchObject({ commitSha: HEAD_SHA, comments: [] })
    expect(h.posts[0]?.body).toContain('Left out of the review: `package-lock.json`')
    expect(h.posts[0]?.body).toContain(reviewMarker({ sha: HEAD_SHA, findings: 0 }))
    expect(JSON.parse(h.stdout())).toMatchObject({
      status: 'skipped',
      reason: 'all-ignored',
      publication: { status: 'published', url: REVIEW_URL, comments: 0, stillOpen: 0 },
      context: { ignored: ['package-lock.json'] },
    })
  })

  it('only previews the note with --dry-run', async () => {
    const diff = pullRequestFixture().diff.replaceAll('src/shop.ts', 'package-lock.json')
    const h = harness({ pullRequest: () => Promise.resolve(pullRequestFixture({ diff })) })

    expect(await run(['review', 'acme/shop#12', '--dry-run'], h.deps)).toBe(0)
    expect(h.posts).toEqual([])
    expect(h.stdout()).toContain('## 🦋 Phada review: nothing to review')
    expect(h.stdout()).toContain('Left out of the review: `package-lock.json`')
    expect(h.stderr()).toContain('Dry run: nothing was posted.')
  })

  it('prints the context in the JSON and after the dry-run preview', async () => {
    const repoFiles = { '.phada/rules.md': 'Use the ORM.' }
    const json = harness({ repoFiles })
    const markdown = harness({ repoFiles })

    await run(['review', 'acme/shop#12', '--dry-run', '--format', 'json'], json.deps)
    await run(['review', 'acme/shop#12', '--dry-run'], markdown.deps)

    expect(JSON.parse(json.stdout())).toMatchObject({
      context: { rules: [{ key: '.phada/rules.md', status: 'applied' }] },
    })
    expect(markdown.stdout()).toContain(
      '## Context sent to the AI\n\nRules:\n- .phada/rules.md (.phada/rules.md)\n',
    )
  })

  it('expands ~ in local files from the user config', async () => {
    const files = memoryFiles({
      '/cfg/config.yml': 'localFiles: ["~/notes/rules.md"]',
      '/home/u/notes/rules.md': 'Money is in cents.',
    })
    const h = harness({ files })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.prompts[0]?.data).toContain('=== local:/home/u/notes/rules.md ===\nMoney is in cents.')
  })
})

describe('run with the repository investigation', () => {
  it('fetches the reviewed head commit and gives the AI the tools', async () => {
    const h = harness()

    expect(await run(['review', 'acme/shop#12', '--dry-run'], h.deps)).toBe(0)

    expect(h.checkouts).toEqual([
      expect.objectContaining({ owner: 'acme', repo: 'shop', sha: HEAD_SHA, token: TOKEN }),
    ])
    expect(h.prompts[0]?.tools?.definitions.map((tool) => tool.name)).toEqual([
      'read_file',
      'grep',
      'list',
    ])
    expect(h.prompts[0]?.instructions).toContain('read_file, grep, list tools')
    expect(h.closed()).toBe(1)
    expect(h.stderr()).toContain('Investigated: no tool calls\n')
    expect(h.stdout()).toContain('## Investigation')
  })

  it('reports the calls of the AI', async () => {
    const h = harness({
      review: async () => OUTPUT,
    })
    h.deps.createProvider = (name, options) => {
      h.providers.push({ name, options })
      return {
        id: 'fake-cli',
        review: async (prompt) => {
          await prompt.tools?.call('read_file', { path: 'src/shop.ts' })
          await prompt.tools?.call('grep', { pattern: 'spend' })
          return OUTPUT
        },
      }
    }

    await run(['review', 'acme/shop#12', '--dry-run', '--format', 'json'], h.deps)

    expect(h.stderr()).toContain('Investigated: 1 read, 1 search (')
    const json = JSON.parse(h.stdout()) as { investigation: { status: string; totals: unknown } }
    expect(json.investigation.status).toBe('used')
    expect(json.investigation.totals).toMatchObject({ calls: 2 })
  })

  it('skips the investigation with --no-investigate or investigate: false', async () => {
    const flagged = harness()
    await run(['review', 'acme/shop#12', '--dry-run', '--no-investigate'], flagged.deps)
    const configured = harness({ repoFiles: { '.phada/config.yml': 'investigate: false' } })
    await run(['review', 'acme/shop#12', '--dry-run'], configured.deps)

    for (const h of [flagged, configured]) {
      expect(h.checkouts).toHaveLength(0)
      expect(h.prompts[0]?.tools).toBeUndefined()
      expect(h.stderr()).toContain('Investigation: off\n')
    }
  })

  it('reviews without the investigation when the head cannot be fetched', async () => {
    const h = harness({
      openCheckout: () =>
        Promise.reject(new CheckoutUnavailableError('git-missing', 'git was not found')),
    })

    expect(await run(['review', 'acme/shop#12', '--dry-run', '--format', 'json'], h.deps)).toBe(0)

    expect(h.prompts[0]?.tools).toBeUndefined()
    expect(h.stderr()).toContain('Warning: git was not found: reviewing without investigation.\n')
    const json = JSON.parse(h.stdout()) as { investigation: unknown }
    expect(json.investigation).toMatchObject({ status: 'unavailable', reason: 'git was not found' })
  })

  it('closes the checkout when the AI fails', async () => {
    const h = harness({
      review: () => Promise.reject(new ProviderError('claude-cli', 'failed', 'boom')),
    })

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(1)
    expect(h.closed()).toBe(1)
  })

  it('closes the checkout when the provider cannot be created', async () => {
    const h = harness()
    h.deps.createProvider = () => {
      throw new ProviderError('ollama', 'failed', 'OLLAMA_HOST "x" is not a valid address.')
    }

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(1)
    expect(h.checkouts).toHaveLength(1)
    expect(h.closed()).toBe(1)
  })

  it('does not fetch the head when every changed file is ignored', async () => {
    const h = harness({ pullRequest: () => Promise.resolve(pullRequestFixture({ diff: '' })) })

    await run(['review', 'acme/shop#12'], h.deps)

    expect(h.checkouts).toHaveLength(0)
  })

  it("passes the user's MCP servers to Claude", async () => {
    const h = harness({ files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear]' }) })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.providers[0]?.options).toEqual({ model: undefined, userMcpServers: ['linear'] })
  })

  it("leaves the user's MCP servers out when the investigation is off", async () => {
    const h = harness({ files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear]' }) })

    await run(['review', 'acme/shop#12', '--dry-run', '--no-investigate'], h.deps)

    expect(h.providers[0]?.options).not.toHaveProperty('userMcpServers')
  })

  it("leaves the user's MCP servers out when the head cannot be fetched", async () => {
    const h = harness({
      files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear]' }),
      openCheckout: () =>
        Promise.reject(new CheckoutUnavailableError('git-missing', 'git was not found')),
    })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.providers[0]?.options).not.toHaveProperty('userMcpServers')
    expect(h.stderr()).not.toContain('is public')
  })

  it('warns that MCP servers can leak into a review on a public repository', async () => {
    const h = harness({ files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear, notion]' }) })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.stderr()).toContain(
      'Warning: acme/shop is public: what the AI reads from linear, notion may end up in the published review.\n',
    )
  })

  it('does not warn on a private repository', async () => {
    const h = harness({
      files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear]' }),
      pullRequest: () => Promise.resolve(pullRequestFixture({ private: true })),
    })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.stderr()).not.toContain('is public')
  })

  it('refuses mcp with another provider before fetching', async () => {
    const h = harness({ files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear]' }) })

    expect(await run(['review', 'acme/shop#12', '--provider', 'codex'], h.deps)).toBe(2)
    expect(h.stderr()).toContain(
      'phada: mcp in your config works only with --provider claude for now.',
    )
    expect(h.fetches).toHaveLength(0)
  })

  it('prints the warnings of the provider', async () => {
    const h = harness({
      review: async () => ({ ...OUTPUT, warnings: ['model x cannot call tools'] }),
    })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.stderr()).toContain('Warning: model x cannot call tools\n')
  })
})
