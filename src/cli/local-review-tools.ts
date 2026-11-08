import { errorMessage } from '../app/error-message.js'
import type { HistorySave } from '../app/requested-review.js'
import type { Toolbox, ToolDefinition, ToolResult } from '../investigation/toolbox.js'
import { MissingGitHubTokenError } from './errors.js'
import { WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS } from './queue-tools.js'

export interface LocalChangesRequest {
  token: string
  base?: string
  uncommitted: boolean
}

export interface LocalChangesReview {
  json: string
  history: HistorySave
  warnings: readonly string[]
}

export interface LocalReviewToolsDeps {
  readToken(): Promise<string | undefined>
  review(request: LocalChangesRequest): Promise<LocalChangesReview>
  now(): Date
  sleep(ms: number): Promise<void>
}

const WAIT_POLL_MS = 2_000

const DEFINITIONS: ToolDefinition[] = [
  {
    name: 'review_local_changes',
    description:
      'Start a Phada review of the local changes of the git repository this server runs in: the commits of the current branch since its merge base with the default branch (or with base), before any pull request exists. Nothing is published; the review is saved in the local history. Answers at once with the id of the review; call wait_for_local_review with it. One review runs at a time: while one runs, this answers its id.',
    inputSchema: {
      type: 'object',
      properties: {
        base: {
          type: 'string',
          description: 'The branch or commit to compare with. Default: the default branch',
        },
        uncommitted: {
          type: 'boolean',
          description: 'Also review the staged, modified and untracked files. Default: false',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'wait_for_local_review',
    description: `Wait until a local review ends and return it: the verdict, the summary and the findings with their files and lines, the warnings of the run, and the id of the run in the history. Gives up after timeoutSeconds (default ${WAIT_DEFAULT_SECONDS}, at most ${WAIT_MAX_SECONDS}) with timedOut: true; call it again to keep waiting.`,
    inputSchema: {
      type: 'object',
      properties: {
        review: { type: 'integer', description: 'The id review_local_changes answered' },
        timeoutSeconds: { type: 'integer', minimum: 1 },
      },
      required: ['review'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]

type Outcome = { ok: true; review: LocalChangesReview } | { ok: false; error: unknown }

interface Started {
  done: Promise<Outcome>
  outcome?: Outcome
}

interface LocalReviews {
  started: Map<number, Started>
  running?: number
}

export function localReviewToolbox(deps: LocalReviewToolsDeps): Toolbox {
  const reviews: LocalReviews = { started: new Map() }
  return {
    definitions: DEFINITIONS,
    touchedPaths: () => [],
    call: async (name, args) => {
      try {
        const input = (typeof args === 'object' && args !== null ? args : {}) as Record<
          string,
          unknown
        >
        switch (name) {
          case 'review_local_changes':
            return await startLocalReview(input, deps, reviews)
          case 'wait_for_local_review':
            return await waitForLocalReview(input, deps, reviews)
          default:
            return failure(`Unknown tool ${name}.`)
        }
      } catch (error) {
        return failure(errorMessage(error))
      }
    },
  }
}

async function startLocalReview(
  input: Record<string, unknown>,
  deps: LocalReviewToolsDeps,
  reviews: LocalReviews,
): Promise<ToolResult> {
  if (input.base !== undefined && typeof input.base !== 'string') {
    return failure('base must be the name of a branch or a commit.')
  }
  if (input.uncommitted !== undefined && typeof input.uncommitted !== 'boolean') {
    return failure('uncommitted must be true or false.')
  }
  const token = await deps.readToken()
  if (token === undefined) return failure(new MissingGitHubTokenError().message)
  if (reviews.running !== undefined) {
    return answer({
      review: reviews.running,
      alreadyRunning: true,
      message: `Local review ${reviews.running} is already running; wait for it with wait_for_local_review.`,
    })
  }
  const id = reviews.started.size + 1
  reviews.running = id
  const started: Started = {
    done: Promise.resolve()
      .then(() =>
        deps.review({
          token,
          ...(typeof input.base === 'string' ? { base: input.base } : {}),
          uncommitted: input.uncommitted === true,
        }),
      )
      .then(
        (review): Outcome => ({ ok: true, review }),
        (error: unknown): Outcome => ({ ok: false, error }),
      )
      .then((outcome) => {
        started.outcome = outcome
        reviews.running = undefined
        return outcome
      }),
  }
  reviews.started.set(id, started)
  return answer({ review: id })
}

async function waitForLocalReview(
  input: Record<string, unknown>,
  deps: LocalReviewToolsDeps,
  reviews: LocalReviews,
): Promise<ToolResult> {
  if (typeof input.review !== 'number' || !Number.isInteger(input.review)) {
    return failure('review must be the id review_local_changes answered.')
  }
  const id = input.review
  const started = reviews.started.get(id)
  if (started === undefined) return failure(`There is no local review ${id}.`)
  const asked =
    typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : WAIT_DEFAULT_SECONDS
  const deadline = deps.now().getTime() + Math.min(Math.max(asked, 1), WAIT_MAX_SECONDS) * 1000
  while (started.outcome === undefined) {
    const left = deadline - deps.now().getTime()
    if (left <= 0) return answer({ timedOut: true, review: id })
    await Promise.race([started.done, deps.sleep(Math.min(WAIT_POLL_MS, left))])
  }
  const { outcome } = started
  if (!outcome.ok) return failure(errorMessage(outcome.error))
  const { json, history, warnings } = outcome.review
  return answer({
    timedOut: false,
    review: id,
    result: JSON.parse(json) as unknown,
    ...(history.status === 'saved' ? { runId: history.runId } : {}),
    ...(history.status === 'not-saved' ? { historyError: history.error } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}

function answer(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2), isError: false }
}

function failure(text: string): ToolResult {
  return { text, isError: true }
}
