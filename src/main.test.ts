import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { GitHubError } from './github/errors.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findingFixture } from '../test/support/finding.js'
import { memoryFiles } from '../test/support/memory-files.js'
import type { MemoryFiles } from '../test/support/memory-files.js'
import { pullRequestFixture } from '../test/support/pull-request.js'
import { reviewReportJson } from '../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../test/support/verification.js'
import { REVIEW_USAGE, USAGE } from './cli/args.js'
import { UsageError } from './cli/errors.js'
import { formatAlreadyReviewedJson } from './cli/format-json.js'
import type { ComparedFile, CompareOptions } from './github/compare-commits.js'
import type { CreateReviewOptions, CreatedReview } from './github/create-review.js'
import type { ReplyAndResolveOptions } from './github/resolve-thread.js'
import {
  GitHubPermissionError,
  PullRequestNotFoundError,
  ReviewPermissionError,
} from './github/errors.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
  ReviewThread,
} from './github/pull-request-reviews.js'
import type { FetchPullRequestOptions, PullRequest } from './github/pull-request.js'
import type { RepositoryTree } from './github/repository-files.js'
import type { Checkout } from './repository/checkout.js'
import { CheckoutUnavailableError } from './repository/git-checkout.js'
import type { GitMirror, GitMirrorOptions } from './repository/git-mirror.js'
import { createExtractor } from './repo-map/extract.js'
import { openIndexStore } from './store/index-store.js'
import { openObservedStore } from './store/observed-store.js'
import { MirrorLockTimeoutError } from './repository/mirror-lock.js'
import { HistoryVersionError, openHistoryStore } from './store/history-store.js'
import type { HistoryStore } from './store/history-store.js'
import { DatabaseSync } from 'node:sqlite'
import {
  FINDING_MARKER,
  parseReviewMarker,
  resolvedMarker,
  reviewMarker,
} from './publish/markers.js'
import { RECHECK_JSON_SCHEMA } from './review/recheck-schema.js'
import { providerRunsSkills } from './cli/provider-choice.js'
import type { ReviewEvent } from './cli/review-event.js'
import type { HookSettings } from './config/watch-settings.js'
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
const RECHECK_UNSURE: ReviewOutput = { text: '{"verdicts": []}', durationMs: 900 }
const RECHECK_FIXED: ReviewOutput = {
  text: JSON.stringify({
    verdicts: [{ id: 1, verdict: 'fixed', reason: 'The check is there now.' }],
  }),
  durationMs: 900,
}

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const REVIEW_URL = 'https://github.com/acme/shop/pull/12#pullrequestreview-1'
const EMPTY_STATE: PullRequestReviewState = {
  viewer: 'octocat',
  pullState: 'open',
  reviews: [],
  threads: [],
}

interface Harness {
  deps: MainDeps
  files: MemoryFiles
  treeFetches: { sha: string }[]
  fileFetches: { path: string; ref: string }[]
  stdout: () => string
  stderr: () => string
  fetches: FetchPullRequestOptions[]
  mcpChecks: [string, string[]][]
  stateFetches: FetchReviewStateOptions[]
  commentFetches: FetchReviewStateOptions[]
  ciFetches: string[]
  posts: CreateReviewOptions[]
  comparisons: CompareOptions[]
  replies: ReplyAndResolveOptions[]
  events: string[]
  providers: { name: string; options: ProviderOptions }[]
  prompts: ReviewPrompt[]
  checkouts: (GitMirrorOptions & { sha: string; keepAs: string })[]
  observedPaths: string[]
  closed: () => number
  mirrors: GitMirrorOptions[]
  storePaths: string[]
  historyFiles: string[]
  signal: () => void
  kills: () => number
  ghAsks: () => number
  aborts: number[]
  hooked: { event: ReviewEvent; settings: HookSettings }[]
  slack: { calls: string[]; tokens: { botToken: string; appToken: string }[] }
}

const storeDir = mkdtempSync(join(tmpdir(), 'phada-main-index-'))
afterAll(() => rmSync(storeDir, { recursive: true, force: true }))
let storeCount = 0
const extractor = createExtractor()

function memoryMirror(
  files: Record<string, string>,
  hooks: { onFetch?: (ref: string, keepAs: string) => void; onClose?: () => void } = {},
): GitMirror {
  const entries = Object.entries(files).map(([path, text], index) => ({
    path,
    oid: String(index + 1).padStart(40, 'a'),
    mode: '100644',
    size: Buffer.byteLength(text),
  }))
  return {
    dir: '/mirror',
    fetch: async (ref, keepAs) => {
      hooks.onFetch?.(ref, keepAs)
      return HEAD_SHA
    },
    checkout: () => ({
      ...memoryCheckout(hooks.onClose ?? (() => {})),
      readText: async (path) => files[path] ?? '',
    }),
    deepen: async () => false,
    listFiles: async () => entries,
    readBlobs: async function* (wanted) {
      for (const file of wanted) {
        yield { oid: file.oid, bytes: new Uint8Array(Buffer.from(files[file.path] ?? '')) }
      }
    },
  }
}

function memoryCheckout(onClose: () => void): Checkout {
  return {
    commit: HEAD_SHA,
    readText: async (path) => `contents of ${path}\n`,
    grep: async () => [],
    listDir: async () => [],
    history: async () => ({ commits: [], truncated: false }),
    close: async () => onClose(),
  }
}

