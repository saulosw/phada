import type { OpenPull } from '../github/list-pull-requests.js'
import type { PullRequestMetadata } from '../github/pull-request.js'

export interface PullFacts {
  repo: string
  number: number
  headSha: string
  state: 'open' | 'closed'
  private: boolean
  association: string
  author?: string
  draft?: boolean
  baseRef?: string
  title?: string
  labels?: string[]
}

export function listedPullFacts(repo: string, pull: OpenPull): PullFacts {
  return {
    repo,
    number: pull.number,
    headSha: pull.headSha,
    state: 'open',
    private: pull.private,
    association: pull.association,
    author: pull.author,
    draft: pull.draft,
    baseRef: pull.baseRef,
    labels: pull.labels,
    ...(pull.title === undefined ? {} : { title: pull.title }),
  }
}

export function fetchedPullFacts(pull: PullRequestMetadata): PullFacts {
  return {
    repo: pull.repo,
    number: pull.number,
    headSha: pull.headSha,
    state: pull.state,
    private: pull.private,
    association: pull.association,
    author: pull.author,
    draft: pull.draft,
    baseRef: pull.baseRef,
    labels: pull.labels ?? [],
    title: pull.title,
  }
}
