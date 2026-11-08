import { replyToThreads } from '../app/reply-to-threads.js'
import type { RepliesRun, ReplyToThreadsDeps } from '../app/reply-to-threads.js'
import type { ReplyOptions } from '../app/watch-repositories.js'
import { repositoryCache } from '../config/cache-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import type { ProviderChoice } from '../config/merge-config.js'
import type { ConfigLayer } from '../config/types.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { FetchPullRequestOptions, PullRequestMetadata } from '../github/pull-request.js'
import type {
  PostedReply,
  ReplyAndResolveOptions,
  ThreadOptions,
} from '../github/resolve-thread.js'
import { ProviderError } from '../providers/types.js'
import type { ReviewProvider } from '../providers/types.js'
import type { GitMirror, GitMirrorOptions } from '../repository/git-mirror.js'
import type { HistoryStore } from '../store/history-store.js'
import type { ContextReaders } from './context-sources.js'
import { formatThreadReply } from './format-github.js'
import { messagesFor } from './i18n/messages.js'
import { assertProviderChoice, loadProviderChoice, modelOption } from './provider-choice.js'
import type { ProviderOptions } from './provider-choice.js'
import { effectiveConfigAt } from './repository-config.js'

export interface ThreadReplyDeps extends Pick<ContextReaders, 'fetchRepositoryFile'> {
  env: NodeJS.ProcessEnv
  home: string
  files: LocalFileSystem
  clock: () => Date
  fetchPullRequestMetadata: (options: FetchPullRequestOptions) => Promise<PullRequestMetadata>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  openMirror: (options: GitMirrorOptions) => Promise<GitMirror>
  addThreadReply: (options: ReplyAndResolveOptions) => Promise<PostedReply>
  resolveThread: (options: ThreadOptions) => Promise<void>
  isThreadOpen: (options: ThreadOptions) => Promise<boolean>
}

export interface ThreadReplySetup {
  userLayers: ConfigLayer[]
  choice: ProviderChoice
  language?: string
}

export async function threadReplySetup(
  ref: PullRequestRef,
  pullRequest: PullRequestMetadata,
  token: string,
  deps: ThreadReplyDeps,
): Promise<ThreadReplySetup> {
  const { userLayers, choice } = await loadProviderChoice(ref, {}, deps)
  assertProviderChoice(choice.provider, modelOption(choice), 'config')
  const repository = { owner: ref.owner, repo: ref.repo, token }
  const { language } = await effectiveConfigAt(deps, repository, pullRequest.baseSha, userLayers)
  return { userLayers, choice, ...(language === undefined ? {} : { language }) }
}

export interface ThreadReplyWiring {
  ref: PullRequestRef
  token: string
  pullRequest: PullRequestMetadata
  provider: ReviewProvider
  history:
    Pick<HistoryStore, 'classifiedComments' | 'recordReplies' | 'observeFeedback'> | undefined
  events: ReplyToThreadsDeps['events']
}

export function threadReplyDeps(
  { ref, token, pullRequest, provider, history, events }: ThreadReplyWiring,
  deps: ThreadReplyDeps,
): ReplyToThreadsDeps {
  const { mirror } = repositoryCache(deps.env, deps.home, ref.owner, ref.repo)
  return {
    fetchPullRequest: async () => pullRequest,
    fetchReviewState: () => deps.fetchReviewState({ ...ref, token }),
    ...(history === undefined ? {} : { history }),
    openMirror: () =>
      deps.openMirror({ dir: mirror, owner: ref.owner, repo: ref.repo, token, env: deps.env }),
    provider,
    isUsageLimit: (error) => error instanceof ProviderError && error.reason === 'usage-limit',
    postReply: (threadId, body) => deps.addThreadReply({ token, threadId, body }),
    resolveThread: (threadId) => deps.resolveThread({ token, threadId }),
    threadOpen: (threadId) => deps.isThreadOpen({ token, threadId }),
    formatReply: (text, replyLanguage) => formatThreadReply(text, messagesFor(replyLanguage)),
    now: () => deps.clock().toISOString(),
    events,
  }
}

export interface WatchReplyTarget {
  ref: PullRequestRef
  token: string
  history: Pick<HistoryStore, 'classifiedComments' | 'recordReplies' | 'observeFeedback'>
  options: ReplyOptions
  events: ReplyToThreadsDeps['events']
}

export async function replyOnWatchedPull(
  { ref, token, history, options, events }: WatchReplyTarget,
  deps: ThreadReplyDeps & {
    createProvider: (name: string, options: ProviderOptions) => ReviewProvider
  },
): Promise<RepliesRun> {
  const pullRequest = await deps.fetchPullRequestMetadata({ ...ref, token })
  if (pullRequest.state !== 'open') return { pullRequest, threads: [], limited: false }
  const { choice, language } = await threadReplySetup(ref, pullRequest, token, deps)
  const provider = deps.createProvider(choice.provider, { ...modelOption(choice), detached: true })
  return replyToThreads(
    {
      ref,
      mode: options.mode,
      dryRun: false,
      source: 'watch',
      maxThreads: options.maxThreads,
      ...(language === undefined ? {} : { language }),
    },
    threadReplyDeps({ ref, token, pullRequest, provider, history, events }, deps),
  )
}
