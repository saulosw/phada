import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { nodeFileSystem } from '../config/local-files.js'
import type { ReviewPrompt } from '../providers/types.js'
import type { Miss } from '../publish/misses.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { InvalidLessonEditError, LessonNotFoundError } from '../app/decide-lesson.js'
import { MissingGitHubTokenError, UsageError } from './errors.js'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import { GitHubRateLimitError } from '../github/errors.js'
import { RepositoryAccessError } from '../github/repository.js'
import type {
  ClosedPull,
  ListClosedPullRequestsOptions,
} from '../github/list-closed-pull-requests.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import { FINDING_MARKER } from '../publish/markers.js'
import { createExtractor } from '../repo-map/extract.js'
import { EditorNotFoundError } from './text-editor.js'
import { runLessons, runLessonsAccept, runLessonsDiscard } from './lessons-command.js'
import type { LessonsCommand, LessonsCommandDeps } from './lessons-command.js'
import type { ProviderOptions } from './provider-choice.js'
import type { runInteractive } from '../process/run-interactive.js'

const root = mkdtempSync(join(tmpdir(), 'phada-lessons-command-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0

const NOW = new Date('2026-11-04T10:00:00.000Z')
const LIST: LessonsCommand = { all: false, refresh: false, format: 'text' }

function miss(threadId: string, overrides: Partial<Miss> = {}): Miss {
  return {
    key: threadId,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    commitSha: 'c'.repeat(40),
    threadId,
    threadUrl: `https://github.com/acme/shop/pull/3#${threadId}`,
    file: 'src/api/orders.ts',
    line: 20,
    author: 'alice',
    role: 'member',
    body: `Comment ${threadId}.`,
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  }
}

const TEAM_THREAD = reviewThread({
  id: 'T8',
  path: 'src/cart.ts',
  line: null,
  originalLine: 8,
  originalCommit: 'c'.repeat(40),
  isOutdated: true,
  url: 'https://github.com/acme/shop/pull/8#discussion_r8',
  author: 'carol',
  association: 'OWNER',
  bot: false,
  body: 'The total skips the discount.',
  createdAt: '2026-10-20T11:00:00Z',
})

interface HarnessOptions {
  token?: boolean
  closed?: (options: ListClosedPullRequestsOptions) => ClosedPull[]
  state?: (request: FetchReviewStateOptions) => PullRequestReviewState
}

function harness(
  config: Record<string, string> = {},
  answer: unknown = { lessons: [] },
  options: HarnessOptions = {},
) {
  const data = join(root, `d${++dirs}`)
  const out: string[] = []
  const err: string[] = []
  const providers: { name: string; options: ProviderOptions }[] = []
  const prompts: ReviewPrompt[] = []
  const listed: ListClosedPullRequestsOptions[] = []
  const fetched: string[] = []
  const memory = memoryFiles(config)
  const deps: LessonsCommandDeps = {
    env: {
      PHADA_CONFIG_HOME: '/cfg',
      PHADA_DATA_HOME: data,
      ...(options.token === false ? {} : { GITHUB_TOKEN: 'ghp_test' }),
    },
    ghToken: async () => undefined,
    home: '/home/u',
    cwd: root,
    files: { ...memory, exists: (path) => nodeFileSystem.exists(path) },
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    clock: () => NOW,
    openHistoryStore: (path) => openHistoryStore(path),
    fetchRepositoryFile: async () => null,
    fetchComparison: async () => [],
    createExtractor,
    listClosedPullRequests: async (request) => {
      listed.push(request)
      return options.closed?.(request) ?? []
    },
    fetchReviewState: async (request) => {
      fetched.push(`${request.owner}/${request.repo}#${request.number}`)
      return (
        options.state?.(request) ??
        reviewState({
          viewer: 'octocat',
          author: 'bob',
          threads: request.number === 8 ? [TEAM_THREAD] : [],
        })
      )
    },
    createProvider: (name, options) => {
      providers.push({ name, options })
      return {
        id: name,
        review: async (prompt) => {
          prompts.push(prompt)
          return { text: JSON.stringify(answer), durationMs: 1 }
        },
      }
    },
  }
  const seed = async (seeding: (store: HistoryStore) => void) => {
    const store = await openHistoryStore(join(data, 'history.sqlite'))
    try {
      seeding(store)
    } finally {
      store.close()
    }
  }
  const store = async <T>(reading: (store: HistoryStore) => T): Promise<T> => {
    const opened = await openHistoryStore(join(data, 'history.sqlite'))
    try {
      return reading(opened)
    } finally {
      opened.close()
    }
  }
  return { deps, out, err, providers, prompts, seed, store, memory, listed, fetched }
}

describe('runLessons', () => {
  it('says there is nothing yet when the history does not exist', async () => {
    const { deps, out } = harness()

    await runLessons(LIST, deps)

    expect(out.join('')).toBe(
      'No lessons in the history yet; phada lessons --refresh proposes them from the misses.\n',
    )
  })

  it('lists the pending lessons, the ones with more misses first', async () => {
    const { deps, out, seed } = harness()
    await seed((store) => {
      store.recordMisses([miss('A'), miss('B'), miss('C')], '2026-11-01T00:00:00Z')
      const [a, b, c] = store.misses({}).misses.map(({ id }) => id)
      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [
            { rule: 'One miss.', scope: ['src/**'], missIds: [a ?? 0] },
            { rule: 'Two misses.', scope: ['src/**'], missIds: [b ?? 0, c ?? 0] },
          ],
          attached: [],
        },
        '2026-11-02T00:00:00Z',
      )
    })

    await runLessons(LIST, deps)

    const text = out.join('')
    expect(text.indexOf('Two misses.')).toBeLessThan(text.indexOf('One miss.'))
    expect(text).toContain('https://github.com/acme/shop/pull/3#B')
  })

  it('proposes lessons with the provider and model of the config of that repository', async () => {
    const { deps, out, err, providers, prompts, seed } = harness(
      {
        '/cfg/config.yml': 'provider: claude\n',
        '/cfg/repos/acme/shop/config.yml':
          'provider: codex\nmodel: gpt-b\nrules:\n  - id: no-console\n    scope: ["src/**"]\n    rule: Do not log with console.\n',
      },
      {
        lessons: [{ rule: 'Validate bodies.', scope: ['src/api/**'], misses: [1], extends: null }],
      },
    )
    await seed((store) => store.recordMisses([miss('A')], '2026-11-01T00:00:00Z'))

    await runLessons({ ...LIST, refresh: true, repo: { owner: 'Acme', repo: 'Shop' } }, deps)

    expect(providers).toEqual([{ name: 'codex', options: { model: 'gpt-b' } }])
    expect(prompts[0]?.data).toContain('Do not log with console.')
    expect(err.join('')).toContain('acme/shop')
    expect(out.join('')).toContain('Validate bodies.')
  })

  it('--refresh first reads the team comments of the pull requests closed in the last 90 days, then only those closed after the newest one read', async () => {
    let round = 0
    const h = harness(
      {},
      { lessons: [] },
      {
        closed: () =>
          ++round === 1
            ? [
                { number: 8, closedAt: '2026-11-01T09:00:00Z' },
                { number: 6, closedAt: '2026-10-12T09:00:00Z' },
              ]
            : [],
      },
    )
    const command = { ...LIST, refresh: true, repo: { owner: 'acme', repo: 'shop' } }

    await runLessons(command, h.deps)

    expect(h.listed).toEqual([
      expect.objectContaining({
        owner: 'acme',
        repo: 'shop',
        token: 'ghp_test',
        since: '2026-08-06T10:00:00.000Z',
        limit: 200,
      }),
    ])
    expect(h.fetched.sort()).toEqual(['acme/shop#6', 'acme/shop#8'])
    expect(h.prompts[0]?.data).toContain('The total skips the discount.')
    expect(h.err.join('')).toContain(
      'acme/shop: reading the pull requests closed since 2026-08-06…\nRefreshing 2 pull requests…\nFound 1 new miss.\nProposing lessons for acme/shop from 1 new miss with your AI…\n',
    )
    expect(await h.store((store) => store.lessonHarvest('acme/shop')?.closedSince)).toBe(
      '2026-11-01T09:00:00Z',
    )

    await runLessons(command, h.deps)

    expect(h.prompts).toHaveLength(1)
    expect(h.listed[1]?.since).toBe('2026-11-01T09:00:00Z')
    expect(await h.store((store) => store.lessonHarvest('acme/shop')?.closedSince)).toBe(
      '2026-11-01T09:00:00Z',
    )
  })

  it('--refresh also proposes from the comments of Phada the team refused, and says so', async () => {
    const h = harness()
    await h.seed((store) => {
      store.recordMisses([miss('A')], '2026-11-01T00:00:00Z')
      store.recordPublished([
        {
          repo: 'acme/shop',
          number: 5,
          commitSha: 'd'.repeat(40),
          fingerprint: 'f1',
          file: 'src/config/load.ts',
          line: 8,
          title: 'Missing null check',
          severity: 'P2',
          confidence: 80,
          publishedAt: '2026-11-01T00:00:00Z',
        },
      ])
      store.observeFeedback({
        repo: 'acme/shop',
        number: 5,
        pullState: 'closed',
        observedAt: NOW.toISOString(),
        source: 'refresh',
        threads: [
          {
            threadId: 'P1',
            fingerprint: 'f1',
            url: 'https://github.com/acme/shop/pull/5#P1',
            file: 'src/config/load.ts',
            line: 8,
            title: 'Missing null check',
            commitSha: 'd'.repeat(40),
            outdated: false,
            destination: 'dismissed',
            signals: ['dismissed'],
          },
        ],
      })
    })

    await runLessons({ ...LIST, refresh: true, repo: { owner: 'acme', repo: 'shop' } }, h.deps)

    expect(h.prompts[0]?.data).toContain('Missing null check')
    expect(h.err.join('')).toContain(
      'Proposing lessons for acme/shop from 1 new miss plus 1 new Phada comment with your AI…\n',
    )
  })

  it('--since reads past the cursor, and reading a pull request again keeps one miss per thread', async () => {
    const h = harness(
      {},
      { lessons: [] },
      {
        closed: () => [{ number: 8, closedAt: '2026-10-25T09:00:00Z' }],
      },
    )
    await h.seed((store) =>
      store.saveLessonHarvest({
        repo: 'acme/shop',
        closedSince: '2026-11-01T09:00:00Z',
        harvestedAt: '2026-11-01T10:00:00.000Z',
      }),
    )
    const command = {
      ...LIST,
      refresh: true,
      repo: { owner: 'acme', repo: 'shop' },
      since: '2026-10-01T00:00:00.000Z',
    }

    await runLessons(command, h.deps)
    await runLessons(command, h.deps)

    expect(h.listed.map(({ since }) => since)).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    ])
    expect(await h.store((store) => store.misses({}).total)).toBe(1)
    expect(await h.store((store) => store.lessonHarvest('acme/shop')?.closedSince)).toBe(
      '2026-11-01T09:00:00Z',
    )
  })

  it('--refresh without a repository reads every repository with a run in the history', async () => {
    const h = harness()
    const run = {
      source: 'watch' as const,
      repo: 'acme/shop',
      number: 3,
      headSha: 'a'.repeat(40),
      startedAt: '2026-10-20T09:00:00.000Z',
      finishedAt: '2026-10-20T09:30:00.000Z',
      status: 'published' as const,
      aiCalled: true,
    }
    await h.seed((store) => {
      store.addRun(run)
      store.addRun({ ...run, repo: 'acme/web' })
    })

    await runLessons({ ...LIST, refresh: true }, h.deps)

    expect(h.listed.map(({ owner, repo }) => `${owner}/${repo}`)).toEqual(['acme/shop', 'acme/web'])
  })

  it('says which repository it could not list and goes on with the others', async () => {
    const h = harness(
      {},
      { lessons: [] },
      {
        closed: ({ repo }) => {
          if (repo === 'gone') throw new RepositoryAccessError('acme/gone', 404)
          return [{ number: 8, closedAt: '2026-11-01T09:00:00Z' }]
        },
      },
    )
    const run = {
      source: 'watch' as const,
      repo: 'acme/gone',
      number: 3,
      headSha: 'a'.repeat(40),
      startedAt: '2026-10-20T09:00:00.000Z',
      finishedAt: '2026-10-20T09:30:00.000Z',
      status: 'published' as const,
      aiCalled: true,
    }
    await h.seed((store) => {
      store.addRun(run)
      store.addRun({ ...run, repo: 'acme/shop' })
    })

    await runLessons({ ...LIST, refresh: true }, h.deps)

    expect(h.err.join('')).toContain(
      'Warning: acme/gone: Cannot read acme/gone with this token (HTTP 404)\n',
    )
    expect(await h.store((store) => store.lessonHarvest('acme/gone'))).toBeUndefined()
    expect(await h.store((store) => store.lessonHarvest('acme/shop')?.closedSince)).toBe(
      '2026-11-01T09:00:00Z',
    )
  })

  it('keeps the cursor when a rate limit cut the refresh, so the next one reads them again', async () => {
    const h = harness(
      {},
      { lessons: [] },
      {
        closed: () => [{ number: 8, closedAt: '2026-11-01T09:00:00Z' }],
        state: () => {
          throw new GitHubRateLimitError({ resetAt: new Date('2026-11-04T11:00:00Z') })
        },
      },
    )
    const command = { ...LIST, refresh: true, repo: { owner: 'acme', repo: 'shop' } }

    await runLessons(command, h.deps)
    await runLessons(command, h.deps)

    expect(h.listed.map(({ since }) => since)).toEqual([
      '2026-08-06T10:00:00.000Z',
      '2026-08-06T10:00:00.000Z',
    ])
    expect(h.err.join('')).toContain('Warning: acme/shop#8:')
  })

  it('sends only the comments of team people: never of bots, the author or Phada', async () => {
    const thread = (id: string, author: string, extra: Partial<typeof TEAM_THREAD> = {}) => ({
      ...TEAM_THREAD,
      id,
      author,
      url: `https://github.com/acme/shop/pull/8#${id}`,
      body: `Comment of ${author}.`,
      ...extra,
    })
    const h = harness(
      {},
      { lessons: [] },
      {
        closed: () => [{ number: 8, closedAt: '2026-11-01T09:00:00Z' }],
        state: () =>
          reviewState({
            viewer: 'octocat',
            author: 'bob',
            threads: [
              thread('T1', 'carol'),
              thread('T2', 'bob'),
              thread('T3', 'renovate[bot]', { bot: true }),
              thread('T4', 'octocat', {
                path: 'src/other.ts',
                body: `Comment of octocat.\n\n${FINDING_MARKER}`,
              }),
              thread('T5', 'dave', { association: 'NONE' }),
            ],
          }),
      },
    )

    await runLessons({ ...LIST, refresh: true, repo: { owner: 'acme', repo: 'shop' } }, h.deps)

    const data = h.prompts[0]?.data ?? ''
    expect(data).toContain('Comment of carol.')
    for (const author of ['bob', 'renovate[bot]', 'octocat', 'dave']) {
      expect(data).not.toContain(`Comment of ${author}.`)
    }
  })

  it('refuses --refresh without a GitHub token before reading anything', async () => {
    const h = harness({}, { lessons: [] }, { token: false })

    await expect(runLessons({ ...LIST, refresh: true }, h.deps)).rejects.toBeInstanceOf(
      MissingGitHubTokenError,
    )
    expect(h.listed).toEqual([])
    expect(existsSync(join(h.deps.env.PHADA_DATA_HOME ?? '', 'history.sqlite'))).toBe(false)
  })

  it('refuses --refresh when the history is off', async () => {
    const { deps } = harness({ '/cfg/config.yml': 'history: false\n' })

    await expect(runLessons({ ...LIST, refresh: true }, deps)).rejects.toThrow(
      new UsageError('--refresh saves to the history; remove history: false from your config.'),
    )
  })
})

