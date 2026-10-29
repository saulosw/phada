import type { PullRequestTarget } from '../../app/requested-review.js'
import { oneLine } from '../text-fit.js'
import { pullRef } from '../refs.js'

export const GAP = '  '

export function pullRequestText(target: PullRequestTarget, title: string | null): string {
  return title === null ? refText(target) : `${refText(target)} · ${oneLine(title)}`
}

export function refText({ owner, repo, number }: PullRequestTarget): string {
  return pullRef(`${owner}/${repo}`, number)
}
