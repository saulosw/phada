import { field, stringField } from './json-fields.js'
import { fetchPullRequestPages } from './pull-request-reviews.js'
import type { FetchReviewStateOptions } from './pull-request-reviews.js'

const TIMELINE_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $after, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on PullRequestCommit { commit { oid committedDate } }
          ... on HeadRefForcePushedEvent {
            createdAt
            beforeCommit { oid committedDate }
            afterCommit { oid committedDate }
          }
        }
      }
    }
  }
}`

export interface TimelineCommit {
  oid: string
  committedDate: string
}

export interface ForcePush {
  createdAt: string
  before: TimelineCommit | null
  after: TimelineCommit | null
}

export interface PullRequestTimeline {
  commits: TimelineCommit[]
  forcePushes: ForcePush[]
}

export async function fetchPullRequestTimeline(
  options: FetchReviewStateOptions,
): Promise<PullRequestTimeline> {
  const pages = await fetchPullRequestPages(options, TIMELINE_QUERY, 'timelineItems')
  const nodes = pages.flatMap(({ nodes }) => nodes)
  return {
    commits: nodes
      .filter((node) => stringField(node, '__typename') === 'PullRequestCommit')
      .map((node) => commitOf(node, 'commit')),
    forcePushes: nodes
      .filter((node) => stringField(node, '__typename') === 'HeadRefForcePushedEvent')
      .map((node) => ({
        createdAt: stringField(node, 'createdAt'),
        before: field(node, 'beforeCommit') === null ? null : commitOf(node, 'beforeCommit'),
        after: field(node, 'afterCommit') === null ? null : commitOf(node, 'afterCommit'),
      })),
  }
}

function commitOf(node: unknown, path: string): TimelineCommit {
  return {
    oid: stringField(node, `${path}.oid`),
    committedDate: stringField(node, `${path}.committedDate`),
  }
}