function harness(
  overrides: {
    env?: NodeJS.ProcessEnv
    pullRequest?: () => Promise<PullRequest>
    review?: () => Promise<ReviewOutput>
    recheck?: () => Promise<ReviewOutput>
    reviewState?: () => Promise<PullRequestReviewState>
    createReview?: () => Promise<CreatedReview>
    compare?: () => Promise<ComparedFile[]>
    files?: MemoryFiles
    repoFiles?: Record<string, string>
    tree?: () => Promise<RepositoryTree>
    openMirror?: (options: GitMirrorOptions) => Promise<GitMirror>
    fetchRepository?: MainDeps['fetchRepository']
    openHistoryStore?: MainDeps['openHistoryStore']
    listPulls?: MainDeps['listOpenPullRequests']
    pullHead?: MainDeps['fetchPullRequestHead']
    withLock?: MainDeps['withLock']
    lockHolder?: number
    stdin?: string[][]
    beforeSleep?: () => Promise<void>
    hookWarning?: (event: ReviewEvent) => string | undefined
    slackMessages?: Record<string, unknown>[]
    comments?: MainDeps['listIssueComments']
    pullComments?: MainDeps['fetchPullComments']
    checkRuns?: MainDeps['fetchCheckRuns']
    ghToken?: MainDeps['ghToken']
  } = {},
): Harness {
  const checkouts: (GitMirrorOptions & { sha: string; keepAs: string })[] = []
  const observedPaths: string[] = []
  const mirrors: GitMirrorOptions[] = []
  const storePaths: string[] = []
  const historyFiles: string[] = []
  storeCount += 1
  const historyFile = join(storeDir, `history-${storeCount}.sqlite`)
  const signalHandlers: (() => void)[] = []
  const stdinRuns = [...(overrides.stdin ?? [])]
  const hooked: Harness['hooked'] = []
  const slack: Harness['slack'] = { calls: [], tokens: [] }
  const aborts: number[] = []
  let kills = 0
  let ghAsks = 0
  let clock = Date.parse('2026-10-18T12:00:00.000Z')
  let closed = 0
  const files = overrides.files ?? memoryFiles()
  const repoFiles = overrides.repoFiles ?? {}
  const treeFetches: { sha: string }[] = []
  const fileFetches: { path: string; ref: string }[] = []
  const out: string[] = []
  const err: string[] = []
  const fetches: FetchPullRequestOptions[] = []
  const mcpChecks: [string, string[]][] = []
  const stateFetches: FetchReviewStateOptions[] = []
  const commentFetches: FetchReviewStateOptions[] = []
  const ciFetches: string[] = []
  const posts: CreateReviewOptions[] = []
  const comparisons: CompareOptions[] = []
  const replies: ReplyAndResolveOptions[] = []
  const events: string[] = []
  const providers: { name: string; options: ProviderOptions }[] = []
  const prompts: ReviewPrompt[] = []
  const deps: MainDeps = {
    env: overrides.env ?? { GITHUB_TOKEN: TOKEN, PHADA_CONFIG_HOME: '/cfg' },
    ghToken: async () => {
      ghAsks += 1
      return overrides.ghToken?.()
    },
    version: '1.2.3',
    pid: 4321,
    cwd: '/w/shop',
    home: '/home/u',
    files,
    get stdin() {
      return Readable.from((stdinRuns.shift() ?? []).map((text) => `${text}\n`))
    },
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
    fetchPullComments: (options) => {
      commentFetches.push(options)
      return overrides.pullComments?.(options) ?? Promise.resolve([])
    },
    fetchCheckRuns: (options) => {
      const { owner, repo, token, sha } = options
      ciFetches.push(`runs ${owner}/${repo} ${sha} ${token === TOKEN ? 'token' : 'other'}`)
      return overrides.checkRuns?.(options) ?? Promise.resolve([])
    },
    fetchCommitStatuses: ({ owner, repo, sha }) => {
      ciFetches.push(`statuses ${owner}/${repo} ${sha}`)
      return Promise.resolve([])
    },
    fetchCheckAnnotations: () => Promise.resolve([]),
    fetchJobLog: () => Promise.reject(new Error('no job log in this test')),
    createReview: (options) => {
      events.push('post')
      posts.push(options)
      return overrides.createReview?.() ?? Promise.resolve({ url: REVIEW_URL })
    },
    fetchComparison: (options) => {
      comparisons.push(options)
      return overrides.compare?.() ?? Promise.resolve([])
    },
    replyAndResolve: async (options) => {
      events.push(`resolve ${options.threadId}`)
      replies.push(options)
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
    fetchRepository:
      overrides.fetchRepository ??
      ((options) => Promise.reject(new Error(`no repository ${options.owner}/${options.repo}`))),
    openMirror: (options) => {
      mirrors.push(options)
      return (
        overrides.openMirror?.(options) ??
        Promise.resolve(
          memoryMirror(
            { 'src/a.ts': 'export function a() { b() }\n' },
            {
              onFetch: (ref, keepAs) => {
                if (keepAs.startsWith('refs/phada/pull/')) {
                  checkouts.push({ ...options, sha: ref, keepAs })
                }
              },
              onClose: () => {
                closed += 1
              },
            },
          ),
        )
      )
    },
    openIndexStore: (path, version) => {
      storePaths.push(`${path} @${version}`)
      storeCount += 1
      return openIndexStore(join(storeDir, `${storeCount}.sqlite`))
    },
    openObservedStore: (path) => {
      observedPaths.push(path)
      storeCount += 1
      return openObservedStore(join(storeDir, `observed-${storeCount}.sqlite`))
    },
    openHistoryStore: (path) => {
      if (overrides.openHistoryStore !== undefined) return overrides.openHistoryStore(path)
      historyFiles.push(`${path} → ${historyFile}`)
      return openHistoryStore(historyFile)
    },
    listOpenPullRequests:
      overrides.listPulls ?? (() => Promise.resolve({ status: 'ok' as const, pulls: [] })),
    listIssueComments:
      overrides.comments ?? (() => Promise.resolve({ status: 'ok' as const, comments: [] })),
    addCommentReaction: async (options) => {
      events.push(`react ${options.commentId}`)
    },
    fetchPullRequestMetadata: () =>
      overrides.pullRequest?.() ?? Promise.resolve(pullRequestFixture()),
    fetchPullRequestHead:
      overrides.pullHead ??
      (() => Promise.resolve({ state: 'open' as const, draft: false, headSha: HEAD_SHA })),
    fetchBranchHead: () => Promise.resolve({ status: 'not-modified' as const }),
    withLock: overrides.withLock ?? ((_path, work) => work()),
    lockHolder: async () => overrides.lockHolder,
    onSignal: (handler) => signalHandlers.push(handler),
    killDetachedChildren: () => {
      kills += 1
    },
    abort: (code) => aborts.push(code),
    sleep: async (ms) => {
      await overrides.beforeSleep?.()
      clock += ms
    },
    clock: () => new Date(clock),
    runHook: async (event, settings) => {
      hooked.push({ event, settings })
      return overrides.hookWarning?.(event)
    },
    slackApi: (tokens) => {
      slack.tokens.push(tokens)
      return {
        postMessage: async (channel, thread, text) => {
          slack.calls.push(`post ${channel} ${thread} ${text.split('\n')[0]}`)
          if (overrides.slackMessages !== undefined) for (const handler of signalHandlers) handler()
        },
        addReaction: async (_channel, _ts, name) => {
          slack.calls.push(`+${name}`)
        },
        removeReaction: async (_channel, _ts, name) => {
          slack.calls.push(`-${name}`)
        },
        openConnection: async () => 'wss://slack.test',
      }
    },
    connectSlack: (options) => {
      for (const message of overrides.slackMessages ?? []) options.onEvent(message)
      return { close: () => slack.calls.push('closed') }
    },
    createExtractor: () => extractor,
    runsSkills: () => false,
    pathSize: async () => 2048,
    checkMcpNames: async (provider, names) => {
      if (names.length === 0) return undefined
      mcpChecks.push([provider, names.map(({ name }) => name)])
      return provider === 'claude' ? { provider, names: [...names] } : undefined
    },
    createProvider: (name, options) => {
      providers.push({ name, options })
      if (name !== 'claude') return createProvider(name, options)
      const provider: ReviewProvider = {
        id: 'fake-cli',
        review: (prompt) => {
          events.push('provider')
          prompts.push(prompt)
          if (prompt.outputSchema === RECHECK_JSON_SCHEMA) {
            return overrides.recheck?.() ?? Promise.resolve(RECHECK_UNSURE)
          }
          return overrides.review?.() ?? Promise.resolve(OUTPUT)
        },
      }
      return provider
    },
  }
  return {
    deps,
    hooked,
    slack,
    files,
    treeFetches,
    fileFetches,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    checkouts,
    observedPaths,
    closed: () => closed,
    mirrors,
    storePaths,
    historyFiles,
    signal: () => {
      for (const handler of signalHandlers) handler()
    },
    kills: () => kills,
    ghAsks: () => ghAsks,
    aborts,
    fetches,
    mcpChecks,
    stateFetches,
    commentFetches,
    ciFetches,
    posts,
    comparisons,
    replies,
    events,
    providers,
    prompts,
  }
}

function phadaState(threads: Partial<ReviewThread>[], findings = 1): PullRequestReviewState {
  return {
    viewer: 'octocat',
    pullState: 'open',
    reviews: [
      {
        id: 'R1',
        author: 'octocat',
        body: `Review\n\n${reviewMarker({ sha: HEAD_SHA, findings })}`,
        commitSha: HEAD_SHA,
      },
    ],
    threads: threads.map((thread, index) => ({
      id: `T${index + 1}`,
      isResolved: false,
      isOutdated: false,
      path: 'src/shop.ts',
      line: 3,
      author: 'octocat',
      body: `**P1** · spend has no auth · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
      reviewId: 'R1',
      url: '',
      negativeReactions: 0,
      replies: [],
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

  it('keeps the missing command error without a terminal', async () => {
    const h = harness()

    expect(await run([], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: Missing the command, e.g. phada review owner/repo#123. Run with --help for usage.\n',
    )
    expect(h.stdout()).toBe('')
  })

  it('refuses --debug alone without a terminal as before the app, without details', async () => {
    const h = harness()

    expect(await run(['--debug'], h.deps)).toBe(2)
    expect(h.stderr()).toBe("phada: Unknown option '--debug'. Run with --help for usage.\n")
    expect(h.stdout()).toBe('')
  })

  it('opens the app with no command in a terminal and exits with its code', async () => {
    const h = harness()
    const opened: string[] = []
    const deps: MainDeps = {
      ...h.deps,
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
      stdout: { write: () => true, isTTY: true },
      loadApp: async () => ({
        openApp: async ({ version }) => {
          opened.push(version)
          return { kind: 'terminated' }
        },
      }),
    }

    expect(await run([], deps)).toBe(143)
    expect(opened).toEqual(['1.2.3'])
    expect(h.stderr()).toBe('')
  })

  it('refuses phada setup without a terminal', async () => {
    const h = harness()

    expect(await run(['setup'], h.deps)).toBe(2)
    expect(h.stderr()).toBe(
      'phada: phada setup needs an interactive terminal. Run with --help for usage.\n',
    )
  })

  it('opens the app on the setup for phada setup in a terminal', async () => {
    const h = harness()
    const starts: string[] = []
    const deps: MainDeps = {
      ...h.deps,
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
      stdout: { write: () => true, isTTY: true },
      loadApp: async () => ({
        openApp: async ({ start }) => {
          starts.push(start)
          return { kind: 'quit' }
        },
      }),
    }

    expect(await run(['setup'], deps)).toBe(0)
    expect(starts).toEqual(['setup'])
  })

  it('prints the error the app failed with in one line, with the details under --debug', async () => {
    const h = harness()
    const failure = new Error('the screen broke')
    const deps: MainDeps = {
      ...h.deps,
      stdin: Object.assign(Readable.from([]), { isTTY: true }),
      stdout: { write: () => true, isTTY: true },
      loadApp: async () => ({ openApp: async () => ({ kind: 'failed', error: failure }) }),
    }

    expect(await run([], deps)).toBe(1)
    expect(h.stderr()).toBe(
      'phada: Unexpected error: the screen broke. Run with --debug for details.\n',
    )
    expect(await run(['--debug'], deps)).toBe(1)
    expect(h.stderr()).toContain('Error: the screen broke\n    at ')
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

    expect(await run(['review', 'acme/shop#12', '--no-verify'], h.deps)).toBe(0)
    expect(h.stderr()).toBe(
      [
        'Fetching acme/shop#12…',
        'acme/shop#12 · a1b2c3d · 2 files · +15 −1 · 523 B diff',
        'Context at base 0000000: no rules or docs',
        'Indexing 1 file…',
        'Impact: no indexed symbols changed',
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
    expect(h.posts[0]?.body).toContain('## 🦋 5/5 (pronto para merge)')
    expect(h.posts[0]?.body).toContain('### Resumo')
    expect(h.stdout()).toContain(
      '**Nota de confiança: 5/5** (pronto para merge): nenhum problema encontrado',
    )
  })

  it('applies --min-confidence to the review', async () => {
    const text = reviewReportJson({ findings: [findingFixture({ confidence: 85 })] })
    const h = harness({ review: () => Promise.resolve({ ...OUTPUT, text }) })

    expect(
      await run(['review', 'acme/shop#12', '--no-verify', '--min-confidence', '90'], h.deps),
    ).toBe(0)
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
        'phada: No GitHub token found. Log in with gh auth login, or set GITHUB_TOKEN (or GH_TOKEN) to a token that can read the pull request and write reviews (read-only is enough with --dry-run).\n',
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

describe('the GitHub token from the gh login', () => {
  const NO_TOKEN = { PHADA_CONFIG_HOME: '/cfg' }
  const WATCH_CONFIG = 'verify: false\nci:\n  wait: 0s\nwatch:\n  repos: [acme/shop]\n'
  const watched = () => memoryFiles({ '/cfg/config.yml': WATCH_CONFIG })
  const fromGh = async () => TOKEN
  const reviewRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'review_pull_request', arguments: { pr: 'acme/shop#12' } },
  })

  it.each<[string, string[], (h: Harness) => unknown]>([
    ['review', ['review', 'acme/shop#12'], (h) => h.fetches[0]?.token],
    ['rules', ['rules', 'acme/shop#12'], (h) => h.fetches[0]?.token],
    ['prompt', ['prompt', 'acme/shop#12'], (h) => h.fetches[0]?.token],
    ['index', ['index', 'acme/shop'], (h) => h.mirrors[0]?.token],
    [
      'history --refresh',
      ['history', 'acme/shop#12', '--refresh'],
      (h) => h.stateFetches[0]?.token,
    ],
  ])('runs %s with the token of gh when the environment has none', async (_name, argv, used) => {
    const h = harness({ env: NO_TOKEN, ghToken: fromGh })

    expect(await run(argv, h.deps)).toBe(0)
    expect(used(h)).toBe(TOKEN)
    expect(h.ghAsks()).toBe(1)
  })

  it('runs watch with the token of gh when the environment has none', async () => {
    const tokens: string[] = []
    const h = harness({
      env: NO_TOKEN,
      ghToken: fromGh,
      files: watched(),
      listPulls: async ({ token }) => {
        tokens.push(token)
        return { status: 'ok' as const, pulls: [] }
      },
    })

    expect(await run(['watch', '--once'], h.deps)).toBe(0)
    expect(tokens).toEqual([TOKEN])
  })

  it('runs enqueue with the token of gh when the environment has none', async () => {
    const h = harness({ env: NO_TOKEN, ghToken: fromGh, files: watched() })

    expect(await run(['enqueue', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.stdout()).toBe('Queued acme/shop#12 at a1b2c3d (job 1).\n')
  })

  it('lets the MCP server ask for reviews with the token of gh', async () => {
    const h = harness({
      env: NO_TOKEN,
      ghToken: fromGh,
      files: watched(),
      stdin: [[reviewRequest]],
    })

    expect(await run(['mcp'], h.deps)).toBe(0)
    expect(h.stdout()).toContain('"isError":false')
    expect(h.stdout()).toContain('\\"status\\": \\"queued\\"')
  })

  it('never asks gh when the environment has a token', async () => {
    const h = harness({ ghToken: async () => 'gho_unused' })

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.fetches[0]?.token).toBe(TOKEN)
    expect(h.ghAsks()).toBe(0)
  })

  it('asks to log in with gh or to set GITHUB_TOKEN when gh has no token either', async () => {
    const h = harness({ env: NO_TOKEN })

    expect(await run(['review', 'acme/shop#12'], h.deps)).toBe(1)
    expect(h.stderr()).toMatch(/^phada: No GitHub token found\. /)
    expect(h.stderr()).toContain('gh auth login')
    expect(h.stderr()).toContain('GITHUB_TOKEN')
    expect(h.fetches).toHaveLength(0)
  })

  it('never prints the token of gh', async () => {
    const h = harness({
      env: NO_TOKEN,
      ghToken: fromGh,
      pullRequest: () => Promise.reject(new Error('socket hang up')),
    })

    expect(await run(['review', 'acme/shop#12', '--debug'], h.deps)).toBe(1)
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
  const REVIEW = ['review', 'acme/shop#12', '--no-verify']

  describe('comments from an earlier commit', () => {
    const OLD_SHA = '0'.repeat(40)
    const earlier = (): Promise<PullRequestReviewState> =>
      Promise.resolve({
        viewer: 'octocat',
        pullState: 'open',
        reviews: [
          {
            id: 'R0',
            author: 'octocat',
            body: reviewMarker({ sha: OLD_SHA, findings: 1 }),
            commitSha: OLD_SHA,
          },
        ],
        threads: [
          {
            id: 'T1',
            isResolved: false,
            isOutdated: false,
            path: 'src/shop.ts',
            line: 3,
            author: 'octocat',
            body: `**P1** · Balance leaks · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
            reviewId: 'R0',
            url: '',
            negativeReactions: 0,
            replies: [],
          },
        ],
      })
    const fixed = () => Promise.resolve(RECHECK_FIXED)
    const changed = () =>
      Promise.resolve([{ path: 'src/shop.ts', status: 'modified', patch: '@@ -3 +3 @@' }])

    it('rechecks them and resolves the fixed one before publishing', async () => {
      const h = harness({ reviewState: earlier, compare: changed, recheck: fixed })

      expect(await run(REVIEW, h.deps)).toBe(0)
      expect(h.comparisons).toEqual([
        expect.objectContaining({ owner: 'acme', repo: 'shop', base: OLD_SHA, head: HEAD_SHA }),
      ])
      expect(h.replies).toEqual([
        {
          token: TOKEN,
          threadId: 'T1',
          body: `Fixed in \`${HEAD_SHA.slice(0, 7)}\`: The check is there now.\n\n${resolvedMarker(HEAD_SHA)}`,
        },
      ])
      expect(h.events.slice(-2)).toEqual(['resolve T1', 'post'])
      expect(h.stderr()).toContain(
        'Rechecked 1 comment from previous reviews: 1 fixed, 0 still valid, 0 unsure.\n',
      )
      expect(h.stderr()).toContain('Resolved 1 of 1 comment found fixed.\n')
    })

    it('prints the recheck and the resolved threads in the JSON', async () => {
      const h = harness({ reviewState: earlier, compare: changed, recheck: fixed })

      await run([...REVIEW, '--format', 'json'], h.deps)

      expect(JSON.parse(h.stdout())).toMatchObject({
        recheck: { threads: 1, fixed: 1, verdicts: [{ threadId: 'T1', verdict: 'fixed' }] },
        publication: { status: 'published', resolved: { resolved: 1, failed: 0, total: 1 } },
      })
    })

    it('says what it would resolve on a dry run and resolves nothing', async () => {
      const h = harness({ reviewState: earlier, compare: changed, recheck: fixed })

      await run([...REVIEW, '--dry-run'], h.deps)

      expect(h.replies).toEqual([])
      expect(h.stderr()).toContain('Without --dry-run: 1 fixed comment would be resolved.\n')
    })

    it('neither rechecks nor resolves with --no-resolve', async () => {
      const h = harness({ reviewState: earlier, compare: changed, recheck: fixed })

      await run([...REVIEW, '--no-resolve'], h.deps)

      expect([h.comparisons, h.replies]).toEqual([[], []])
    })
  })

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
    expect(post?.body.trimEnd().endsWith(' -->')).toBe(true)
    expect(parseReviewMarker(post?.body ?? '')).toMatchObject({ sha: HEAD_SHA, findings: 1 })
    expect(h.stderr()).toContain(
      `Publishing the review…\nPublished the review with 1 inline comment: ${REVIEW_URL}\n`,
    )
  })

  it('fetches the review state with the token and the ref', async () => {
    const h = harness()

    await run(REVIEW, h.deps)

    expect(h.stateFetches).toEqual([{ owner: 'acme', repo: 'shop', number: 12, token: TOKEN }])
  })

  it('reads the pull request comments with the token, unless --no-conversation', async () => {
    const h = harness()
    const off = harness()

    await run(REVIEW, h.deps)
    await run([...REVIEW, '--no-conversation'], off.deps)

    expect(h.commentFetches).toEqual([{ owner: 'acme', repo: 'shop', number: 12, token: TOKEN }])
    expect(off.commentFetches).toEqual([])
  })

  it('reads the checks of the head with the token, unless --no-ci', async () => {
    const h = harness()
    const off = harness()
    const sha = pullRequestFixture().headSha

    await run(REVIEW, h.deps)
    await run([...REVIEW, '--no-ci'], off.deps)

    expect(h.ciFetches).toEqual([`runs acme/shop ${sha} token`, `statuses acme/shop ${sha}`])
    expect(off.ciFetches).toEqual([])
  })

  it('shows the conversation and the CI on stderr, in the dry run and in the JSON', async () => {
    const conversation = {
      pullComments: async () => [
        {
          id: 'c1',
          author: 'alice',
          bot: false,
          association: 'MEMBER',
          createdAt: '2026-10-20T10:00:00Z',
          body: 'Please keep the old endpoint.',
        },
        {
          id: 'c2',
          author: 'ci-bot',
          bot: true,
          association: 'NONE',
          createdAt: '2026-10-20T11:00:00Z',
          body: 'Coverage dropped.',
        },
      ],
      checkRuns: async () => [
        {
          id: 7,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          title: '1 failed',
          summary: null,
          url: null,
          app: 'other',
          startedAt: null,
          completedAt: null,
        },
        {
          id: 8,
          name: 'e2e',
          status: 'in_progress',
          conclusion: null,
          title: null,
          summary: null,
          url: null,
          app: 'other',
          startedAt: null,
          completedAt: null,
        },
        {
          id: 9,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          title: null,
          summary: null,
          url: null,
          app: 'other',
          startedAt: null,
          completedAt: null,
        },
      ],
    }
    const markdown = harness(conversation)
    const json = harness(conversation)
    const off = harness(conversation)

    await run(['review', 'acme/shop#12', '--dry-run'], markdown.deps)
    await run(['review', 'acme/shop#12', '--dry-run', '--format', 'json'], json.deps)
    await run(
      ['review', 'acme/shop#12', '--dry-run', '--format', 'json', '--no-conversation', '--no-ci'],
      off.deps,
    )

    expect(markdown.stderr()).toContain(
      'Conversation: 2 comments (1 bot)\nCI: 3 checks, 1 failing (test), 1 pending\n',
    )
    expect(markdown.stdout()).toContain(
      '## Conversation sent to the AI\n\n- comment by alice (member), 2026-10-20 10:00\n- comment by ci-bot (bot), 2026-10-20 11:00\n',
    )
    expect(markdown.stdout()).toContain(
      '## CI sent to the AI\n\n- test: failing (failure)\n- e2e: pending\n- build: passing\n',
    )
    expect(JSON.parse(json.stdout())).toMatchObject({
      conversation: {
        items: [
          { kind: 'comment', author: 'alice', role: 'member' },
          { kind: 'comment', author: 'ci-bot', role: 'bot' },
        ],
        count: 2,
        omitted: 0,
        bots: 1,
      },
      ci: {
        state: 'failing',
        total: 3,
        failing: ['test'],
        pending: ['e2e'],
        checks: [
          { name: 'test', state: 'failing', conclusion: 'failure' },
          { name: 'e2e', state: 'pending' },
          { name: 'build', state: 'passing' },
        ],
        warnings: [],
      },
    })
    expect(JSON.parse(off.stdout())).toMatchObject({ conversation: null, ci: null })
    expect(off.stderr()).not.toContain('Conversation:')
    expect(off.stderr()).not.toContain('CI:')
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

  it('reviews the same commit again once every thread is resolved, without reposting them', async () => {
    const h = harness({
      reviewState: () => Promise.resolve(phadaState([{ isResolved: true }])),
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(h.prompts).toHaveLength(1)
    expect(h.posts[0]?.comments).toHaveLength(0)
    expect(h.stderr()).toContain('(1 finding dismissed earlier, not posted again)')
  })

  it('counts the dismissed findings in the JSON publication', async () => {
    const h = harness({
      reviewState: () => Promise.resolve(phadaState([{ isResolved: true }])),
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run([...REVIEW, '--format', 'json'], h.deps)).toBe(0)
    expect(JSON.parse(h.stdout())).toMatchObject({ publication: { comments: 0, dismissed: 1 } })
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
    expect(h.stdout()).toContain('## 🦋 3/5 (implementation issues)')
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
      'No new problems in a1b2c3d. 1 comment from previous reviews is still open',
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
    expect(h.stderr()).toContain('Context at base 0000000: 1 rule · 1 doc (19 B)\n')
  })

  it('sends the .claude/rules whose paths match the changed files as rules, naming the base', async () => {
    const h = harness({
      repoFiles: {
        '.claude/rules/greeting.md': '---\npaths:\n  - "src/**/*.ts"\n---\nGreet in English.\n',
        '.claude/rules/web.md': '---\npaths: web/**\n---\nUse hooks.\n',
      },
    })

    expect(await run(['review', 'acme/shop#12', '--dry-run'], h.deps)).toBe(0)

    expect(h.prompts[0]?.instructions).toContain(
      '[.claude/rules/greeting.md] (files: src/**/*.ts)\nGreet in English.',
    )
    expect(h.prompts[0]?.instructions).not.toContain('Use hooks.')
    expect(h.prompts[0]?.data).not.toContain('=== .claude/rules/')
    expect(h.stderr()).toContain('Context at base 0000000: 1 rule · 0 docs\n')
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

  it('verifies the findings by default and turns it off from the config or --no-verify', async () => {
    const plain = harness({ review: () => Promise.resolve(WITH_FINDING) })
    const configured = harness({
      files: memoryFiles({ '/cfg/config.yml': 'verify: false' }),
      review: () => Promise.resolve(WITH_FINDING),
    })
    const flagged = harness({ review: () => Promise.resolve(WITH_FINDING) })

    await run(['review', 'acme/shop#12', '--dry-run'], plain.deps)
    await run(['review', 'acme/shop#12', '--dry-run'], configured.deps)
    await run(['review', 'acme/shop#12', '--dry-run', '--no-verify'], flagged.deps)

    expect(plain.prompts).toHaveLength(2)
    expect(plain.prompts[1]?.data).toContain('<<<PHADA_FINDINGS_')
    expect(configured.prompts).toHaveLength(1)
    expect(flagged.prompts).toHaveLength(1)
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
    expect(parseReviewMarker(h.posts[0]?.body ?? '')).toMatchObject({ sha: HEAD_SHA, findings: 0 })
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
    expect(h.stdout()).toContain('## 🦋 nothing to review')
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
  it('reads the head from the mirror in the cache folder', async () => {
    const cached = harness({ env: { GITHUB_TOKEN: TOKEN, PHADA_CACHE_HOME: '/cache' } })
    await run(['review', 'acme/shop#12', '--dry-run'], cached.deps)
    expect(cached.checkouts[0]?.dir).toBe('/cache/repos/acme/shop.git')

    const plain = harness({ env: { GITHUB_TOKEN: TOKEN } })
    await run(['review', 'Acme/Shop#12', '--dry-run'], plain.deps)
    expect(plain.checkouts[0]?.dir).toBe('/home/u/.cache/phada/repos/acme/shop.git')
  })

  it('fetches the reviewed head commit and gives the AI the tools', async () => {
    const h = harness()

    expect(await run(['review', 'acme/shop#12', '--dry-run'], h.deps)).toBe(0)

    expect(h.checkouts).toEqual([
      expect.objectContaining({
        owner: 'acme',
        repo: 'shop',
        sha: HEAD_SHA,
        keepAs: 'refs/phada/pull/12',
        token: TOKEN,
      }),
    ])
    expect(h.prompts[0]?.tools?.definitions.map((tool) => tool.name)).toEqual([
      'read_file',
      'grep',
      'list',
      'history',
      'find_symbol',
      'callers',
      'dependencies',
      'similar',
    ])
    expect(h.prompts[0]?.instructions).toContain('read_file, grep, list tools')
    expect(h.storePaths).toEqual(['/home/u/.cache/phada/index/acme/shop.sqlite @1.2.3'])
    expect(h.observedPaths).toEqual(['/home/u/.cache/phada/observed/acme/shop.sqlite'])
    expect(h.closed()).toBe(1)
    expect(h.stderr()).toContain('Investigated: no tool calls\n')
    expect(h.stdout()).toContain('## Investigation')
  })

  it('leaves the related repositories out of the dry run when none is declared', async () => {
    const h = harness()

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.stdout()).not.toContain('## Related repositories')
    expect(h.stderr()).not.toContain('Related:')
  })

  it('shows the impact of the diff on stderr, in the dry run and in the JSON', async () => {
    const shop = [
      "import { db } from './db'",
      '',
      'export async function spend(userId: string, amount: number) {',
      '  const user = await db.user.find(userId)',
      "  if (user.crystals < amount) throw new Error('insufficient crystals')",
      '  await db.user.update(userId, { crystals: user.crystals - amount })',
      '  return user.crystals - amount',
      '}',
      '',
    ].join('\n')
    const files = {
      'src/shop.ts': shop,
      'src/api.ts':
        "import { spend } from './shop'\nexport function buy(id: string) {\n  return spend(id, 1)\n}\n",
    }
    const markdown = harness({ openMirror: async () => memoryMirror(files) })
    const json = harness({ openMirror: async () => memoryMirror(files) })

    await run(['review', 'acme/shop#12', '--dry-run'], markdown.deps)
    await run(['review', 'acme/shop#12', '--dry-run', '--format', 'json'], json.deps)

    expect(markdown.stderr()).toContain('Impact: 1 changed symbol · 1 caller in 1 file\n')
    expect(markdown.stdout()).toContain(
      '## Impact\n\nfunction spend (src/shop.ts:3-8, exported) — 1 caller in 1 file\n  src/api.ts:3 in buy: return spend(id, 1)\n',
    )
    expect(markdown.prompts[0]?.data).toContain('<<<PHADA_IMPACT_')
    expect(JSON.parse(json.stdout())).toMatchObject({
      impact: { status: 'used', totals: { symbols: 1, callers: 1, files: 1 } },
    })
  })

  it('reads the related repositories and reports them on stderr, in the dry run and in the JSON', async () => {
    const shop = {
      'package.json': '{ "name": "shop", "main": "src/shop.ts" }\n',
      'src/shop.ts': [
        "import { db } from './db'",
        '',
        'export async function spend(userId: string, amount: number) {',
        '  const user = await db.user.find(userId)',
        "  if (user.crystals < amount) throw new Error('insufficient crystals')",
        '  await db.user.update(userId, { crystals: user.crystals - amount })',
        '  return user.crystals - amount',
        '}',
        '',
      ].join('\n'),
    }
    const web = {
      'package.json': '{ "name": "web", "dependencies": { "shop": "^1" } }\n',
      'src/web.ts': "import { spend } from 'shop'\nexport const paid = spend('u1', 2)\n",
    }
    const options = {
      repoFiles: { '.phada/config.yml': 'context:\n  repos: [acme/web]\n' },
      openMirror: async ({ repo }: GitMirrorOptions) => memoryMirror(repo === 'web' ? web : shop),
      fetchRepository: async ({ owner, repo }: { owner: string; repo: string }) => ({
        repo: `${owner}/${repo}`,
        private: false,
        defaultBranch: 'main',
        empty: false,
      }),
    }
    const markdown = harness(options)
    const json = harness(options)

    await run(['review', 'acme/shop#12', '--dry-run'], markdown.deps)
    await run(['review', 'acme/shop#12', '--dry-run', '--format', 'json'], json.deps)

    expect(markdown.stderr()).toContain('Related: acme/web (consumer, 1 call site)\n')
    expect(markdown.stdout()).toContain('## Related repositories\n\n- acme/web at ')
    expect(markdown.mirrors.map((mirror) => mirror.dir)).toContain(
      '/home/u/.cache/phada/repos/acme/web.git',
    )
    expect(markdown.prompts[0]?.data).toContain('acme/web:src/web.ts:2')
    expect(JSON.parse(json.stdout())).toMatchObject({
      related: {
        status: 'used',
        repositories: [{ repo: 'acme/web', state: 'consumers', count: 1 }],
      },
    })
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
      openMirror: () =>
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

    expect(h.providers[0]?.options).toEqual({
      model: undefined,
      mcpNames: { provider: 'claude', names: [{ name: 'linear' }] },
    })
    expect(h.mcpChecks).toEqual([['claude', ['linear']]])
  })

  it("leaves the user's MCP servers out when the investigation is off", async () => {
    const h = harness({ files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear]' }) })

    await run(['review', 'acme/shop#12', '--dry-run', '--no-investigate'], h.deps)

    expect(h.providers[0]?.options).not.toHaveProperty('mcpNames')
  })

  it("leaves the user's MCP servers out when the head cannot be fetched", async () => {
    const h = harness({
      files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear]' }),
      openMirror: () =>
        Promise.reject(new CheckoutUnavailableError('git-missing', 'git was not found')),
    })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.providers[0]?.options).not.toHaveProperty('mcpNames')
    expect(h.stderr()).not.toContain('is public')
  })

  it('checks no MCP server name without mcp in the config', async () => {
    const h = harness()

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(h.mcpChecks).toEqual([])
  })

  it('stops before fetching when a variable of a declared MCP server is not set', async () => {
    const h = harness({
      files: memoryFiles({
        '/cfg/config.yml':
          "mcp: [{ name: tickets, command: node, env: { TICKETS_TOKEN: '${TICKETS_TOKEN}' } }]",
      }),
    })

    expect(await run(['review', 'acme/shop#12', '--dry-run'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('mcp server tickets: TICKETS_TOKEN is not set.')
    expect(h.fetches).toHaveLength(0)
  })

  it('stops before fetching when a named MCP server is unknown', async () => {
    const h = harness({ files: memoryFiles({ '/cfg/config.yml': 'mcp: [nope]' }) })
    h.deps.checkMcpNames = async () => {
      throw new UsageError('Claude Code has no MCP server named "nope".')
    }

    expect(await run(['review', 'acme/shop#12', '--dry-run'], h.deps)).toBe(2)
    expect(h.fetches).toHaveLength(0)
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

  it('refuses a named MCP server with Ollama before fetching', async () => {
    const h = harness({ files: memoryFiles({ '/cfg/config.yml': 'mcp: [linear]' }) })

    expect(
      await run(['review', 'acme/shop#12', '--provider', 'ollama', '--model', 'qwen'], h.deps),
    ).toBe(2)
    expect(h.stderr()).toContain(
      'phada: MCP server linear: Ollama has no MCP servers of its own; declare it with command or url in your config.',
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

describe('run index', () => {
  it('asks for a token that can read the repository', async () => {
    const h = harness({ env: {} })

    expect(await run(['index', 'acme/shop'], h.deps)).toBe(1)
    expect(h.stderr()).toMatch(
      /^phada: No GitHub token found\. Log in with gh auth login, or set GITHUB_TOKEN \(or GH_TOKEN\) to a token that can read the repository contents\.$/m,
    )
  })

  it('indexes the repository from its mirror into the cache folder', async () => {
    const h = harness({ env: { GITHUB_TOKEN: TOKEN, PHADA_CACHE_HOME: '/cache' } })

    expect(await run(['index', 'Acme/Shop'], h.deps)).toBe(0)

    expect(h.mirrors).toEqual([
      expect.objectContaining({
        dir: '/cache/repos/acme/shop.git',
        owner: 'Acme',
        repo: 'Shop',
        token: TOKEN,
      }),
    ])
    expect(h.storePaths).toEqual(['/cache/index/acme/shop.sqlite @1.2.3'])
    expect(h.stderr()).toContain('Fetching Acme/Shop (default branch)…\n')
    expect(h.stderr()).toContain('Indexing 1 file…\n')
    expect(h.stdout()).toMatch(/^Indexed Acme\/Shop at [0-9a-f]{7} \(default branch\) in /)
    expect(h.stdout()).toContain('Symbols: 1 function\n')
  })

  it('prints JSON and fetches the ref asked for', async () => {
    const h = harness({ env: { GITHUB_TOKEN: TOKEN, PHADA_CACHE_HOME: '/cache' } })

    expect(await run(['index', 'acme/shop', '--ref', 'main', '--format', 'json'], h.deps)).toBe(0)

    const json = JSON.parse(h.stdout())
    expect(json).toMatchObject({ schemaVersion: 1, repository: 'acme/shop', ref: 'main' })
    expect(json.mirror).toEqual({ path: '/cache/repos/acme/shop.git', bytes: 2048 })
    expect(h.stderr()).toContain('Fetching acme/shop (main)…\n')
  })

  it('reports a fetch that fails', async () => {
    const h = harness({
      openMirror: () =>
        Promise.reject(
          new CheckoutUnavailableError(
            'fetch-failed',
            'Could not fetch main from acme/shop: fatal: x',
          ),
        ),
    })

    expect(await run(['index', 'acme/shop'], h.deps)).toBe(1)
    expect(h.stderr()).toContain('phada: Could not fetch main from acme/shop: fatal: x\n')
  })

  it('prints the warnings about the repository config', async () => {
    const h = harness({
      openMirror: async () =>
        memoryMirror({ '.phada/config.yml': 'ignore: [x\n', 'src/a.ts': 'export const a = 1\n' }),
    })

    expect(await run(['index', 'acme/shop'], h.deps)).toBe(0)
    expect(h.stderr()).toMatch(/Warning: Ignoring \.phada\/config\.yml: /)
  })
})

describe('run rules', () => {
  const RULE_FILES = {
    '.github/instructions/shop.instructions.md': '---\napplyTo: "src/**"\n---\nUse cents.\n',
    '.github/instructions/web.instructions.md': '---\napplyTo: "web/**"\n---\nUse hooks.\n',
    '.claude/rules/sql.md': '---\npaths: "src/**"\n---\nUse parameterized queries.\n',
    '.claude/rules/web.md': '---\npaths: [web/**]\n---\nUse hooks.\n',
  }

  it('asks for a token that can read the repository', async () => {
    const h = harness({ env: {} })

    expect(await run(['rules', 'acme/shop#12'], h.deps)).toBe(1)
    expect(h.stderr()).toMatch(/^phada: No GitHub token found\./)
    expect(h.fetches).toHaveLength(0)
  })

  it('shows the context the review of a pull request gets, without the AI', async () => {
    const h = harness({ repoFiles: RULE_FILES })

    expect(await run(['rules', 'acme/shop#12'], h.deps)).toBe(0)

    expect(h.treeFetches).toEqual([{ sha: '0000000000000000000000000000000000000000' }])
    expect(h.stdout()).toContain('Context for acme/shop#12 at base 0000000\n')
    expect(h.stdout()).toContain(
      '- .github/instructions/shop.instructions.md (37 B, applies to src/**)\n',
    )
    expect(h.stdout()).toContain(
      '- .github/instructions/web.instructions.md (37 B, out of scope: web/**)\n',
    )
    expect(h.stdout()).toContain(
      'Rules:\n- .claude/rules/sql.md (.claude/rules/sql.md, src/**)\n- .claude/rules/web.md (.claude/rules/web.md, web/**, out of scope)\n',
    )
    expect(h.stdout()).not.toMatch(/- \.claude\/rules\/sql\.md \(\d+ B/)
    expect(h.providers).toEqual([])
    expect(h.mirrors).toEqual([])
    expect(h.stateFetches).toEqual([])
  })

  it('lists the context of the default branch as JSON', async () => {
    const h = harness({
      repoFiles: RULE_FILES,
      fetchRepository: async () => ({
        repo: 'acme/shop',
        private: false,
        defaultBranch: 'trunk',
        empty: false,
      }),
    })

    expect(await run(['rules', 'acme/shop', '--format', 'json'], h.deps)).toBe(0)

    expect(h.treeFetches).toEqual([{ sha: 'trunk' }])
    const output = JSON.parse(h.stdout())
    expect(output).toMatchObject({
      schemaVersion: 1,
      pullRequest: null,
      repository: { owner: 'acme', repo: 'shop', ref: 'trunk' },
    })
    expect(output.context.rules).toEqual([
      {
        key: '.claude/rules/sql.md',
        origin: '.claude/rules/sql.md',
        scope: ['src/**'],
        status: 'listed',
      },
      {
        key: '.claude/rules/web.md',
        origin: '.claude/rules/web.md',
        scope: ['web/**'],
        status: 'listed',
      },
    ])
    expect(output.context.docs).toEqual([
      expect.objectContaining({
        path: '.github/instructions/shop.instructions.md',
        status: 'listed',
        scope: ['src/**'],
      }),
      expect.objectContaining({
        path: '.github/instructions/web.instructions.md',
        status: 'listed',
        scope: ['web/**'],
      }),
    ])
    expect(h.providers).toEqual([])
  })

  it('fails when the repository contents cannot be read instead of printing an empty context', async () => {
    const h = harness({
      tree: () =>
        Promise.reject(new GitHubError('Resource not accessible by personal access token')),
    })

    expect(await run(['rules', 'acme/shop#12'], h.deps)).toBe(1)
    expect(h.stderr()).toContain('phada: Resource not accessible by personal access token')
    expect(h.stdout()).toBe('')
  })

  it('fails clearly for an empty repository', async () => {
    const h = harness({
      fetchRepository: async () => ({ repo: 'acme/shop', private: false, empty: true }),
    })

    expect(await run(['rules', 'acme/shop'], h.deps)).toBe(1)
    expect(h.stderr()).toContain('phada: acme/shop is empty: there is no branch to read.')
  })
})

describe('run history', () => {
  it('says phada history cannot read a file written by a newer Phada', async () => {
    const h = harness({
      env: { PHADA_CONFIG_HOME: '/cfg', PHADA_DATA_HOME: '/data' },
      files: memoryFiles({ '/data/history.sqlite': '' }),
      openHistoryStore: () =>
        Promise.reject(
          new HistoryVersionError('/data/history.sqlite', 9, 2),
        ) as Promise<HistoryStore>,
    })

    expect(await run(['history'], h.deps)).toBe(1)
    expect(h.stderr()).toContain(
      '/data/history.sqlite was written by a newer Phada (history version 9, this one knows 2); update Phada',
    )
  })

  it('runs phada history and phada history prune', async () => {
    const h = harness()

    expect(await run(['history'], h.deps)).toBe(0)
    expect(await run(['history', 'prune', '--older-than', '30d'], h.deps)).toBe(0)
    expect(h.stdout()).toBe('No reviews in the history yet.\nNo reviews in the history yet.\n')
  })

  const REVIEW = ['review', 'acme/shop#12', '--no-verify']
  type Row = Record<string, unknown>
  const runsOf = (h: Harness): Row[] => {
    const file = h.historyFiles[0]?.split(' → ')[1]
    if (file === undefined) return []
    const db = new DatabaseSync(file)
    const rows = db.prepare('select * from run order by id').all() as Row[]
    db.close()
    return rows
  }

  it('saves a published review in the history of the data folder', async () => {
    const h = harness({
      env: { GITHUB_TOKEN: TOKEN, PHADA_CONFIG_HOME: '/cfg', PHADA_DATA_HOME: '/data' },
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(REVIEW, h.deps)).toBe(0)

    expect(h.historyFiles[0]?.startsWith('/data/history.sqlite → ')).toBe(true)
    const [saved] = runsOf(h)
    expect(saved).toMatchObject({
      source: 'manual',
      repo: 'acme/shop',
      number: 12,
      head_sha: HEAD_SHA,
      status: 'published',
      ai_called: 1,
      url: REVIEW_URL,
      findings: 1,
      provider: 'claude',
    })
    const json = JSON.parse(String(saved?.result_json)) as {
      pullRequest: Record<string, unknown>
      review: unknown
    }
    expect(json.review).toBeDefined()
    expect(JSON.stringify(json)).not.toContain('+export async function spend')
  })

  it('saves a dry run', async () => {
    const h = harness({ review: () => Promise.resolve(WITH_FINDING) })

    expect(await run([...REVIEW, '--dry-run'], h.deps)).toBe(0)
    expect(runsOf(h)).toEqual([expect.objectContaining({ status: 'dry-run', ai_called: 1 })])
  })

  it('saves a skipped review without calling the AI', async () => {
    const h = harness({ reviewState: () => Promise.resolve(phadaState([{}])) })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(runsOf(h)).toEqual([
      expect.objectContaining({ status: 'skipped', ai_called: 0, reason: 'open-threads' }),
    ])
  })

  it('saves a failed publication and still fails', async () => {
    const h = harness({
      review: () => Promise.resolve(WITH_FINDING),
      createReview: () => Promise.reject(new ReviewPermissionError('acme/shop#12')),
    })

    expect(await run(REVIEW, h.deps)).toBe(1)
    expect(runsOf(h)).toEqual([
      expect.objectContaining({ status: 'failed', ai_called: 1, error_kind: null }),
    ])
  })

  const tableOf = (h: Harness, table: string): Row[] => {
    const file = h.historyFiles[0]?.split(' → ')[1]
    if (file === undefined) return []
    const db = new DatabaseSync(file)
    const rows = db.prepare(`select * from ${table} order by id`).all() as Row[]
    db.close()
    return rows
  }

  it('saves the findings it published and the signals it read', async () => {
    const h = harness({
      review: () => Promise.resolve(WITH_FINDING),
      reviewState: () =>
        Promise.resolve(
          phadaState([
            {
              isResolved: true,
              path: 'src/old.ts',
              body: `**P2** · Old finding · confidence 80\n\nWhy.\n\n${FINDING_MARKER}`,
            },
          ]),
        ),
    })

    expect(await run([...REVIEW, '--force'], h.deps)).toBe(0)

    const [run_] = runsOf(h)
    const findings = tableOf(h, 'finding')
    expect(findings).toEqual([
      expect.objectContaining({ file: 'src/old.ts', thread_id: 'T1', run_id: null }),
      expect.objectContaining({ commit_sha: HEAD_SHA, thread_id: null, run_id: run_?.id }),
    ])
    expect(tableOf(h, 'signal')).toEqual([
      expect.objectContaining({ finding_id: findings[0]?.id, kind: 'dismissed', source: 'manual' }),
    ])
  })

  it('saves nothing when the user config turns the history off', async () => {
    let opened = 0
    const h = harness({
      files: memoryFiles({ '/cfg/config.yml': 'history: false' }),
      openHistoryStore: () => {
        opened += 1
        return Promise.reject(new Error('should not open'))
      },
    })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(opened).toBe(0)
  })

  it('warns and goes on when the history cannot be opened', async () => {
    const h = harness({
      openHistoryStore: () =>
        Promise.reject(
          new HistoryVersionError('/data/history.sqlite', 9, 1),
        ) as Promise<HistoryStore>,
    })

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(h.stderr()).toContain(
      'Warning: /data/history.sqlite was written by a newer Phada (history version 9, this one knows 1); update Phada. This review is not saved in the history.',
    )
  })
})

describe('phada enqueue', () => {
  const WATCH_CONFIG = 'verify: false\nci:\n  wait: 0s\nwatch:\n  repos: [acme/shop]\n'
  const withConfig = (text = WATCH_CONFIG) => memoryFiles({ '/cfg/config.yml': text })

  it('queues a review of a watched pull request and says no watch is running', async () => {
    const h = harness({ files: withConfig() })

    expect(await run(['enqueue', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.stdout()).toBe('Queued acme/shop#12 at a1b2c3d (job 1).\n')
    expect(h.stderr()).toContain(
      'No phada watch is running: the job waits in the queue until one starts.',
    )
  })

  it('says nothing about the watch when one is running', async () => {
    const h = harness({ files: withConfig(), lockHolder: 42 })

    expect(await run(['enqueue', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.stderr()).not.toContain('No phada watch is running')
  })

  it('joins the job already queued for the commit', async () => {
    const h = harness({ files: withConfig(), lockHolder: 42 })

    await run(['enqueue', 'acme/shop#12'], h.deps)
    expect(await run(['enqueue', 'acme/shop#12', '--publish', 'none'], h.deps)).toBe(0)
    expect(h.stdout()).toContain('Joined job 1 for acme/shop#12 at a1b2c3d.\n')
  })

  it('refuses a repository outside watch: with exit code 1', async () => {
    const h = harness({ files: withConfig() })

    expect(await run(['enqueue', 'other/repo#3'], h.deps)).toBe(1)
    expect(h.stderr()).toContain(
      'Refused other/repo#3: the repository is not listed under watch: in your config.',
    )
  })

  it('refuses an outside author on a public repository', async () => {
    const h = harness({
      files: withConfig(),
      pullRequest: () => Promise.resolve(pullRequestFixture({ association: 'CONTRIBUTOR' })),
    })

    expect(await run(['enqueue', 'acme/shop#12'], h.deps)).toBe(1)
    expect(h.stderr()).toContain(
      'Refused acme/shop#12: the author is outside the repository (allowExternal: true in watch: lets them in).',
    )
  })

  it('prints the result as JSON', async () => {
    const h = harness({ files: withConfig(), lockHolder: 42 })

    expect(
      await run(['enqueue', 'acme/shop#12', '--publish', 'none', '--format', 'json'], h.deps),
    ).toBe(0)
    expect(JSON.parse(h.stdout())).toEqual({
      schemaVersion: 1,
      status: 'queued',
      job: {
        id: 1,
        repo: 'acme/shop',
        number: 12,
        headSha: HEAD_SHA,
        status: 'queued',
        publish: 'none',
      },
      watchRunning: true,
    })
  })

  it('needs watch: in the config', async () => {
    const h = harness()

    expect(await run(['enqueue', 'acme/shop#12'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('phada: Nothing to watch: list the repositories under watch:')
  })

  it('rejects an unknown --publish value', async () => {
    const h = harness({ files: withConfig() })

    expect(await run(['enqueue', 'acme/shop#12', '--publish', 'slack'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('Invalid --publish "slack". Use pr or none.')
  })

  it('refuses what the when command refuses, with what it wrote', async () => {
    const config = join(storeDir, 'when-config')
    const text = `${WATCH_CONFIG}  when: { command: 'echo "only the payments team" >&2; exit 1' }\n`
    const h = harness({
      env: { GITHUB_TOKEN: TOKEN, PHADA_CONFIG_HOME: config, PATH: process.env.PATH },
      files: memoryFiles({ [join(config, 'config.yml')]: text }),
    })
    mkdirSync(config, { recursive: true })

    expect(await run(['enqueue', 'acme/shop#12'], h.deps)).toBe(1)
    expect(h.stderr()).toContain(
      'Refused acme/shop#12: the when command refused it (only the payments team).',
    )
    expect(await run(['enqueue', 'acme/shop#12', '--format', 'json'], h.deps)).toBe(1)
    expect(JSON.parse(h.stdout())).toMatchObject({
      status: 'refused',
      reason: 'when-command',
      message: 'only the payments team',
    })
  })

  it('lets the watch review a queued draft at once, without publishing when asked so', async () => {
    const h = harness({
      files: withConfig(),
      pullRequest: () => Promise.resolve(pullRequestFixture({ draft: true })),
      pullHead: () => Promise.resolve({ state: 'open' as const, draft: true, headSha: HEAD_SHA }),
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(['enqueue', 'acme/shop#12', '--publish', 'none'], h.deps)).toBe(0)
    expect(await run(['watch', '--once'], h.deps)).toBe(0)
    expect(h.posts).toHaveLength(0)
    expect(h.stderr()).toMatch(/Reviewing acme\/shop#12 at a1b2c3d…/)
    const file = h.historyFiles[0]?.split(' → ')[1] ?? ''
    const db = new DatabaseSync(file)
    const runs = db.prepare('select source, request_source from run').all()
    db.close()
    expect(runs).toEqual([{ source: 'watch', request_source: 'enqueue' }])
  })
})

describe('phada mcp', () => {
  const WATCH_CONFIG = 'verify: false\nwatch:\n  repos: [acme/shop]\n'
  const line = (id: number, method: string, params: unknown = {}) =>
    JSON.stringify({ jsonrpc: '2.0', id, method, params })
  const answers = (stdout: string) =>
    stdout
      .trim()
      .split('\n')
      .map((text) => JSON.parse(text) as { id: number; result: Record<string, unknown> })
  const toolJson = (answer: { result: Record<string, unknown> }) =>
    JSON.parse((answer.result.content as { text: string }[])[0]?.text ?? '') as unknown

  it('answers MCP over stdio: asks for a review, then waits for it until the deadline', async () => {
    const h = harness({
      files: memoryFiles({ '/cfg/config.yml': WATCH_CONFIG }),
      lockHolder: 7,
      stdin: [
        [
          line(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
          line(1, 'tools/list'),
          line(2, 'tools/call', {
            name: 'review_pull_request',
            arguments: { pr: 'acme/shop#12', publish: 'none' },
          }),
        ],
        [line(3, 'tools/call', { name: 'wait_for_job', arguments: { job: 1, timeoutSeconds: 4 } })],
      ],
    })

    expect(await run(['mcp'], h.deps)).toBe(0)
    expect(await run(['mcp'], h.deps)).toBe(0)

    const [init, list, review, wait] = answers(h.stdout())
    expect(init?.result).toMatchObject({ serverInfo: { name: 'phada' } })
    expect((list?.result.tools as { name: string }[]).map(({ name }) => name)).toEqual([
      'review_pull_request',
      'job_status',
      'wait_for_job',
      'list_queue',
    ])
    expect(review && toolJson(review)).toMatchObject({
      status: 'queued',
      job: { id: 1, publish: 'none' },
      watchRunning: true,
    })
    expect(wait && toolJson(wait)).toMatchObject({ timedOut: true, job: { status: 'queued' } })
  })

  it('answers other calls while a wait_for_job waits', async () => {
    const listed = async () => {
      while (!h.stdout().includes('"id":2')) await new Promise((done) => setImmediate(done))
    }
    const h: Harness = harness({
      files: memoryFiles({ '/cfg/config.yml': WATCH_CONFIG }),
      lockHolder: 7,
      beforeSleep: listed,
      stdin: [
        [
          line(1, 'tools/call', { name: 'wait_for_job', arguments: { job: 1, timeoutSeconds: 4 } }),
          line(2, 'tools/call', { name: 'list_queue', arguments: {} }),
        ],
      ],
    })
    expect(await run(['enqueue', 'acme/shop#12'], h.deps)).toBe(0)

    expect(await run(['mcp'], h.deps)).toBe(0)

    const ids = h
      .stdout()
      .trim()
      .split('\n')
      .filter((text) => text.startsWith('{'))
      .map((text) => (JSON.parse(text) as { id: number }).id)
    expect(ids).toEqual([2, 1])
  })

  it('answers review_pull_request with an error when there is no token', async () => {
    const h = harness({
      env: { PHADA_CONFIG_HOME: '/cfg' },
      files: memoryFiles({ '/cfg/config.yml': WATCH_CONFIG }),
      stdin: [
        [line(1, 'tools/call', { name: 'review_pull_request', arguments: { pr: 'acme/shop#12' } })],
      ],
    })

    expect(await run(['mcp'], h.deps)).toBe(0)
    expect(answers(h.stdout())[0]?.result).toMatchObject({ isError: true })
    expect(h.stdout()).toContain('GITHUB_TOKEN')
  })
})

describe('phada watch', () => {
  const WATCH_CONFIG = 'verify: false\nci:\n  wait: 0s\nwatch:\n  repos: [acme/shop]\n'
  const OPEN_PULL = {
    number: 12,
    headSha: HEAD_SHA,
    draft: false,
    author: 'octocat',
    authorIsBot: false,
    association: 'OWNER',
    labels: [],
    baseRef: 'main',
    private: false,
  }
  const listed = () => Promise.resolve({ status: 'ok' as const, pulls: [OPEN_PULL] })
  const withConfig = (text = WATCH_CONFIG) => memoryFiles({ '/cfg/config.yml': text })

  it('asks for repositories when the config has no watch block', async () => {
    const h = harness()

    expect(await run(['watch'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('phada: Nothing to watch: list the repositories under watch:')
  })

  it('refuses to watch without the history', async () => {
    const h = harness({ files: withConfig(`${WATCH_CONFIG}history: false\n`) })

    expect(await run(['watch'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('phada watch needs the history')
  })

  it('says another watch is running when the lock is taken', async () => {
    const h = harness({
      files: withConfig(),
      lockHolder: 123,
      withLock: () => Promise.reject(new MirrorLockTimeoutError('/data/watch.lock')),
    })

    expect(await run(['watch'], h.deps)).toBe(1)
    expect(h.stderr()).toContain('phada: Another phada watch is running (PID 123).')
  })

  it('reviews and publishes the open pull requests with --once --backfill', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)
    expect(h.posts).toHaveLength(1)
    expect(h.providers[0]?.options).toMatchObject({ detached: true })
    expect(h.stderr()).toMatch(/\[\d\d:\d\d\] Reviewing acme\/shop#12 at a1b2c3d…/)
    expect(h.stderr()).toContain(`Published acme/shop#12: ${REVIEW_URL}`)
  })

  it('checks the MCP server names once, when the watch starts', async () => {
    const h = harness({
      files: withConfig(`${WATCH_CONFIG}mcp: [linear]\n`),
      listPulls: listed,
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)
    expect(h.mcpChecks).toEqual([['claude', ['linear']]])
    expect(h.providers[0]?.options).toMatchObject({
      mcpNames: { provider: 'claude', names: [{ name: 'linear' }] },
    })
  })

  it('cleans the warning of a run it could not save before printing it', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () => Promise.resolve(WITH_FINDING),
      openHistoryStore: async (path) => {
        const store = await openHistoryStore(join(storeDir, `unsaved-${storeCount}.sqlite`))
        expect(path).toContain('history.sqlite')
        return new Proxy(store, {
          get: (target, key) => {
            if (key === 'addRun') {
              return () => {
                throw new Error('disk \u001B[2Jfull')
              }
            }
            const value: unknown = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      },
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)
    expect(h.stderr()).toContain('Warning: could not save the run in the history (disk [2Jfull).\n')
    expect(h.stderr()).not.toContain('\u001B')
  })

  it('saves the findings a watch review published', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)

    const file = h.historyFiles[0]?.split(' → ')[1] ?? ''
    const db = new DatabaseSync(file)
    const findings = db.prepare('select repo, number, thread_id from finding').all()
    const observed = db.prepare('select repo, number, pull_state from feedback_pull').all()
    db.close()
    expect(findings).toEqual([{ repo: 'acme/shop', number: 12, thread_id: null }])
    expect(observed).toEqual([{ repo: 'acme/shop', number: 12, pull_state: 'open' }])
  })

  it('reviews a pull request at once when its owner comments /phada review, with an eyes reaction', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () => Promise.resolve(WITH_FINDING),
      comments: () =>
        Promise.resolve({
          status: 'ok' as const,
          comments: [
            {
              id: 77,
              body: '/phada review',
              author: 'octocat',
              authorIsBot: false,
              association: 'OWNER',
              createdAt: '2026-10-18T12:00:00Z',
              url: 'https://github.com/acme/shop/pull/12#issuecomment-77',
              number: 12,
              pullRequest: true,
            },
          ],
        }),
    })

    expect(await run(['watch', '--once'], h.deps)).toBe(0)

    expect(h.events).toContain('react 77')
    expect(h.posts).toHaveLength(1)
  })

  it('needs both Slack tokens when slack: is in the config', async () => {
    const h = harness({
      env: { GITHUB_TOKEN: TOKEN, PHADA_CONFIG_HOME: '/cfg', PHADA_SLACK_BOT_TOKEN: 'xoxb-1' },
      files: withConfig(`${WATCH_CONFIG}slack:\n  channels: [C1]\n`),
    })

    expect(await run(['watch'], h.deps)).toBe(2)
    expect(h.stderr()).toContain(
      'slack: in your config needs PHADA_SLACK_BOT_TOKEN and PHADA_SLACK_APP_TOKEN in the environment; PHADA_SLACK_APP_TOKEN is not set.',
    )
  })

  it.each([
    ['pr', 1],
    ['none', 0],
  ] as const)(
    'reviews a pull request posted in a Slack channel with publish: %s and answers in its thread',
    async (publish, posts) => {
      const h = harness({
        env: {
          GITHUB_TOKEN: TOKEN,
          PHADA_CONFIG_HOME: '/cfg',
          PHADA_SLACK_BOT_TOKEN: 'xoxb-secret-bot',
          PHADA_SLACK_APP_TOKEN: 'xapp-secret-app',
        },
        files: withConfig(
          `${WATCH_CONFIG}slack:\n  channels: [{ id: C1, publish: ${publish}, reply: full }]\n`,
        ),
        review: () => Promise.resolve(WITH_FINDING),
        slackMessages: [
          {
            type: 'message',
            channel: 'C1',
            ts: '100.1',
            text: '<https://github.com/acme/shop/pull/12>',
          },
        ],
      })

      expect(await run(['watch'], h.deps)).toBe(0)

      expect(h.posts).toHaveLength(posts)
      expect(h.slack.tokens).toEqual([{ botToken: 'xoxb-secret-bot', appToken: 'xapp-secret-app' }])
      expect(h.slack.calls).toEqual([
        '+hourglass_flowing_sand',
        '-hourglass_flowing_sand',
        '-eyes',
        '+x',
        expect.stringMatching(/^post C1 100\.1 :x: \*Blocking findings\* · /),
        'closed',
      ])
      expect(h.stderr()).not.toContain('secret')
    },
  )

  it('saves the verdict of each watch review and of a failed one', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)

    const file = h.historyFiles[0]?.split(' → ')[1] ?? ''
    const db = new DatabaseSync(file)
    const verdicts = db.prepare('select status, verdict from run').all()
    db.close()
    expect(verdicts).toEqual([{ status: 'published', verdict: 'blocking' }])
  })

  it('sends each review event to the hooks with the full review when it finishes', async () => {
    const h = harness({
      files: withConfig(`${WATCH_CONFIG}hooks:\n  review.finished: ./notify.sh\n`),
      listPulls: listed,
      review: () => Promise.resolve(WITH_FINDING),
      hookWarning: (event) =>
        event.event === 'review.finished' ? 'The review.finished hook exited with 1' : undefined,
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)

    expect(h.hooked.map(({ event }) => event.event)).toEqual(['review.started', 'review.finished'])
    expect(h.hooked[1]).toMatchObject({
      settings: { commands: { 'review.finished': './notify.sh' } },
      event: {
        job: { repo: 'acme/shop', number: 12, url: 'https://github.com/acme/shop/pull/12' },
        requests: [{ source: 'watch', publish: 'pr' }],
        verdict: 'blocking',
        publication: { status: 'published', url: REVIEW_URL },
        review: { verdict: 'blocking', review: { findings: [{ file: 'src/shop.ts', line: 3 }] } },
      },
    })
    expect(h.stderr()).toContain('Warning: The review.finished hook exited with 1')
  })

  it('gives the hook the review of a request that does not publish, and posts nothing', async () => {
    const h = harness({
      files: withConfig(`${WATCH_CONFIG}hooks:\n  review.finished: ./notify.sh\n`),
      review: () => Promise.resolve(WITH_FINDING),
    })

    expect(await run(['enqueue', 'acme/shop#12', '--publish', 'none'], h.deps)).toBe(0)
    expect(await run(['watch', '--once'], h.deps)).toBe(0)

    expect(h.posts).toHaveLength(0)
    expect(h.hooked[1]?.event).toMatchObject({
      event: 'review.finished',
      requests: [{ source: 'enqueue', publish: 'none' }],
      publication: { status: 'not-published' },
      review: { review: { findings: [{ line: 3 }] } },
    })
  })

  it('gives the hook the link of the review Phada already published on the commit', async () => {
    const reviewed = phadaState([])
    const h = harness({
      files: withConfig(`${WATCH_CONFIG}hooks:\n  review.skipped: ./notify.sh\n`),
      reviewState: () =>
        Promise.resolve({
          ...reviewed,
          reviews: reviewed.reviews.map((review) => ({ ...review, url: REVIEW_URL })),
        }),
    })

    expect(await run(['enqueue', 'acme/shop#12', '--publish', 'none'], h.deps)).toBe(0)
    expect(await run(['watch', '--once'], h.deps)).toBe(0)

    expect(h.hooked.at(-1)?.event).toMatchObject({
      event: 'review.skipped',
      reason: 'already-reviewed',
      publication: { status: 'skipped', url: REVIEW_URL },
    })
  })

  it('records the open pull requests without reviewing them on the first run', async () => {
    const h = harness({ files: withConfig(), listPulls: listed })

    expect(await run(['watch', '--once'], h.deps)).toBe(0)
    expect(h.posts).toHaveLength(0)
    expect(h.stderr()).toContain('acme/shop: 1 open pull request recorded as they are')
  })

  it('does not publish a review whose pull request moved on', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      pullHead: () => Promise.resolve({ state: 'open', draft: false, headSha: 'f'.repeat(40) }),
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)
    expect(h.posts).toHaveLength(0)
    expect(h.stderr()).toContain('acme/shop#12 moved to fffffff during the review; not published.')
  })

  it('keeps the review in the history only with publish: false', async () => {
    const h = harness({
      files: withConfig(
        'verify: false\nci:\n  wait: 0s\nwatch:\n  repos:\n    - repo: acme/shop\n      publish: false\n',
      ),
      listPulls: listed,
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)
    expect(h.posts).toHaveLength(0)
    expect(h.stderr()).toContain('Reviewed acme/shop#12; kept in the history, not published.')
  })

  it('lets the running review finish on the first Ctrl-C and stops', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () => {
        h.signal()
        return Promise.resolve(WITH_FINDING)
      },
    })

    expect(await run(['watch', '--backfill'], h.deps)).toBe(0)
    expect(h.stderr()).toContain('Stopping after the current review (Ctrl-C again to abort).')
    expect(h.posts).toHaveLength(1)
    expect(h.stderr()).toContain('Stopped.')
  })

  it('stops at once on Ctrl-C while idle', async () => {
    const h = harness({ files: withConfig() })
    h.deps.sleep = async () => h.signal()

    expect(await run(['watch'], h.deps)).toBe(0)
    expect(h.stderr()).toContain('Stopping…\nStopped.\n')
  })

  it('aborts on the second Ctrl-C, stops the AI and puts the job back', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () => {
        h.signal()
        h.signal()
        return new Promise<ReviewOutput>(() => undefined)
      },
    })

    expect(await run(['watch', '--backfill'], h.deps)).toBe(130)
    expect(h.kills()).toBe(1)
    expect(h.aborts).toEqual([130])
    expect(h.stderr()).toContain('Aborted.')
    expect(h.posts).toHaveLength(0)
  })

  it('stops with the error when the AI CLI is not logged in', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () =>
        Promise.reject(new ProviderError('claude-cli', 'not-authenticated', 'Not logged in')),
    })

    expect(await run(['watch', '--backfill'], h.deps)).toBe(1)
    expect(h.stderr()).toContain('phada: Claude Code is not logged in.')
  })

  it('waits for the pending checks of the head with the default ci.wait, read from the repository config', async () => {
    const h = harness({
      files: withConfig('verify: false\nwatch:\n  repos: [acme/shop]\n'),
      repoFiles: { '.phada/config.yml': 'ci:\n  wait: 10m\n' },
      listPulls: listed,
      checkRuns: async () => [
        {
          id: 7,
          name: 'test',
          status: 'in_progress',
          conclusion: null,
          title: null,
          summary: null,
          url: null,
          app: 'github-actions',
          startedAt: null,
          completedAt: null,
        },
      ],
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)
    expect(h.posts).toHaveLength(0)
    expect(h.stderr()).toMatch(
      /acme\/shop#12 at a1b2c3d waits for CI until \d\d:\d\d \(1 pending: test\)\./,
    )
    expect(h.stderr()).not.toContain('Reviewing')

    expect(await run(['watch', '--status', '--format', 'json'], h.deps)).toBe(0)
    expect(JSON.parse(h.stdout()).queue).toEqual([
      expect.objectContaining({
        number: 12,
        status: 'waiting',
        reason: 'ci-pending',
        ciDeadline: '2026-10-18T12:10:00.000Z',
        ciPending: ['test'],
      }),
    ])
  })

  it('prints the status from the history', async () => {
    const h = harness({ files: withConfig(), listPulls: listed, lockHolder: 77 })
    await run(['watch', '--once'], h.deps)

    expect(await run(['watch', '--status', '--format', 'json'], h.deps)).toBe(0)
    const status = JSON.parse(h.stdout()) as Record<string, unknown>
    expect(status).toMatchObject({
      schemaVersion: 1,
      running: { pid: 77 },
      repos: [expect.objectContaining({ repo: 'acme/shop' })],
    })
  })

  it('records the provider of a review that failed', async () => {
    const h = harness({
      files: withConfig(),
      listPulls: listed,
      review: () => Promise.reject(new ProviderError('claude-cli', 'timeout', 'slow')),
    })

    expect(await run(['watch', '--once', '--backfill'], h.deps)).toBe(0)
    const file = h.historyFiles[0]?.split(' → ')[1] ?? ''
    const db = new DatabaseSync(file)
    const rows = db.prepare('select provider, status, error_kind from run').all()
    db.close()
    expect(rows).toEqual([{ provider: 'claude', status: 'failed', error_kind: 'transient' }])
  })

  it('refuses to start when the provider of a watched repository cannot work', async () => {
    let listedRepos = 0
    const h = harness({
      files: memoryFiles({
        '/cfg/config.yml': WATCH_CONFIG,
        '/cfg/repos/acme/shop/config.yml': 'provider: ollama\n',
      }),
      listPulls: () => {
        listedRepos += 1
        return listed()
      },
    })

    expect(await run(['watch'], h.deps)).toBe(2)
    expect(h.stderr()).toContain(
      'phada: acme/shop: provider ollama needs a model: set model: in your config',
    )
    expect(listedRepos).toBe(0)
  })
})

describe('run review with skills', () => {
  const REVIEW = ['review', 'acme/shop#12', '--no-verify']
  const SKILL = '/home/u/.claude/skills/code-review/SKILL.md'
  const installed = () => memoryFiles({ [SKILL]: '---\nname: code-review\n---\nFind bugs.' })

  it('runs one pass per skill and names them on stderr', async () => {
    const h = harness({ files: installed() })

    expect(await run([...REVIEW, '--skill', 'phada', '--skill', 'code-review'], h.deps)).toBe(0)
    const reviews = h.prompts.filter((prompt) => prompt.outputSchema !== RECHECK_JSON_SCHEMA)
    expect(reviews).toHaveLength(2)
    expect(reviews[1]?.instructions).toContain('Review guide (skill code-review):\nFind bugs.')
    expect(h.stderr()).toContain('Skills: phada, code-review\n')
  })

  it('shows the passes in --dry-run and the skill of each finding in the JSON', async () => {
    const h = harness({ files: installed() })

    await run([...REVIEW, '--skill', 'code-review', '--dry-run'], h.deps)
    expect(h.stdout()).toContain('## Skills\n\n- code-review (' + SKILL + '): ')

    const json = harness({ files: installed() })
    await run([...REVIEW, '--skill', 'code-review', '--dry-run', '--format', 'json'], json.deps)
    const parsed = JSON.parse(json.stdout()) as {
      review: { findings: { skill: string }[]; passes: { skill: string }[] }
    }
    expect(parsed.review.passes.map(({ skill }) => skill)).toEqual(['code-review'])
    expect(parsed.review.findings.every(({ skill }) => skill === 'code-review')).toBe(true)
  })

  it('stops before the AI when a skill is not installed', async () => {
    const h = harness()

    expect(await run([...REVIEW, '--skill', 'nope'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('phada: Skill "nope" is not installed. Phada looked in')
    expect(h.prompts).toHaveLength(0)
  })

  it('refuses to start a watch whose config names a skill that is not installed', async () => {
    const h = harness({
      files: memoryFiles({
        '/cfg/config.yml': 'watch:\n  repos: [acme/shop]\nreview:\n  skills: [nope]\n',
      }),
    })

    expect(await run(['watch', '--once'], h.deps)).toBe(2)
    expect(h.stderr()).toContain('phada: Skill "nope" is not installed.')
  })
})

describe('run prompt', () => {
  it('prints the built-in prompt without a token', async () => {
    const h = harness({ env: { PHADA_CONFIG_HOME: '/cfg' } })

    expect(await run(['prompt', '--default'], h.deps)).toBe(0)
    expect(h.stdout()).toContain('Built-in prompt, without a pull request')
    expect(h.stdout()).toContain('You are a senior engineer reviewing a pull request.')
  })

  it('prints the prompt of a pull request without calling the AI', async () => {
    const h = harness({
      repoFiles: {
        '.phada/config.yml': 'review:\n  prompt:\n    file: .phada/review.md\n',
        '.phada/review.md': 'Flag missing tests.',
      },
    })

    expect(await run(['prompt', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.stdout()).toContain('Prompt for acme/shop#12')
    expect(h.stdout()).toContain('### lens — .phada/config.yml → .phada/review.md')
    expect(h.stdout()).toContain('Additional review focus set by the user:\nFlag missing tests.')
    expect(h.prompts).toHaveLength(0)
  })

  it('needs a token for a pull request', async () => {
    const h = harness({ env: { PHADA_CONFIG_HOME: '/cfg' } })

    expect(await run(['prompt', 'acme/shop#12'], h.deps)).toBe(1)
  })

  it('lists the conversation and CI blocks with their sizes, and their rules, as a review sends them', async () => {
    const overrides = {
      pullComments: async () => [
        {
          id: 'c1',
          author: 'alice',
          bot: false,
          association: 'MEMBER',
          createdAt: '2026-10-20T10:00:00Z',
          body: 'Please keep the old endpoint.',
        },
      ],
      checkRuns: async () => [
        {
          id: 7,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          title: '1 failed',
          summary: null,
          url: null,
          app: 'other',
          startedAt: null,
          completedAt: null,
        },
      ],
    }
    const text = harness(overrides)
    const json = harness(overrides)
    const off = harness({
      ...overrides,
      repoFiles: { '.phada/config.yml': 'conversation: false\nci:\n  read: false\n' },
    })

    expect(await run(['prompt', 'acme/shop#12'], text.deps)).toBe(0)
    await run(['prompt', 'acme/shop#12', '--format', 'json'], json.deps)
    await run(['prompt', 'acme/shop#12'], off.deps)

    expect(text.stdout()).toMatch(/ {2}PHADA_CONVERSATION {2}\d+ B\n/)
    expect(text.stdout()).toMatch(/ {2}PHADA_CI {12}\d+ B\n/)
    expect(text.stdout()).toContain('The PHADA_CONVERSATION block')
    expect(text.stdout()).toContain('The PHADA_CI block')
    const view = JSON.parse(json.stdout()) as {
      passes: { data: { name: string; bytes: number }[] }[]
    }
    expect(view.passes[0]?.data.map(({ name }) => name)).toEqual([
      'PHADA_PR',
      'PHADA_CONVERSATION',
      'PHADA_CI',
      'PHADA_DIFF',
    ])
    expect(off.stdout()).not.toContain('PHADA_CONVERSATION')
    expect(off.stdout()).not.toContain('PHADA_CI')
    expect(off.commentFetches).toEqual([])
    expect(off.ciFetches).toEqual([])
    expect(text.prompts).toHaveLength(0)
  })

  it('shows the CI permission a token lacks as a warning of the prompt', async () => {
    const h = harness({
      checkRuns: () => Promise.reject(new GitHubPermissionError('the check runs', 'checks:read')),
    })

    expect(await run(['prompt', 'acme/shop#12'], h.deps)).toBe(0)
    expect(h.stdout()).toContain(
      'Warning: CI check runs were not read: GitHub denied reading the check runs (HTTP 403): the token needs the checks:read permission.',
    )
  })
})

describe('run review when no skill applies', () => {
  it('posts nothing and says why', async () => {
    const h = harness({
      files: memoryFiles({
        '/home/u/.claude/skills/docs-review/SKILL.md': 'Check the docs.',
        '/cfg/config.yml':
          "review:\n  skills:\n    - name: docs-review\n      paths: ['docs/**']\n",
      }),
    })

    expect(await run(['review', 'acme/shop#12', '--no-verify'], h.deps)).toBe(0)
    expect(h.posts).toHaveLength(0)
    expect(h.prompts.filter((prompt) => prompt.outputSchema !== RECHECK_JSON_SCHEMA)).toHaveLength(
      0,
    )
    expect(h.stderr()).toContain(
      'Nothing to review: no skill applies to the changed files (docs-review — no changed file matches docs/**).',
    )
  })
})

describe('providerRunsSkills', () => {
  it('runs skills natively only with Claude', () => {
    expect(['claude', 'codex', 'ollama'].map(providerRunsSkills)).toEqual([true, false, false])
  })
})

describe('run review with a native skill', () => {
  const REVIEW = ['review', 'acme/shop#12', '--no-verify', '--skill', 'claude:code-review']

  function nativeHarness() {
    const h = harness()
    h.deps.runsSkills = () => true
    h.deps.openNativeRunner = async () => ({
      runSkill: async () => ({
        text: 'Found nothing.',
        captured: [{ command: 'gh pr comment', body: 'Posted.', comments: [] }],
        durationMs: 61_000,
        blocked: [{ tool: 'Bash', input: 'npm test -- --run' }],
      }),
      close: async () => undefined,
    })
    return h
  }

  it('says how the skill ran and how to allow what it was refused', async () => {
    const h = nativeHarness()

    expect(await run(REVIEW, h.deps)).toBe(0)
    expect(h.stderr()).toContain('Skills: claude:code-review (native)\n')
    expect(h.stderr()).toMatch(
      /Skill claude:code-review: ran natively in \S+, 1 GitHub write captured, 1 blocked\n/,
    )
    expect(h.stderr()).toContain(
      '  blocked npm test -- --run (allow it with review.commands: ["npm test"] in ',
    )
  })

  it('shows the blocked commands with their fix in --dry-run and the JSON', async () => {
    const h = nativeHarness()
    await run([...REVIEW, '--dry-run'], h.deps)
    expect(h.stdout()).toContain(
      '  - blocked: npm test -- --run — allow it with review.commands: ["npm test"]',
    )
    expect(h.stdout()).toContain('### Skill output: claude:code-review')

    const json = nativeHarness()
    await run([...REVIEW, '--dry-run', '--format', 'json'], json.deps)
    const parsed = JSON.parse(json.stdout()) as {
      review: { passes: { mode: string; blocked: { fix: string }[] }[] }
    }
    expect(parsed.review.passes[0]?.mode).toBe('native')
    expect(parsed.review.passes[0]?.blocked[0]?.fix).toContain('review.commands: ["npm test"]')
  })
})

describe('run watch with a built-in Claude Code skill', () => {
  it('refuses to start when the provider does not run skills natively', async () => {
    const h = harness({
      files: memoryFiles({
        '/cfg/config.yml':
          'provider: codex\nwatch:\n  repos: [acme/shop]\nreview:\n  skills: [claude:security-review]\n',
      }),
    })

    expect(await run(['watch', '--once'], h.deps)).toBe(2)
    expect(h.stderr()).toContain(
      'phada: Skill claude:security-review is built into Claude Code and only runs natively with provider claude.',
    )
  })
})

describe('run review and Ctrl-C', () => {
  it('stops at once and cleans up on Ctrl-C', async () => {
    const h = harness()
    let interrupted = false
    h.deps.createProvider = () => ({
      id: 'fake-cli',
      review: async () => {
        if (!interrupted) {
          interrupted = true
          h.signal()
        }
        return { text: reviewReportJson(), durationMs: 1 }
      },
    })

    await run(['review', 'acme/shop#12', '--no-verify'], h.deps)

    expect(h.aborts).toEqual([130])
  })
})

describe('run review --wait-ci', () => {
  const testRun = (status: 'in_progress' | 'completed', conclusion: string | null = null) => ({
    id: 7,
    name: 'test',
    status,
    conclusion,
    title: null,
    summary: null,
    url: null,
    app: 'other',
    startedAt: null,
    completedAt: null,
  })

  it('waits for the pending checks, reading them each minute, and reviews once they pass', async () => {
    let reads = 0
    const h = harness({
      checkRuns: async () => {
        reads += 1
        return [reads <= 2 ? testRun('in_progress') : testRun('completed', 'success')]
      },
    })

    expect(await run(['review', 'acme/shop#12', '--dry-run', '--wait-ci'], h.deps)).toBe(0)

    expect(reads).toBe(4)
    expect(h.stderr()).toMatch(/Waiting for CI until \d\d:\d\d \(1 pending: test\)…\n/)
    expect(h.stderr()).toContain('Waited 2m00s for CI.\nCI: 1 check, all passing\n')
    expect(h.prompts[0]?.data).toContain('{"name":"test","state":"passing"}')
  })

  it('reviews at once when no check appears in 2 minutes', async () => {
    let reads = 0
    const h = harness({
      checkRuns: async () => {
        reads += 1
        return []
      },
    })

    await run(['review', 'acme/shop#12', '--dry-run', '--wait-ci'], h.deps)

    expect(reads).toBe(3)
    expect(h.stderr()).toMatch(/Waiting for CI until \d\d:\d\d \(no checks yet\)…\n/)
    expect(h.stderr()).toContain('Waited 2m00s for CI. No checks appeared.\n')
    expect(h.prompts).not.toHaveLength(0)
  })

  it('reviews at the ci.wait deadline, counted from the start of the command, with the checks still pending', async () => {
    const h = harness({
      repoFiles: { '.phada/config.yml': 'ci:\n  wait: 5m\n' },
      checkRuns: async () => [testRun('in_progress')],
    })

    await run(['review', 'acme/shop#12', '--dry-run', '--wait-ci'], h.deps)

    expect(h.stderr()).toContain(
      'Waited 5m00s for CI. Still pending: test.\nCI: 1 check, 1 pending\n',
    )
    expect(h.prompts[0]?.data).toContain('{"name":"test","state":"pending"}')
  })

  it('waits for the checks still pending when one fails, and reviews once they end', async () => {
    let reads = 0
    const h = harness({
      checkRuns: async () => {
        reads += 1
        const e2e = { ...testRun('in_progress'), id: 8, name: 'e2e' }
        return [
          testRun('completed', 'failure'),
          reads <= 2 ? e2e : { ...e2e, status: 'completed' as const, conclusion: 'success' },
        ]
      },
    })

    await run(['review', 'acme/shop#12', '--dry-run', '--wait-ci'], h.deps)

    expect(reads).toBe(4)
    expect(h.stderr()).toMatch(/Waiting for CI until \d\d:\d\d \(1 pending: e2e\)…\n/)
    expect(h.stderr()).toContain('Waited 2m00s for CI.\nCI: 2 checks, 1 failing (test)\n')
    expect(h.prompts).not.toHaveLength(0)
  })

  it('reviews a failing CI at once when no check is pending', async () => {
    let reads = 0
    const h = harness({
      checkRuns: async () => {
        reads += 1
        return [testRun('completed', 'failure')]
      },
    })

    await run(['review', 'acme/shop#12', '--dry-run', '--wait-ci'], h.deps)

    expect(reads).toBe(2)
    expect(h.stderr()).not.toContain('Waiting for CI')
    expect(h.stderr()).toContain('CI: 1 check, 1 failing (test)\n')
  })

  it('does not wait with ci.wait: 0s, and warns that there is nothing to wait for with ci.read: false', async () => {
    const zero = harness({
      files: memoryFiles({ '/cfg/config.yml': 'ci:\n  wait: 0s\n' }),
      checkRuns: async () => [testRun('in_progress')],
    })
    const off = harness({
      repoFiles: { '.phada/config.yml': 'ci:\n  read: false\n' },
      checkRuns: async () => [testRun('in_progress')],
    })

    await run(['review', 'acme/shop#12', '--dry-run', '--wait-ci'], zero.deps)
    await run(['review', 'acme/shop#12', '--dry-run', '--wait-ci'], off.deps)

    expect(zero.ciFetches.filter((fetch) => fetch.startsWith('runs'))).toHaveLength(1)
    expect(zero.stderr()).not.toContain('Waiting for CI')
    expect(off.ciFetches).toEqual([])
    expect(off.stderr()).toContain(
      'Warning: --wait-ci has nothing to wait for: ci.read is false in the config\n',
    )
  })

  it('stops waiting and reviews when the checks can no longer be read', async () => {
    let reads = 0
    const h = harness({
      checkRuns: async () => {
        reads += 1
        if (reads === 2) throw new Error('GitHub is down')
        return [testRun('in_progress')]
      },
    })

    await run(['review', 'acme/shop#12', '--dry-run', '--wait-ci'], h.deps)

    expect(h.stderr()).toContain(
      'Waited 1m00s for CI. Still pending: test.\nWarning: CI check runs were not read: GitHub is down; reviewing without waiting for CI\n',
    )
    expect(h.prompts).not.toHaveLength(0)
  })

  it('does not wait without --wait-ci', async () => {
    let reads = 0
    const h = harness({
      checkRuns: async () => {
        reads += 1
        return [testRun('in_progress')]
      },
    })

    await run(['review', 'acme/shop#12', '--dry-run'], h.deps)

    expect(reads).toBe(1)
    expect(h.stderr()).not.toContain('Waiting for CI')
  })
})
