import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import type { PullRequestMetadata } from '../github/pull-request.js'
import { createInvestigation } from '../investigation/create-investigation.js'
import type { Investigation } from '../investigation/create-investigation.js'
import type { ReviewProvider } from '../providers/types.js'
import { replyMarker } from '../publish/markers.js'
import { isPhadaComment } from '../publish/phada-state.js'
import { threadsToReply } from '../publish/reply-candidates.js'
import type { RepliesMode, ThreadToReply } from '../publish/reply-candidates.js'
import { CheckoutUnavailableError } from '../repository/git-checkout.js'
import type { GitMirror } from '../repository/git-mirror.js'
import { InvalidReviewReportError } from '../review/errors.js'
import { replyToThread } from '../review/reply-to-thread.js'
import type { ReplyAnswer, ReplyKind, ReplyThread } from '../review/types.js'
import type { ClassifiedReply, HistoryStore, ReplySource } from '../store/history-store.js'
import { errorMessage } from './error-message.js'
import { observation } from './feedback.js'

export interface ReplyToThreadsInput {
  ref: PullRequestRef
  mode: RepliesMode
  dryRun: boolean
  source: ReplySource
  language?: string
  maxThreads?: number
}

export interface PostedReply {
  id: string
  url: string
}

export interface ReplyToThreadsDeps {
  fetchPullRequest(ref: PullRequestRef): Promise<PullRequestMetadata>
  fetchReviewState(ref: PullRequestRef): Promise<PullRequestReviewState>
  history?: Pick<HistoryStore, 'classifiedComments' | 'recordReplies' | 'observeFeedback'>
  openMirror(): Promise<GitMirror>
  provider: ReviewProvider
  isUsageLimit(error: unknown): boolean
  postReply(threadId: string, body: string): Promise<PostedReply>
  resolveThread(threadId: string): Promise<void>
  threadOpen(threadId: string): Promise<boolean>
  formatReply(text: string, language: string | undefined): string
  now(): string
  events: {
    warning(message: string): void
    replied?(reply: ThreadReply): void
  }
}

export interface ThreadReply {
  threadId: string
  url: string
  file: string
  line: number | null
  kind: ReplyKind
  text?: string
  posted: boolean
  resolved: boolean
  answerUrl?: string
  skipped?: 'resolved'
}

export interface RepliesRun {
  pullRequest: PullRequestMetadata
  threads: ThreadReply[]
  limited: boolean
  more?: true
  unanswered?: number
}

const ANSWERED: ReadonlySet<ReplyKind> = new Set(['question', 'disagreed', 'refuted'])

export async function replyToThreads(
  input: ReplyToThreadsInput,
  deps: ReplyToThreadsDeps,
): Promise<RepliesRun> {
  const pullRequest = await deps.fetchPullRequest(input.ref)
  const state = await deps.fetchReviewState(input.ref)
  if (!input.dryRun) {
    deps.history?.observeFeedback(
      observation(pullRequest.repo, pullRequest.number, state, input.source, deps.now()),
    )
  }
  const classified =
    deps.history?.classifiedComments(pullRequest.repo, pullRequest.number) ?? new Set<string>()
  const candidates = threadsToReply(state, { mode: input.mode, classified })
  if (candidates.length === 0) return { pullRequest, threads: [], limited: false }
  const pending = candidates.slice(0, input.maxThreads)
  const more = pending.length < candidates.length ? { more: true as const } : {}

  const investigation = await openInvestigation(pullRequest, deps)
  const threads: ThreadReply[] = []
  let unanswered = 0
  const left = () => (unanswered === 0 ? {} : { unanswered })
  try {
    for (const item of pending) {
      const answer = await answerOf(input, deps, pullRequest, state, item, investigation)
      if (answer === 'limited') return { pullRequest, threads, limited: true, ...left() }
      if (answer === undefined) {
        unanswered += 1
        continue
      }
      const reply = await deliver(input, deps, pullRequest, item, answer)
      threads.push(reply)
      deps.events.replied?.(reply)
    }
    return { pullRequest, threads, limited: false, ...more, ...left() }
  } finally {
    await investigation?.close()
  }
}

async function openInvestigation(
  pullRequest: PullRequestMetadata,
  deps: ReplyToThreadsDeps,
): Promise<Investigation | undefined> {
  const keepAs = `refs/phada/pull/${pullRequest.number}`
  try {
    const mirror = await deps.openMirror()
    const sha = await mirror.fetch(pullRequest.headSha, keepAs)
    return createInvestigation(mirror.checkout(sha, { deepenAs: keepAs }))
  } catch (error) {
    if (!(error instanceof CheckoutUnavailableError)) throw error
    deps.events.warning(`${error.message}: replying without investigation.`)
    return undefined
  }
}

