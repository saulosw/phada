import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeCall, FakeResponse } from '../../test/support/fake-fetch.js'
import { memoryFiles } from '../../test/support/memory-files.js'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import { ThreadPermissionError } from '../github/errors.js'
import { fetchReviewState } from '../github/pull-request-reviews.js'
import { fetchPullRequestMetadata } from '../github/pull-request.js'
import { ACCEPT_DIFF, ACCEPT_JSON } from '../github/request.js'
import { addThreadReply, isThreadOpen, resolveThread } from '../github/resolve-thread.js'
import { ClaudeCliProvider } from '../providers/claude.js'
import { replyMarker } from '../publish/markers.js'
import { openHistoryStore } from '../store/history-store.js'
import { UsageError } from './errors.js'
import { runReply } from './reply-command.js'
import type { ReplyCommand, ReplyCommandDeps } from './reply-command.js'

const FAKE_CLAUDE = resolve('test/fixtures/bin/fake-claude')
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const REF = { owner: 'saulosw', repo: 'phada-dev-web', number: 3 }
const REPLY_ID = 'PRRC_kwDOQNCyRM6PqB77'
const ANSWER_URL = 'https://github.com/saulosw/phada-dev-web/pull/3#discussion_r9'

const root = mkdtempSync(join(tmpdir(), 'phada-reply-command-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let runs = 0

type Json = Record<string, unknown>
const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/github/${name}`, import.meta.url), 'utf8')
const ok = (body: unknown): FakeResponse => ({
  status: 200,
  body: typeof body === 'string' ? body : JSON.stringify(body),
})
const data = (value: unknown): FakeResponse => ok({ data: value })

function pullRequestJson(state = 'open'): string {
  return JSON.stringify({ ...(JSON.parse(fixture('pull-request.json')) as Json), state })
}

function threadsWithoutReplies(): Json {
  const page = JSON.parse(fixture('graphql-threads.json')) as {
    data: { repository: { pullRequest: { reviewThreads: { nodes: Json[] } } } }
  }
  for (const node of page.data.repository.pullRequest.reviewThreads.nodes) {
    const replies = node.replies as { nodes: Json[]; totalCount: number }
    replies.nodes = replies.nodes.slice(0, 1)
    replies.totalCount = 1
  }
  return page
}

function routeOf(call: FakeCall): string {
  if (!call.url.endsWith('/graphql')) return call.headers['accept'] ?? ''
  const query = (JSON.parse(call.body ?? '{}') as { query: string }).query
  if (query.includes('addPullRequestReviewThreadReply')) return 'reply'
  if (query.includes('resolveReviewThread')) return 'resolve'
  if (query.includes('node(id:')) return 'thread-state'
  if (query.includes('reviewThreads')) return 'threads'
  return 'reviews'
}

const variablesOf = (call: FakeCall | undefined) =>
  (JSON.parse(call?.body ?? '{}') as { variables: Json }).variables

interface Setup {
  answers?: string[]
  state?: string
  threads?: FakeResponse
  reply?: FakeResponse
  config?: string
  repoConfig?: string
}

function setup(options: Setup = {}) {
  const dir = join(root, `r${(runs += 1)}`)
  mkdirSync(dir)
  const answersFile = join(dir, 'answers.json')
  writeFileSync(answersFile, JSON.stringify(options.answers ?? []))
  const github = createFakeFetch(
    {
      [ACCEPT_JSON]: [ok(pullRequestJson(options.state))],
      [ACCEPT_DIFF]: [{ status: 406, body: JSON.stringify({ message: 'diff too large' }) }],
      reviews: [ok(fixture('graphql-reviews.json'))],
      threads: [options.threads ?? ok(fixture('graphql-threads.json'))],
      'thread-state': [data({ node: { isResolved: false } })],
      reply: [
        options.reply ??
          data({ addPullRequestReviewThreadReply: { comment: { id: 'C9', url: ANSWER_URL } } }),
      ],
      resolve: [data({ resolveReviewThread: { thread: { id: 'x', isResolved: true } } })],
    },
    routeOf,
  )
  const fetch = github.fetch
  const out: string[] = []
  const err: string[] = []
  const providers: string[] = []
  const historyFile = join(dir, 'data', 'history.sqlite')
  const deps: ReplyCommandDeps = {
    env: { GITHUB_TOKEN: TOKEN, PHADA_CONFIG_HOME: '/cfg', PHADA_DATA_HOME: join(dir, 'data') },
    ghToken: async () => undefined,
    home: '/home/u',
    files: memoryFiles(options.config === undefined ? {} : { '/cfg/config.yml': options.config }),
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    clock: () => new Date('2026-11-08T12:00:00.000Z'),
    onSignal: () => undefined,
    abort: () => undefined,
    fetchPullRequestMetadata: (pull) => fetchPullRequestMetadata({ ...pull, fetch }),
    fetchReviewState: (pull) => fetchReviewState({ ...pull, fetch }),
    fetchRepositoryFile: async ({ path }) =>
      path === '.phada/config.yml' ? (options.repoConfig ?? null) : null,
    openMirror: async () => memoryMirror({ 'api/src/routes/users.ts': 'export {}\n' }),
    openHistoryStore: (path) => {
      mkdirSync(join(dir, 'data'), { recursive: true })
      return openHistoryStore(path)
    },
    createProvider: (name) => {
      providers.push(name)
      return new ClaudeCliProvider({
        command: FAKE_CLAUDE,
        homeDir: dir,
        env: { ...process.env, FAKE_CLAUDE_MODE: 'answers', FAKE_CLAUDE_ANSWERS: answersFile },
      })
    },
    addThreadReply: (thread) => addThreadReply({ ...thread, fetch }),
    resolveThread: (thread) => resolveThread({ ...thread, fetch }),
    isThreadOpen: (thread) => isThreadOpen({ ...thread, fetch }),
  }
  return {
    deps,
    calls: github.calls,
    routes: () => github.calls.map(routeOf),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    providers,
    answersLeft: () => JSON.parse(readFileSync(answersFile, 'utf8')) as string[],
    history: async () => {
      if (!existsSync(historyFile)) return undefined
      const history = await openHistoryStore(historyFile)
      try {
        return history.replies({ repo: 'saulosw/phada-dev-web' })
      } finally {
        history.close()
      }
    },
  }
}

const command = (overrides: Partial<ReplyCommand> = {}): ReplyCommand => ({
  ref: REF,
  dryRun: false,
  format: 'text',
  ...overrides,
})

const QUESTION = JSON.stringify({
  kind: 'question',
  reply: 'The user id still comes from req.body in line 63.',
})

describe('runReply', { timeout: 20_000 }, () => {
  it('shows the kind and the answer in a dry run and posts and keeps nothing', async () => {
    const h = setup({ answers: [QUESTION] })

    expect(await runReply(command({ dryRun: true }), h.deps)).toBe(0)

    expect(h.stdout()).toBe(
      [
        'api/src/routes/users.ts:63 · question · not posted (dry run)',
        '  The user id still comes from req.body in line 63.',
        '',
        '1 thread on saulosw/phada-dev-web#3: dry run, nothing was posted or kept.',
        '',
      ].join('\n'),
    )
    expect(h.routes()).not.toContain('reply')
    expect(h.routes()).not.toContain('thread-state')
    expect(await h.history()).toBeUndefined()
    expect(h.stderr()).toContain('Reading the threads of Phada on saulosw/phada-dev-web#3…\n')
  })

  it('answers on a pull request whose diff is too large to read, without reading it', async () => {
    const h = setup({ answers: [QUESTION] })

    expect(await runReply(command(), h.deps)).toBe(0)

    expect(h.routes()).not.toContain(ACCEPT_DIFF)
    expect(h.routes()).toContain('reply')
  })

  it('posts the answer to a question with the automatic-reply line and keeps it', async () => {
    const h = setup({ answers: [QUESTION] })

    expect(await runReply(command(), h.deps)).toBe(0)

    const reply = h.calls[h.routes().indexOf('reply')]
    expect(variablesOf(reply)).toEqual({
      threadId: 'PRRT_kwDOQNCyRM5c8pXa',
      body: `The user id still comes from req.body in line 63.\n\n<sub>🦋 Automatic reply from Phada</sub>\n\n${replyMarker('question')}`,
    })
    expect(h.routes()).not.toContain('resolve')
    expect(h.stdout()).toContain(
      `api/src/routes/users.ts:63 · question · posted\n  The user id still comes from req.body in line 63.\n  ${ANSWER_URL}\n`,
    )
    expect(h.stdout()).toContain('1 thread on saulosw/phada-dev-web#3: 1 answer posted.\n')
    expect(await h.history()).toMatchObject([
      {
        commentId: REPLY_ID,
        author: 'octocat',
        kind: 'question',
        answered: true,
        source: 'manual',
      },
    ])
    expect(h.providers).toEqual(['claude'])
  })

  it('acknowledges a refuted comment and resolves the thread', async () => {
    const h = setup({
      answers: [
        JSON.stringify({ kind: 'refuted', reply: 'You are right: the guard is upstream.' }),
      ],
    })

    expect(await runReply(command(), h.deps)).toBe(0)

    expect(h.routes().filter((route) => route === 'reply' || route === 'resolve')).toEqual([
      'reply',
      'resolve',
    ])
    expect(h.stdout()).toContain('api/src/routes/users.ts:63 · refuted · posted and resolved\n')
    expect(await h.history()).toMatchObject([{ kind: 'refuted', answered: true, resolved: true }])
  })

  it('refuses a closed or merged pull request before any AI call', async () => {
    const h = setup({ state: 'closed', answers: [QUESTION] })

    const failure = runReply(command(), h.deps)

    await expect(failure).rejects.toBeInstanceOf(UsageError)
    await expect(failure).rejects.toThrow(
      'saulosw/phada-dev-web#3 is closed: phada reply answers on open pull requests only.',
    )
    expect(h.answersLeft()).toEqual([QUESTION])
    expect(h.routes()).not.toContain('threads')
  })

  it('prints the run as JSON', async () => {
    const h = setup({ answers: [QUESTION] })

    expect(await runReply(command({ format: 'json', dryRun: true }), h.deps)).toBe(0)

    expect(JSON.parse(h.stdout())).toEqual({
      pullRequest: { repo: 'saulosw/phada-dev-web', number: 3 },
      dryRun: true,
      limited: false,
      threads: [
        {
          threadId: 'PRRT_kwDOQNCyRM5c8pXa',
          url: 'https://github.com/saulosw/phada-dev-web/pull/11#discussion_r2410000001',
          file: 'api/src/routes/users.ts',
          line: 63,
          kind: 'question',
          text: 'The user id still comes from req.body in line 63.',
          posted: false,
          resolved: false,
          answerUrl: null,
          skipped: null,
        },
      ],
    })
  })

  it('says when there is nothing to answer, without the AI', async () => {
    const h = setup({ threads: ok(threadsWithoutReplies()) })

    expect(await runReply(command(), h.deps)).toBe(0)

    expect(h.stdout()).toBe(
      "Nothing to answer on saulosw/phada-dev-web#3: no new reply in Phada's open threads.\n",
    )
    expect(h.routes()).not.toContain('reply')
  })

  it('stops and exits with 1 when the AI usage limit is reached', async () => {
    const h = setup({ answers: ['usage_limit'] })

    expect(await runReply(command(), h.deps)).toBe(1)

    expect(h.stdout()).toBe('')
    expect(h.stderr()).toContain(
      'phada: The AI usage limit stopped phada reply; the threads not answered are answered on the next run.\n',
    )
    expect(h.routes()).not.toContain('reply')
    expect(await h.history()).toEqual([])
  })

  it('writes the answer and its line in the language of the config', async () => {
    const h = setup({
      answers: [JSON.stringify({ kind: 'question', reply: 'O id vem do body.' })],
      repoConfig: 'language: pt-BR\n',
    })

    expect(await runReply(command(), h.deps)).toBe(0)

    const body = variablesOf(h.calls[h.routes().indexOf('reply')]).body
    expect(body).toContain('O id vem do body.\n\n<sub>🦋 Resposta automática do Phada</sub>')
  })

  it('keeps no classification with the history off', async () => {
    const h = setup({ answers: [QUESTION], config: 'history: false\n' })

    expect(await runReply(command(), h.deps)).toBe(0)

    expect(h.routes()).toContain('reply')
    expect(await h.history()).toBeUndefined()
  })

  it('fails with the permission the token needs when GitHub refuses the reply', async () => {
    const h = setup({
      answers: [QUESTION],
      reply: ok({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }),
    })

    await expect(runReply(command(), h.deps)).rejects.toBeInstanceOf(ThreadPermissionError)
  })
})
