import { errorMessage } from '../app/error-message.js'
import { recordFeedback } from '../app/feedback.js'
import { publishSavedReview } from '../app/publish-saved-review.js'
import type { SavedPublication } from '../app/publish-saved-review.js'
import type { HistorySave } from '../app/requested-review.js'
import { dataFiles } from '../config/data-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import type { CreatedReview, CreateReviewOptions } from '../github/create-review.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { FetchPullRequestOptions } from '../github/pull-request.js'
import type { ReplyAndResolveOptions } from '../github/resolve-thread.js'
import { openExistingHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { publishedRunJson } from './format-json.js'
import { renderReview } from './review-wiring.js'

export interface PublishSavedDeps {
  env: NodeJS.ProcessEnv
  home: string
  files: LocalFileSystem
  clock: () => Date
  fetchPullRequestHead: (
    options: FetchPullRequestOptions,
  ) => Promise<{ state: 'open' | 'closed'; draft: boolean; headSha: string }>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  createReview: (options: CreateReviewOptions) => Promise<CreatedReview>
  replyAndResolve: (options: ReplyAndResolveOptions) => Promise<void>
  openHistoryStore: (path: string) => Promise<HistoryStore>
}

export interface SavedRunPublication {
  publication: SavedPublication
  history?: HistorySave
  json?: string
}

export async function publishSavedRun(
  id: number,
  force: boolean,
  token: string,
  deps: PublishSavedDeps,
  warning: (message: string) => void,
): Promise<SavedRunPublication> {
  const opening = await openExistingHistoryStore(dataFiles(deps.env, deps.home).history, {
    exists: (file) => deps.files.exists(file),
    open: deps.openHistoryStore,
  })
  if (opening.status === 'missing') {
    return { publication: { status: 'refused', refusal: { kind: 'not-found' } } }
  }
  if (opening.status !== 'open') throw opening.error
  const { history } = opening
  try {
    const startedAt = deps.clock().toISOString()
    const publication = await publishSavedReview(
      { id, force },
      {
        readRun: (runId) => history.run(runId),
        fetchHead: (ref) => deps.fetchPullRequestHead({ ...ref, token }),
        fetchReviewState: (ref) => deps.fetchReviewState({ ...ref, token }),
        render: renderReview,
        createReview: (ref, commitSha, rendered) =>
          deps.createReview({
            ...ref,
            token,
            commitSha,
            body: rendered.body,
            comments: rendered.comments,
          }),
        replyAndResolve: (threadId, body) => deps.replyAndResolve({ token, threadId, body }),
        events: { warning },
      },
    )
    if (publication.status !== 'published') return { publication }
    const json = publicationJson(publication)
    return {
      publication,
      json,
      history: await savePublished(history, publication, json, startedAt, deps),
    }
  } finally {
    history.close()
  }
}

type Published = Extract<SavedPublication, { status: 'published' }>

function publicationJson({ saved, url, plan, rendered, resolved }: Published): string {
  return publishedRunJson(
    saved.json,
    {
      status: 'published',
      url,
      comments: rendered.comments.length,
      stillOpen: plan.stillOpen.length,
      dismissed: plan.dismissed.length,
      resolved,
      review: rendered,
    },
    saved.run.id,
  )
}

async function savePublished(
  history: HistoryStore,
  publication: Published,
  json: string,
  startedAt: string,
  deps: PublishSavedDeps,
): Promise<HistorySave> {
  const { run, ref, stored } = publication.saved
  const layers = await loadUserLayers({ ...deps, owner: ref.owner, repo: ref.repo })
  if (!historyEnabled(layers)) return { status: 'off' }
  const finishedAt = deps.clock().toISOString()
  let runId: number
  try {
    runId = history.addRun({
      source: 'manual',
      repo: run.repo,
      number: run.number,
      headSha: stored.pullRequest.headSha,
      startedAt,
      finishedAt,
      status: 'published',
      aiCalled: false,
      ...(run.provider === undefined ? {} : { provider: run.provider }),
      ...(run.model === undefined ? {} : { model: run.model }),
      ...(run.score === undefined ? {} : { score: run.score }),
      ...(run.findings === undefined ? {} : { findings: run.findings }),
      ...(run.verdict === undefined ? {} : { verdict: run.verdict }),
      url: publication.url,
      resultJson: json,
    })
  } catch (error) {
    return { status: 'not-saved', error: errorMessage(error) }
  }
  try {
    recordFeedback(
      history,
      stored.pullRequest,
      publication.reviewState,
      publication.plan.comments,
      { runId, source: 'manual', now: finishedAt },
    )
  } catch (error) {
    return { status: 'saved', runId, feedbackError: errorMessage(error) }
  }
  return { status: 'saved', runId }
}