async function answerOf(
  input: ReplyToThreadsInput,
  deps: ReplyToThreadsDeps,
  pullRequest: PullRequestMetadata,
  state: PullRequestReviewState,
  item: ThreadToReply,
  investigation: Investigation | undefined,
): Promise<ReplyAnswer | 'limited' | undefined> {
  const thread = replyThread(state, item)
  try {
    return await replyToThread(
      {
        pullRequest: { ...pullRequest, diff: '' },
        ...(input.language === undefined ? {} : { language: input.language }),
      },
      thread,
      deps.provider,
      undefined,
      investigation?.tools('reply'),
    )
  } catch (error) {
    if (deps.isUsageLimit(error)) return 'limited'
    if (!(error instanceof InvalidReviewReportError)) throw error
    deps.events.warning(
      `Could not answer the reply on ${placeOf(thread)}: ${errorMessage(error)} It is tried again next time.`,
    )
    return undefined
  }
}

function replyThread(state: PullRequestReviewState, { thread }: ThreadToReply): ReplyThread {
  return {
    file: thread.path,
    line: thread.line ?? thread.originalLine ?? null,
    comment: thread.body,
    ...(thread.diffHunk === undefined ? {} : { diffHunk: thread.diffHunk }),
    conversation: thread.replies.map((reply) => ({
      author: reply.author,
      role: isPhadaComment(state, reply) ? 'phada' : 'person',
      body: reply.body,
      ...(reply.createdAt === undefined ? {} : { createdAt: reply.createdAt }),
    })),
  }
}

async function deliver(
  input: ReplyToThreadsInput,
  deps: ReplyToThreadsDeps,
  pullRequest: PullRequestMetadata,
  item: ThreadToReply,
  answer: ReplyAnswer,
): Promise<ThreadReply> {
  const { thread } = item
  const reply: ThreadReply = {
    threadId: thread.id,
    url: thread.url,
    file: thread.path,
    line: thread.line ?? thread.originalLine ?? null,
    kind: answer.kind,
    ...(answer.text === undefined ? {} : { text: answer.text }),
    posted: false,
    resolved: false,
  }
  if (input.dryRun) return reply
  const record = (delivered: ThreadReply, posted?: PostedReply) =>
    deps.history?.recordReplies(
      classifiedReplies(input, deps, pullRequest, item, delivered, posted),
    )
  if (!ANSWERED.has(answer.kind) || answer.text === undefined) {
    record(reply)
    return reply
  }
  if (!(await deps.threadOpen(thread.id))) {
    const skipped: ThreadReply = { ...reply, skipped: 'resolved' }
    record(skipped)
    return skipped
  }
  const body = `${deps.formatReply(answer.text, input.language)}\n\n${replyMarker(answer.kind)}`
  const posted = await deps.postReply(thread.id, body)
  const answered: ThreadReply = { ...reply, posted: true, answerUrl: posted.url }
  if (answer.kind !== 'refuted') {
    record(answered, posted)
    return answered
  }
  try {
    await deps.resolveThread(thread.id)
  } catch (error) {
    record(answered, posted)
    throw error
  }
  const resolved: ThreadReply = { ...answered, resolved: true }
  record(resolved, posted)
  return resolved
}

function classifiedReplies(
  input: ReplyToThreadsInput,
  deps: ReplyToThreadsDeps,
  pullRequest: PullRequestMetadata,
  { thread, comments }: ThreadToReply,
  reply: ThreadReply,
  posted: PostedReply | undefined,
): ClassifiedReply[] {
  const observedAt = deps.now()
  return comments.flatMap((comment) =>
    comment.id === undefined
      ? []
      : [
          {
            repo: pullRequest.repo,
            number: pullRequest.number,
            threadId: thread.id,
            commentId: comment.id,
            author: comment.author,
            kind: reply.kind,
            answered: reply.posted,
            ...(posted === undefined ? {} : { answerId: posted.id, answerUrl: posted.url }),
            resolved: reply.resolved,
            source: input.source,
            observedAt,
          },
        ],
  )
}

function placeOf({ file, line }: ReplyThread): string {
  return line === null ? file : `${file}:${line}`
}
