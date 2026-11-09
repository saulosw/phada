import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import { cutBytes } from '../context/byte-cut.js'
import { associationRole } from './conversation.js'
import type { AssociationRole } from './conversation.js'
import { parseReviewMarker } from './markers.js'
import { phadaThreads } from './phada-state.js'
import { writtenLine } from './written-line.js'

const MISS_WINDOW_LINES = 5
const LONG_ELEMENT_LINES = 80
const LONG_ELEMENT_WINDOW_LINES = 10
const MISS_BODY_BYTES = 2 * 1024

export interface FindingPlace {
  file: string
  line: number
}

export interface LineSpan {
  startLine: number
  endLine: number
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

export type MissOrigin = 'person' | 'bot' | 'phada'

export type MissSeen = 'missed-live' | 'not-reviewed'

export interface Miss extends MissRange {
  key: string
  origin: MissOrigin
  seen: MissSeen
  repo: string
  number: number
  reviewedSha?: string
  commitSha: string
  threadId?: string
  threadUrl?: string
  author: string
  role?: AssociationRole
  body: string
  createdAt: string
}

export interface MissInput {
  repo: string
  number: number
  state: PullRequestReviewState
  localReviews: readonly LocalReview[]
  bots: readonly string[]
  elementsAt?: (commitSha: string, file: string) => readonly LineSpan[] | undefined
}

interface PhadaReview {
  sha: string
  at: number
  findings: readonly FindingPlace[]
}

export interface ElementSite {
  commitSha: string
  file: string
}

interface Candidate {
  miss: Miss
  findings: FindingPlace[]
}

export function decideMisses(input: MissInput): Miss[] {
  return candidates(input).flatMap(({ miss, findings }) => {
    const elements =
      findings.length === 0 ? undefined : input.elementsAt?.(miss.commitSha, miss.file)
    return findings.some((finding) => isNearMiss(miss, finding, elements)) ? [] : [miss]
  })
}

export function missElementSites(input: MissInput): ElementSite[] {
  const sites = new Map<string, ElementSite>()
  for (const { miss, findings } of candidates(input)) {
    if (findings.length === 0) continue
    sites.set(siteKey(miss.commitSha, miss.file), { commitSha: miss.commitSha, file: miss.file })
  }
  return [...sites.values()]
}

function candidates({ repo, number, state, localReviews, bots }: MissInput): Candidate[] {
  const own = phadaThreads(state)
  const reviews = [...publishedReviews(state), ...localReviews.flatMap(datedReview)]
  const listed = new Set(bots.map(botLogin))
  return state.threads.flatMap((thread): Candidate[] => {
    const origin = originOf(state, thread, listed)
    if (origin === undefined || own.includes(thread) || !thread.isOutdated) return []
    const range = rangeOf(thread)
    const at = thread.createdAt === undefined ? Number.NaN : Date.parse(thread.createdAt)
    if (range === undefined || Number.isNaN(at)) return []
    const before = reviews.filter((review) => review.at < at)
    const reviewed = before.reduce<PhadaReview | undefined>(
      (latest, review) => (latest === undefined || review.at >= latest.at ? review : latest),
      undefined,
    )
    const commitSha = thread.originalCommit ?? reviewed?.sha
    if (commitSha === undefined) return []
    const findings = [
      ...before.flatMap((review) => review.findings),
      ...own.filter((item) => undatedOrUpTo(item, at)).flatMap(placeOf),
    ].filter((finding) => finding.file === range.file)
    const miss: Miss = {
      key: thread.id,
      origin,
      seen: reviewed === undefined ? 'not-reviewed' : 'missed-live',
      repo,
      number,
      ...(reviewed === undefined ? {} : { reviewedSha: reviewed.sha }),
      commitSha,
      threadId: thread.id,
      threadUrl: thread.url,
      ...range,
      author: thread.author,
      role: associationRole(thread.association),
      body: cutCommentBody(thread.body),
      createdAt: thread.createdAt ?? '',
    }
    return [{ miss, findings }]
  })
}

export function siteKey(commitSha: string, file: string): string {
  return `${commitSha}\0${file}`
}

export function isNearMiss(
  range: MissRange,
  finding: FindingPlace,
  elements?: readonly LineSpan[],
): boolean {
  if (finding.file !== range.file) return false
  const { startLine, endLine } = missWindow(range, elements ?? [])
  return finding.line >= startLine && finding.line <= endLine
}

export function missWindow(range: MissRange, elements: readonly LineSpan[]): LineSpan {
  const start = Math.min(range.startLine ?? range.line, range.line)
  const end = Math.max(range.startLine ?? range.line, range.line)
  const element = innermost(elements, range.line)
  if (element === undefined) return around(start, end, MISS_WINDOW_LINES)
  if (element.endLine - element.startLine + 1 > LONG_ELEMENT_LINES) {
    return around(start, end, LONG_ELEMENT_WINDOW_LINES)
  }
  return { startLine: Math.min(start, element.startLine), endLine: Math.max(end, element.endLine) }
}

function innermost(elements: readonly LineSpan[], line: number): LineSpan | undefined {
  return elements
    .filter((element) => element.startLine <= line && line <= element.endLine)
    .reduce<LineSpan | undefined>(
      (inner, element) =>
        inner === undefined || element.endLine - element.startLine < inner.endLine - inner.startLine
          ? element
          : inner,
      undefined,
    )
}

function around(start: number, end: number, lines: number): LineSpan {
  return { startLine: start - lines, endLine: end + lines }
}

function originOf(
  state: PullRequestReviewState,
  thread: ReviewThread,
  bots: ReadonlySet<string>,
): 'person' | 'bot' | undefined {
  if (thread.author === '') return undefined
  if (state.author !== undefined && state.author !== '' && thread.author === state.author) {
    return undefined
  }
  if (thread.bot !== true) return 'person'
  return bots.has(botLogin(thread.author)) ? 'bot' : undefined
}

function botLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, '')
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

export function cutCommentBody(text: string): string {
  return cutBytes(text, MISS_BODY_BYTES, { truncated: 0 })
}