async function seedLesson(seed: ReturnType<typeof harness>['seed']): Promise<number> {
  let lessonId = 0
  await seed((store) => {
    store.recordMisses([miss('A')], '2026-11-01T00:00:00Z')
    const missIds = store.misses({}).misses.map(({ id }) => id)
    lessonId =
      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [{ rule: 'Validate bodies.', scope: ['src/api/**'], missIds }],
          attached: [],
        },
        '2026-11-02T00:00:00Z',
      )[0] ?? 0
  })
  return lessonId
}

describe('runLessonsAccept', () => {
  it('writes the rule in your config for the repository and says where', async () => {
    const { deps, out, err, seed, memory } = harness()
    const id = await seedLesson(seed)

    await runLessonsAccept({ id, edit: false }, deps)

    const path = '/cfg/repos/acme/shop/config.yml'
    expect(memory.files.get(path)).toContain(
      `rules:\n  - id: lesson-${id}\n    rule: Validate bodies.\n`,
    )
    expect(memory.files.get(path)).toMatch(/^# Your own Phada config for acme\/shop/)
    expect(err.join('')).toBe(
      `Created ${path} with the rule lesson-${id}; reviews of acme/shop apply it from now on.\n`,
    )
    await runLessons({ ...LIST, all: true }, deps)
    expect(out.join('')).toMatch(new RegExp(`${id}\\s+acme/shop\\s+accepted`))
  })

  it('writes an avoid lesson as an avoid rule and says what the reviews stop reporting', async () => {
    const { deps, err, seed, memory } = harness()
    let id = 0
    await seed((store) => {
      store.recordPublished([
        {
          repo: 'acme/shop',
          number: 5,
          commitSha: 'd'.repeat(40),
          fingerprint: 'f1',
          file: 'src/config/load.ts',
          line: 8,
          title: 'Comment the loader.',
          severity: 'P2',
          confidence: 80,
          publishedAt: '2026-11-01T00:00:00Z',
        },
      ])
      const findingIds = store.findings({}).map((finding) => finding.id)
      id =
        store.recordLessons(
          {
            repo: 'acme/shop',
            created: [
              {
                kind: 'avoid',
                rule: 'Do not ask for comments on loaders.',
                scope: ['src/config/**'],
                missIds: [],
                findingIds,
              },
            ],
            attached: [],
          },
          '2026-11-02T00:00:00Z',
        )[0] ?? 0
    })

    await runLessonsAccept({ id, edit: false }, deps)

    const path = '/cfg/repos/acme/shop/config.yml'
    expect(memory.files.get(path)).toContain(`  - id: lesson-${id}\n    kind: avoid\n`)
    expect(err.join('')).toBe(
      `Created ${path} with the avoid rule lesson-${id}; reviews of acme/shop stop reporting what it describes in its files from now on.\n`,
    )
  })

  it('says it added the rule to a config that was there', async () => {
    const path = '/cfg/repos/acme/shop/config.yml'
    const { deps, err, seed } = harness({ [path]: 'minConfidence: 70\n' })
    const id = await seedLesson(seed)

    await runLessonsAccept({ id, edit: false }, deps)

    expect(err.join('')).toBe(
      `Added the rule lesson-${id} to ${path}; reviews of acme/shop apply it from now on.\n`,
    )
  })

  it('refuses a lesson when there is no history', async () => {
    const { deps } = harness()

    await expect(runLessonsAccept({ id: 3, edit: false }, deps)).rejects.toThrow(
      LessonNotFoundError,
    )
  })
})

interface EditorCall {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  shown: string
  file: string
}

function editor(rewrite: (shown: string) => string, exitCode = 0) {
  const calls: EditorCall[] = []
  const run: typeof runInteractive = async (command, args, options) => {
    const file = args.at(-1) ?? ''
    const shown = readFileSync(file, 'utf8')
    calls.push({ command, args, env: options.env, shown, file })
    writeFileSync(file, rewrite(shown))
    return { kind: 'exited', exitCode }
  }
  return { run, calls }
}

describe('runLessonsAccept --edit', () => {
  const path = '/cfg/repos/acme/shop/config.yml'

  it('writes the rule as edited and keeps the edited text on the lesson', async () => {
    const { deps, out, err, seed, memory } = harness()
    const id = await seedLesson(seed)
    const { run, calls } = editor(() => 'rule: Validate every body.\nscope:\n  - src/**\n')

    await runLessonsAccept(
      { id, edit: true },
      {
        ...deps,
        env: { ...deps.env, VISUAL: 'code --wait', GITHUB_TOKEN: 't' },
        runInteractive: run,
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('code')
    expect(calls[0]?.args.slice(0, -1)).toEqual(['--wait'])
    expect(calls[0]?.env.GITHUB_TOKEN).toBeUndefined()
    expect(calls[0]?.shown).toContain('# https://github.com/acme/shop/pull/3#A\n')
    expect(calls[0]?.shown).toContain('rule: Validate bodies.\nscope:\n  - src/api/**\n')
    expect(calls[0]?.shown).toMatch(/^#.*empty.*cancel/im)
    expect(existsSync(calls[0]?.file ?? '')).toBe(false)
    expect(memory.files.get(path)).toContain(
      `  - id: lesson-${id}\n    rule: Validate every body.\n    scope:\n      - src/**\n    from:\n      - https://github.com/acme/shop/pull/3#A\n`,
    )
    expect(err.join('')).toBe(
      `Created ${path} with the rule lesson-${id}; reviews of acme/shop apply it from now on.\n`,
    )
    await runLessons({ ...LIST, all: true }, deps)
    expect(out.join('')).toContain('Validate every body.')
    expect(out.join('')).not.toContain('Validate bodies.')
  })

  it.each([
    ['an empty rule', 'rule: ""\nscope: [src/**]\n', 'rule:'],
    ['no scope', 'rule: Validate.\n', 'scope:'],
    ['an exception glob', 'rule: Validate.\nscope: ["!src/**"]\n', 'scope.0:'],
    ['an id of its own', 'rule: Validate.\nscope: [src/**]\nid: mine\n', 'id'],
    ['broken YAML', 'rule: [\n', 'Flow sequence'],
  ])('writes nothing and keeps the lesson pending for %s', async (_, saved, key) => {
    const { deps, out, seed, memory } = harness()
    const id = await seedLesson(seed)
    const { run } = editor(() => saved)

    const accepting = runLessonsAccept({ id, edit: true }, { ...deps, runInteractive: run })

    await expect(accepting).rejects.toThrow(InvalidLessonEditError)
    await expect(accepting).rejects.toThrow(key)
    expect(memory.files.size).toBe(0)
    await runLessons(LIST, deps)
    expect(out.join('')).toContain('Validate bodies.')
  })

  it.each([
    ['saved empty', () => '\n   \n', 0],
    ['left with comments only', (shown: string) => shown.replace(/^[^#].*$/gm, ''), 0],
    ['ended by the editor with an error', () => 'rule: Edited.\nscope: [src/**]\n', 1],
  ])('cancels the accept when the file is %s', async (_, rewrite, exitCode) => {
    const { deps, out, err, seed, memory } = harness()
    const id = await seedLesson(seed)
    const { run } = editor(rewrite, exitCode)

    await runLessonsAccept({ id, edit: true }, { ...deps, runInteractive: run })

    expect(err.join('')).toBe(`Accept cancelled; nothing written, lesson ${id} is still pending.\n`)
    expect(memory.files.size).toBe(0)
    await runLessons(LIST, deps)
    expect(out.join('')).toContain('Validate bodies.')
  })

  it('opens vi when neither VISUAL nor EDITOR is set, and refuses an editor not found', async () => {
    const { deps, seed } = harness()
    const id = await seedLesson(seed)
    const commands: string[] = []
    const run: typeof runInteractive = async (command) => {
      commands.push(command)
      return { kind: 'not-found', command }
    }

    await expect(
      runLessonsAccept({ id, edit: true }, { ...deps, runInteractive: run }),
    ).rejects.toThrow(new EditorNotFoundError('vi'))
    expect(commands).toEqual(['vi'])
  })
})

describe('runLessonsDiscard', () => {
  it('drops the lesson from the list and writes no config', async () => {
    const { deps, out, err, seed, memory } = harness()
    const id = await seedLesson(seed)

    await runLessonsDiscard({ id }, deps)

    expect(err.join('')).toBe(`Discarded lesson ${id}; phada lessons no longer lists it.\n`)
    expect(memory.files.size).toBe(0)
    await runLessons(LIST, deps)
    expect(out.join('')).not.toContain('Validate bodies.')
  })
})
