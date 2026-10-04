import { randomBytes } from 'node:crypto'
import type { ReviewProvider } from '../providers/types.js'
import { buildReviewPrompt } from './prompt.js'
import type { ReviewOutcome, ReviewRequest } from './types.js'

export interface RunReviewDeps {
  provider: ReviewProvider
  createNonce?: () => string
}

export async function runReview(
  request: ReviewRequest,
  deps: RunReviewDeps,
): Promise<ReviewOutcome> {
  const { pullRequest } = request
  if (pullRequest.diff.trim() === '') return { status: 'skipped', reason: 'empty-diff' }

  const createNonce = deps.createNonce ?? randomNonce
  const { text, durationMs, model, additionalModels, usage } = await deps.provider.review(
    buildReviewPrompt(request, createNonce()),
  )
  return {
    status: 'reviewed',
    result: {
      target: { repo: pullRequest.repo, number: pullRequest.number, headSha: pullRequest.headSha },
      providerId: deps.provider.id,
      ...(model === undefined ? {} : { model }),
      ...(additionalModels === undefined ? {} : { additionalModels }),
      text,
      durationMs,
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

function randomNonce(): string {
  return randomBytes(6).toString('hex')
}
