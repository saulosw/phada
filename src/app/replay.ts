import { splitDiff } from '../context/split-diff.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PullComment, PullRequestReviewState } from '../github/pull-request-reviews.js'
import type { PullRequestTimeline, TimelineCommit } from '../github/pull-request-timeline.js'
import type { PullRequest, PullRequestMetadata } from '../github/pull-request.js'
import { commentsAt, reviewStateAt } from '../publish/state-at.js'
import { ciReadersAt } from './ci-at.js'
import type { CiReaders } from './read-ci.js'

export interface ReplayReaders {
  fetchPullRequestMetadata(ref: PullRequestRef): Promise<PullRequestMetadata>
  fetchTimeline(ref: PullRequestRef): Promise<PullRequestTimeline>
  fetchDiffAt(ref: PullRequestRef, base: string, head: string): Promise<string>
}

export interface Replay {
  pullRequest: PullRequest
  at: string
  approximate: boolean
}

export class HeadNotInPullRequestError extends Error {
  override readonly name = 'HeadNotInPullRequestError'
}

export class ReplayNeedsDryRunError extends Error {
  override readonly name = 'ReplayNeedsDryRunError'

  constructor() {
    super('--head only runs with --dry-run: a replay never publishes.')
  }
}

export async function loadReplay(
  ref: PullRequestRef,
  head: string,
  readers: ReplayReaders,
): Promise<Replay> {
  const [metadata, timeline] = await Promise.all([
    readers.fetchPullRequestMetadata(ref),
    readers.fetchTimeline(ref),
  ])
  const commit = commitOf(timeline, head, `${ref.owner}/${ref.repo}#${ref.number}`)
  const [pushed] = timeline.forcePushes
    .filter(({ after }) => after?.oid === commit.oid)
    .map(({ createdAt }) => createdAt)
    .sort(byInstant)
  const diff = await readers.fetchDiffAt(ref, metadata.baseSha, commit.oid)
  const position = timeline.commits.findIndex(({ oid }) => oid === commit.oid)
  return {
    pullRequest: {
      ...metadata,
      headSha: commit.oid,
      diff,
      stats: { ...diffStats(diff), commits: position + 1 || 1 },
    },
    at: pushed ?? commit.committedDate,
    approximate: pushed === undefined,
  }
}

export interface ReplayCut {
  state(state: PullRequestReviewState): PullRequestReviewState
  comments(comments: readonly PullComment[]): PullComment[]
  ci(readers: CiReaders): CiReaders
}

export function replayCut(replay: Replay | undefined): ReplayCut {
  if (replay === undefined) {
    return {
      state: (state) => state,
      comments: (comments) => [...comments],
      ci: (readers) => readers,
    }
  }
  return {
    state: (state) => reviewStateAt(state, replay.at),
    comments: (comments) => commentsAt(comments, replay.at),
    ci: (readers) => ciReadersAt(readers, replay.at),
  }
}

export function replayWarning(replay: Replay): string | undefined {
  if (!replay.approximate) return undefined
  return `The cut is approximate: GitHub does not record when a normal push happened, so the conversation is cut at the commit date of ${replay.pullRequest.headSha.slice(0, 7)} (${replay.at}).`
}

function commitOf(timeline: PullRequestTimeline, head: string, ref: string): TimelineCommit {
  const prefix = head.toLowerCase()
  const known = [
    ...timeline.commits,
    ...timeline.forcePushes.flatMap(({ before, after }) => [before, after]),
  ].filter((commit): commit is TimelineCommit => commit !== null)
  const matches = new Map(
    known.filter(({ oid }) => oid.startsWith(prefix)).map((commit) => [commit.oid, commit]),
  )
  const [match, ...others] = matches.values()
  if (match === undefined) throw new HeadNotInPullRequestError(`${head} is not a commit of ${ref}.`)
  if (others.length > 0) {
    throw new HeadNotInPullRequestError(
      `${head} matches several commits of ${ref}: give more of the SHA.`,
    )
  }
  return match
}

function diffStats(diff: string): { changedFiles: number; additions: number; deletions: number } {
  const { sections } = splitDiff(diff)
  let additions = 0
  let deletions = 0
  for (const { text } of sections) {
    const lines = text.split('\n')
    const hunk = lines.findIndex((line) => line.startsWith('@@'))
    if (hunk === -1) continue
    for (const line of lines.slice(hunk)) {
      if (line.startsWith('+')) additions++
      else if (line.startsWith('-')) deletions++
    }
  }
  return { changedFiles: sections.length, additions, deletions }
}

function byInstant(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b)
}
