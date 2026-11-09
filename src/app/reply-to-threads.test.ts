import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import type { ReviewThread, ThreadComment } from '../github/pull-request-reviews.js'
import { ProviderError } from '../providers/types.js'
import type { ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { FINDING_MARKER, replyMarker } from '../publish/markers.js'
import { CheckoutUnavailableError } from '../repository/git-checkout.js'
import type { ReplyKind } from '../review/types.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { replyToThreads } from './reply-to-threads.js'
import type { ReplyToThreadsDeps, ReplyToThreadsInput } from './reply-to-threads.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-reply-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0
const freshHistory = () => openHistoryStore(join(dir, `h${++files}`, 'history.sqlite'))

const NOW = '2026-11-08T12:00:00.000Z'
const VIEWER = 'phada-owner'
const PULL = pullRequestFixture({ author: 'alice' })
const REF = { owner: 'acme', repo: 'shop', number: PULL.number }
const FINDING_BODY = `**P1** · Spend has no auth · confidence 90\n\nAnyone can spend.\n\n${FINDING_MARKER}`
const HUNK = '@@ -1,3 +1,3 @@\n-old\n+spend(id)'

function comment(id: string, author: string, body: string, extra: Partial<ThreadComment> = {}) {
  return { id, author, body, bot: false, association: 'NONE', ...extra } satisfies ThreadComment
}

const FINDING = comment('C1', VIEWER, FINDING_BODY, { association: 'OWNER' })

function thread(id: string, replies: ThreadComment[], overrides: Partial<ReviewThread> = {}) {
  return reviewThread({
    id,
    author: VIEWER,
    body: FINDING_BODY,
    path: 'src/shop.ts',
    line: 3,
    url: `https://github.com/acme/shop/pull/12#${id}`,
    diffHunk: HUNK,
    replies: [FINDING, ...replies],
    ...overrides,
  })
}

const answer = (kind: ReplyKind, reply = '') => JSON.stringify({ kind, reply })

function fakeProvider(answers: (string | Error)[]) {
  const prompts: ReviewPrompt[] = []
  const provider: ReviewProvider = {
    id: 'fake',
    review: async (prompt) => {
      prompts.push(prompt)
      const next = answers.shift()
      if (next === undefined) throw new Error('no answer queued')
      if (next instanceof Error) throw next
      return { text: next, durationMs: 5 }
    },
  }
  return { provider, prompts }
}

interface Setup {
  threads: ReviewThread[]
  answers: (string | Error)[]
  history?: HistoryStore
  open?: Record<string, boolean>
  mirrorFails?: boolean
}

function setup({ threads, answers, history, open = {}, mirrorFails = false }: Setup) {
  const { provider, prompts } = fakeProvider(answers)
  const posted: { threadId: string; body: string }[] = []
  const resolved: string[] = []
  const warnings: string[] = []
  const mirror = memoryMirror({ 'src/shop.ts': 'spend(id)\n' })
  let closed = 0
  const deps: ReplyToThreadsDeps = {
    fetchPullRequest: async () => PULL,
    fetchReviewState: async () =>
      reviewState({ viewer: VIEWER, author: 'alice', headSha: PULL.headSha, threads }),
    ...(history === undefined ? {} : { history }),
    openMirror: async () => {
      if (mirrorFails) throw new CheckoutUnavailableError('git-missing', 'git is not installed')
      return {
        ...mirror,
        checkout: (sha, options) => {
          const checkout = mirror.checkout(sha, options)
          return {
            ...checkout,
            close: async () => {
              closed++
            },
          }
        },
      }
    },
    provider,
    isUsageLimit: (error) => error instanceof ProviderError && error.reason === 'usage-limit',
    postReply: async (threadId, body) => {
      posted.push({ threadId, body })
      return {
        id: `R${posted.length}`,
        url: `https://github.com/acme/shop/pull/12#r${posted.length}`,
      }
    },
    resolveThread: async (threadId) => {
      resolved.push(threadId)
    },
    threadOpen: async (threadId) => open[threadId] ?? true,
    formatReply: (text, language) => `${text}\n\n<sub>auto ${language ?? 'en'}</sub>`,
    now: () => NOW,
    events: { warning: (message) => warnings.push(message) },
  }
  return { deps, prompts, posted, resolved, warnings, mirror, closed: () => closed }
}

const INPUT: ReplyToThreadsInput = {
  ref: REF,
  mode: 'auto',
  dryRun: false,
  source: 'manual',
}

describe('replyToThreads', () => {
  it('answers a question in the thread with the marker and records the classification', async () => {
    const history = await freshHistory()
    const question = comment('C2', 'alice', 'Why is this unsafe?')
    const run = setup({
      threads: [thread('T1', [question])],
      answers: [answer('question', 'Because the caller is not checked.')],
      history,
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.limited).toBe(false)
    expect(result.threads).toEqual([
      {
        threadId: 'T1',
        url: 'https://github.com/acme/shop/pull/12#T1',
        file: 'src/shop.ts',
        line: 3,
        kind: 'question',
        text: 'Because the caller is not checked.',
        posted: true,
        resolved: false,
        answerUrl: 'https://github.com/acme/shop/pull/12#r1',
      },
    ])
    expect(run.posted).toEqual([
      {
        threadId: 'T1',
        body: `Because the caller is not checked.\n\n<sub>auto en</sub>\n\n${replyMarker('question')}`,
      },
    ])
    expect(run.resolved).toEqual([])
    expect(history.replies({})).toEqual([
      {
        repo: 'acme/shop',
        number: 12,
        threadId: 'T1',
        commentId: 'C2',
        author: 'alice',
        body: 'Why is this unsafe?',
        kind: 'question',
        answered: true,
        answerId: 'R1',
        answerUrl: 'https://github.com/acme/shop/pull/12#r1',
        resolved: false,
        source: 'manual',
        observedAt: NOW,
      },
    ])
    history.close()
  })

  it('records the reply of the person cut to 2 KB', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [thread('T1', [comment('C2', 'alice', `We want this.${'x'.repeat(3000)}`)])],
      answers: [answer('disagreed', 'It stays unsafe.')],
      history,
    })

    await replyToThreads(INPUT, run.deps)

    const [recorded] = history.replies({})
    expect(recorded?.body?.startsWith('We want this.x')).toBe(true)
    expect(recorded?.body).toContain('[truncated by Phada: 2048 of 3013 bytes]')
    history.close()
  })

  it('records what it read of the threads, so each reply kind joins its finding', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [thread('T1', [comment('C2', 'alice', 'Why?')])],
      answers: [answer('question', 'Because.')],
      history,
    })

    await replyToThreads(INPUT, run.deps)

    expect(history.findings({ repo: 'acme/shop' })).toMatchObject([
      { number: 12, threadId: 'T1', file: 'src/shop.ts', title: 'Spend has no auth' },
    ])
    history.close()
  })

  it('in a dry run records nothing it read', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [thread('T1', [comment('C2', 'alice', 'Why?')])],
      answers: [answer('question', 'Because.')],
      history,
    })

    await replyToThreads({ ...INPUT, dryRun: true }, run.deps)

    expect(history.findings({ repo: 'acme/shop' })).toEqual([])
    history.close()
  })

  it('sends the AI the comment, the thread with roles, the diff hunk, the language and the tools of the head', async () => {
    const question = comment('C2', 'alice', 'Why?')
    const run = setup({
      threads: [thread('T1', [question])],
      answers: [answer('question', 'Because.')],
    })

    await replyToThreads({ ...INPUT, language: 'Portuguese' }, run.deps)

    const [prompt] = run.prompts
    expect(prompt?.data).toContain('Anyone can spend.')
    expect(prompt?.data).toContain(JSON.stringify('Why?'))
    expect(prompt?.data).toContain('"role":"phada"')
    expect(prompt?.data).toContain('"role":"person"')
    expect(prompt?.data).toContain(HUNK)
    expect(prompt?.instructions).toContain('Portuguese')
    expect(prompt?.tools?.definitions.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['read_file']),
    )
    expect(run.mirror.fetched).toEqual([
      { ref: PULL.headSha, keepAs: `refs/phada/pull/${PULL.number}` },
    ])
    expect(run.closed()).toBe(1)
    expect(run.posted[0]?.body).toContain('<sub>auto Portuguese</sub>')
  })

  it('posts nothing for an acknowledgement or an applied fix and still records them', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [
        thread('T1', [comment('C2', 'alice', 'Thanks!'), comment('C3', 'alice', 'Nice catch.')]),
        thread('T2', [comment('C4', 'alice', 'Done in the last commit.')], {
          replies: [comment('C5', VIEWER, FINDING_BODY), comment('C4', 'alice', 'Done.')],
        }),
      ],
      answers: [answer('ack'), answer('applied')],
      history,
    })

    const result = await replyToThreads({ ...INPUT, source: 'watch' }, run.deps)

    expect(result.threads.map(({ kind, posted }) => ({ kind, posted }))).toEqual([
      { kind: 'ack', posted: false },
      { kind: 'applied', posted: false },
    ])
    expect(run.posted).toEqual([])
    expect(
      history.replies({}).map(({ commentId, kind, answered, source }) => ({
        commentId,
        kind,
        answered,
        source,
      })),
    ).toEqual([
      { commentId: 'C2', kind: 'ack', answered: false, source: 'watch' },
      { commentId: 'C3', kind: 'ack', answered: false, source: 'watch' },
      { commentId: 'C4', kind: 'applied', answered: false, source: 'watch' },
    ])
    history.close()
  })

  it('acknowledges a refuted finding and resolves the thread', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [thread('T1', [comment('C2', 'alice', 'The caller checks the session first.')])],
      answers: [answer('refuted', 'You are right, the caller checks it.')],
      history,
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.threads[0]).toMatchObject({ kind: 'refuted', posted: true, resolved: true })
    expect(run.posted[0]?.body).toContain(replyMarker('refuted'))
    expect(run.resolved).toEqual(['T1'])
    expect(history.replies({})[0]).toMatchObject({
      kind: 'refuted',
      answered: true,
      resolved: true,
    })
    history.close()
  })

  it('records a refuted reply as posted but not resolved when resolving fails', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [thread('T1', [comment('C2', 'alice', 'Not a bug.')])],
      answers: [answer('refuted', 'Right.')],
      history,
    })
    const denied = new Error('denied')
    run.deps.resolveThread = async () => {
      throw denied
    }

    await expect(replyToThreads(INPUT, run.deps)).rejects.toBe(denied)
    expect(history.replies({})[0]).toMatchObject({ answered: true, resolved: false })
    history.close()
  })

  it('answers each comment once: the classified ones are left out', async () => {
    const history = await freshHistory()
    history.recordReplies([
      {
        repo: 'acme/shop',
        number: 12,
        threadId: 'T1',
        commentId: 'C2',
        author: 'alice',
        kind: 'ack',
        answered: false,
        resolved: false,
        source: 'watch',
        observedAt: NOW,
      },
    ])
    const run = setup({
      threads: [
        thread('T1', [comment('C2', 'alice', 'Thanks!')]),
        thread('T2', [comment('C3', 'alice', 'Why?')]),
      ],
      answers: [answer('question', 'Because.')],
      history,
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.threads.map(({ threadId }) => threadId)).toEqual(['T2'])
    expect(run.prompts).toHaveLength(1)
    history.close()
  })

  it('stops answering a thread where Phada already replied three times', async () => {
    const replies = ['a', 'b', 'c'].flatMap((name, index) => [
      comment(`P${index}`, 'alice', `Question ${name}?`),
      comment(`Q${index}`, VIEWER, `Answer.\n\n${replyMarker('question')}`),
    ])
    const run = setup({
      threads: [thread('T1', [...replies, comment('C9', 'alice', 'And now?')])],
      answers: [],
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.threads).toEqual([])
    expect(run.prompts).toEqual([])
    expect(run.mirror.fetched).toEqual([])
  })

  it('in mention mode, answers only a thread that calls /phada', async () => {
    const run = setup({
      threads: [
        thread('T1', [comment('C2', 'alice', 'Why?')]),
        thread('T2', [comment('C3', 'alice', '/phada why is this a problem?')]),
      ],
      answers: [answer('question', 'Because.')],
    })

    const result = await replyToThreads({ ...INPUT, mode: 'mention' }, run.deps)

    expect(result.threads.map(({ threadId }) => threadId)).toEqual(['T2'])
  })

  it('skips a thread resolved while the AI answered, and records the classification as not answered', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [thread('T1', [comment('C2', 'alice', 'I disagree.')])],
      answers: [answer('disagreed', 'The check is still missing.')],
      history,
      open: { T1: false },
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.threads[0]).toMatchObject({
      kind: 'disagreed',
      posted: false,
      resolved: false,
      skipped: 'resolved',
    })
    expect(run.posted).toEqual([])
    expect(history.replies({})[0]).toMatchObject({ kind: 'disagreed', answered: false })
    history.close()
  })

  it('warns about an invalid answer, posts and records nothing and goes on with the next thread', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [
        thread('T1', [comment('C2', 'alice', 'Why?')]),
        thread('T2', [comment('C3', 'alice', 'Why not?')]),
      ],
      answers: ['not json', answer('question', 'Because.')],
      history,
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.threads.map(({ threadId }) => threadId)).toEqual(['T2'])
    expect(result.unanswered).toBe(1)
    expect(run.warnings).toEqual([expect.stringContaining('src/shop.ts:3')])
    expect(history.replies({}).map(({ commentId }) => commentId)).toEqual(['C3'])
    history.close()
  })

  it('stops at the usage limit of the provider and says so', async () => {
    const run = setup({
      threads: [
        thread('T1', [comment('C2', 'alice', 'Why?')]),
        thread('T2', [comment('C3', 'alice', 'Why not?')]),
        thread('T3', [comment('C4', 'alice', 'Really?')]),
      ],
      answers: [
        answer('question', 'Because.'),
        new ProviderError('fake', 'usage-limit', 'limit reached'),
        answer('question', 'Never asked.'),
      ],
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.limited).toBe(true)
    expect(result.threads.map(({ threadId }) => threadId)).toEqual(['T1'])
    expect(run.prompts).toHaveLength(2)
    expect(run.closed()).toBe(1)
  })

  it('lets any other failure of the provider or GitHub through and still closes the checkout', async () => {
    const failed = new ProviderError('fake', 'failed', 'crashed')
    const run = setup({
      threads: [thread('T1', [comment('C2', 'alice', 'Why?')])],
      answers: [failed],
    })

    await expect(replyToThreads(INPUT, run.deps)).rejects.toBe(failed)
    expect(run.closed()).toBe(1)
  })

  it('in a dry run shows the answers but posts, resolves and records nothing', async () => {
    const history = await freshHistory()
    const run = setup({
      threads: [
        thread('T1', [comment('C2', 'alice', 'Why?')]),
        thread('T2', [comment('C3', 'alice', 'Not a bug.')]),
      ],
      answers: [answer('question', 'Because.'), answer('refuted', 'Right.')],
      history,
    })

    const result = await replyToThreads({ ...INPUT, dryRun: true }, run.deps)

    expect(
      result.threads.map(({ kind, text, posted, resolved }) => ({ kind, text, posted, resolved })),
    ).toEqual([
      { kind: 'question', text: 'Because.', posted: false, resolved: false },
      { kind: 'refuted', text: 'Right.', posted: false, resolved: false },
    ])
    expect(run.posted).toEqual([])
    expect(run.resolved).toEqual([])
    expect(history.replies({})).toEqual([])
    history.close()
  })

  it('without a history answers what came after the last comment of Phada', async () => {
    const run = setup({
      threads: [
        thread('T1', [
          comment('C2', 'alice', 'Why?'),
          comment('C3', VIEWER, `Because.\n\n${replyMarker('question')}`),
          comment('C4', 'alice', 'And now?'),
        ]),
      ],
      answers: [answer('question', 'Still.')],
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.threads).toHaveLength(1)
    expect(run.prompts[0]?.data).toContain(JSON.stringify('And now?'))
  })

  it('answers without tools when the checkout is unavailable', async () => {
    const run = setup({
      threads: [thread('T1', [comment('C2', 'alice', 'Why?')])],
      answers: [answer('question', 'Because.')],
      mirrorFails: true,
    })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result.threads).toHaveLength(1)
    expect(run.prompts[0]?.tools).toBeUndefined()
    expect(run.warnings).toEqual(['git is not installed: replying without investigation.'])
  })

  it('answers at most the threads asked and says more are left', async () => {
    const run = setup({
      threads: ['T1', 'T2', 'T3'].map((id, index) =>
        thread(id, [comment(`C${index + 2}`, 'alice', 'Thanks')]),
      ),
      answers: [answer('ack'), answer('ack')],
    })

    const result = await replyToThreads({ ...INPUT, maxThreads: 2 }, run.deps)

    expect(result.threads.map(({ threadId }) => threadId)).toEqual(['T1', 'T2'])
    expect(result.more).toBe(true)
    expect(run.prompts).toHaveLength(2)
  })

  it('opens nothing when no thread needs a reply', async () => {
    const run = setup({ threads: [thread('T1', [])], answers: [] })

    const result = await replyToThreads(INPUT, run.deps)

    expect(result).toEqual({ pullRequest: PULL, threads: [], limited: false })
    expect(run.mirror.fetched).toEqual([])
  })
})
