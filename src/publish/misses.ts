import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import { cutBytes } from '../context/byte-cut.js'
import { associationRole } from './conversation.js'
import type { AssociationRole } from './conversation.js'
import { parseReviewMarker } from './markers.js'
import { phadaThreads } from './phada-state.js'
import { writtenLine } from './written-line.js'

const MISS_WINDOW_LINES = 5
const MISS_BODY_BYTES = 2 * 1024

export interface FindingPlace {
  file: string
  line: number
}

export interface MissRange {
  file: string
  startLine?: number
  line: number
}

export interface LocalReview {
  sha: string
  at: string
  findings: readonly FindingPlace[]
}

export interface Miss extends MissRange {
  repo: string
  number: number
  reviewedSha: string
  commitSha: string
  threadId: string
  threadUrl: string
  author: string
  role: AssociationRole
  body: string
  createdAt: string
}

export interface MissInput {
  repo: string
  number: number
  state: PullRequestReviewState
  localReviews: readonly LocalReview[]
}

interface PhadaReview {
  sha: string
  at: number
  findings: readonly FindingPlace[]
}

export function decideMisses({ repo, number, state, localReviews }: MissInput): Miss[] {
  const own = phadaThreads(state)
  const reviews = [...publishedReviews(state), ...localReviews.flatMap(datedReview)]
  return state.threads.flatMap((thread): Miss[] => {
    if (!byPerson(state, thread) || own.includes(thread) || !thread.isOutdated) return []
    const range = rangeOf(thread)
    const at = thread.createdAt === undefined ? Number.NaN : Date.parse(thread.createdAt)
    if (range === undefined || Number.isNaN(at)) return []
    const before = reviews.filter((review) => review.at < at)
    const reviewed = before.reduce<PhadaReview | undefined>(
      (latest, review) => (latest === undefined || review.at >= latest.at ? review : latest),
      undefined,
    )
    if (reviewed === undefined) return []
    const findings = [
      ...before.flatMap((review) => review.findings),
      ...own.filter((item) => undatedOrUpTo(item, at)).flatMap(placeOf),
    ]
    if (findings.some((finding) => isNearMiss(range, finding))) return []
    return [
      {
        repo,
        number,
        reviewedSha: reviewed.sha,
        commitSha: thread.originalCommit ?? reviewed.sha,
        threadId: thread.id,
        threadUrl: thread.url,
        ...range,
        author: thread.author,
        role: associationRole(thread.association),
        body: cutBytes(thread.body, MISS_BODY_BYTES, { truncated: 0 }),
        createdAt: thread.createdAt ?? '',
      },
    ]
  })
}

export function isNearMiss(range: MissRange, finding: FindingPlace): boolean {
  const start = Math.min(range.startLine ?? range.line, range.line)
  const end = Math.max(range.startLine ?? range.line, range.line)
  return (
    finding.file === range.file &&
    finding.line >= start - MISS_WINDOW_LINES &&
    finding.line <= end + MISS_WINDOW_LINES
  )
}

function byPerson(state: PullRequestReviewState, thread: ReviewThread): boolean {
  if (thread.bot === true || thread.author === '') return false
  return state.author === undefined || state.author === '' || thread.author !== state.author
}

function rangeOf(thread: ReviewThread): MissRange | undefined {
  const line = writtenLine(thread)
  if (line === null) return undefined
  return {
    file: thread.path,
    ...(thread.originalStartLine === undefined ? {} : { startLine: thread.originalStartLine }),
    line,
  }
}

function publishedReviews(state: PullRequestReviewState): PhadaReview[] {
  return state.reviews.flatMap((review) => {
    if (review.author === '' || review.author !== state.viewer) return []
    const sha = parseReviewMarker(review.body)?.sha
    const at = review.createdAt === undefined ? Number.NaN : Date.parse(review.createdAt)
    return sha === undefined || Number.isNaN(at) ? [] : [{ sha, at, findings: [] }]
  })
}

function datedReview(review: LocalReview): PhadaReview[] {
  const at = Date.parse(review.at)
  return Number.isNaN(at) ? [] : [{ sha: review.sha, at, findings: review.findings }]
}

function undatedOrUpTo(thread: ReviewThread, at: number): boolean {
  return thread.createdAt === undefined || Date.parse(thread.createdAt) <= at
}

function placeOf(thread: ReviewThread): FindingPlace[] {
  const line = writtenLine(thread)
  return line === null ? [] : [{ file: thread.path, line }]
}
