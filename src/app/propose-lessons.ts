import type { ReviewProvider } from '../providers/types.js'
import type { AssociationRole } from '../publish/conversation.js'
import type { RunFinding } from '../publish/vanished-findings.js'
import { newNonce } from '../review/nonce.js'
import { buildLessonsPrompt } from '../review/lessons-prompt.js'
import type { KnownRule, LessonFinding, LessonHit } from '../review/lessons-prompt.js'
import { parseLessons } from '../review/parse-lessons.js'
import type { ReplyKind } from '../review/types.js'
import type {
  ClassifiedReply,
  FindingRecord,
  HistoryStore,
  LessonChanges,
  MissRecord,
} from '../store/history-store.js'
import { storedFindings } from './harvest-misses.js'
import { checkLessonAnswers } from './lesson-answers.js'

const TEAM_ROLES: ReadonlySet<AssociationRole> = new Set(['owner', 'member', 'collaborator'])
const REFUSING_SIGNALS: ReadonlySet<string> = new Set(['dismissed', 'negative-reaction'])
const REFUSING_REPLIES: ReadonlySet<ReplyKind> = new Set(['refuted', 'disagreed'])
const NEW_MISSES_PER_CALL = 50
const EARLIER_MISSES_PER_CALL = 25
const NEW_FINDINGS_PER_CALL = 30
const EARLIER_FINDINGS_PER_CALL = 15
const HITS_PER_CALL = 20
const CALLS_PER_REPOSITORY = 5

export interface LessonSetup {
  provider: ReviewProvider
  rules: readonly KnownRule[]
}

export interface RepositoryLessons {
  repo: string
  sent: number
  created: number
  attached: number
  sentFindings: number
  attachedFindings: number
}

export interface LessonBatchSize {
  fresh: number
  earlier: number
  freshFindings: number
  earlierFindings: number
}

export interface ProposeLessonsDeps {
  history: Pick<
    HistoryStore,
    | 'misses'
    | 'findings'
    | 'replies'
    | 'run'
    | 'lessons'
    | 'linkedMissIds'
    | 'linkedFindingIds'
    | 'recordLessons'
  >
  setup: (repo: string) => Promise<LessonSetup>
  now: () => string
  events: {
    proposing: (repo: string, batch: LessonBatchSize) => void
    proposed: (result: RepositoryLessons) => void
  }
}

type History = ProposeLessonsDeps['history']

interface Candidates {
  misses: MissRecord[]
  findings: AvoidCandidate[]
  fixed: FindingRecord[]
}

interface AvoidCandidate {
  finding: FindingRecord
  replies: ClassifiedReply[]
}

interface Batch {
  fresh: MissRecord[]
  earlier: MissRecord[]
  freshFindings: AvoidCandidate[]
  earlierFindings: AvoidCandidate[]
  fixed: FindingRecord[]
}

export async function proposeLessons(
  filter: { repo?: string },
  deps: ProposeLessonsDeps,
): Promise<RepositoryLessons[]> {
  const repos = reposWithNewEntries(deps.history, filter.repo)
  if (filter.repo !== undefined && repos.length === 0) {
    return [emptyResult(filter.repo.toLowerCase())]
  }
  const results: RepositoryLessons[] = []
  for (const repo of repos) {
    const result = await proposeFor(repo, deps)
    deps.events.proposed(result)
    results.push(result)
  }
  return results
}

function emptyResult(repo: string): RepositoryLessons {
  return { repo, sent: 0, created: 0, attached: 0, sentFindings: 0, attachedFindings: 0 }
}

function reposWithNewEntries(history: History, repo: string | undefined): string[] {
  const { misses, findings } = candidates(history, repo)
  const repos = new Set([
    ...misses.filter(isNew).map((miss) => miss.repo),
    ...findings.filter(({ finding }) => isNew(finding)).map(({ finding }) => finding.repo),
  ])
  return [...repos].sort((a, b) => a.localeCompare(b))
}

function candidates(history: History, repo: string | undefined): Candidates {
  const scope = repo === undefined ? {} : { repo }
  const linkedMisses = history.linkedMissIds()
  const linkedFindings = history.linkedFindingIds()
  const replies = repliesByThread(history.replies(scope))
  const published = history
    .findings(scope)
    .filter((finding) => finding.threadId !== undefined)
    .sort(latestFirst)
  return {
    misses: history
      .misses({ ...scope, state: 'open' })
      .misses.filter((miss) => isLearnable(miss, linkedMisses)),
    findings: published
      .map((finding) => ({ finding, replies: replies.get(finding.threadId ?? '') ?? [] }))
      .filter((candidate) => isRefused(candidate) && !linkedFindings.has(candidate.finding.id)),
    fixed: published.filter((finding) => activeSignals(finding).includes('fixed')),
  }
}

function repliesByThread(replies: readonly ClassifiedReply[]): Map<string, ClassifiedReply[]> {
  const byThread = new Map<string, ClassifiedReply[]>()
  for (const reply of replies) {
    byThread.set(reply.threadId, [...(byThread.get(reply.threadId) ?? []), reply])
  }
  return byThread
}

function latestFirst(a: FindingRecord, b: FindingRecord): number {
  return b.publishedAt.localeCompare(a.publishedAt) || b.id - a.id
}

function activeSignals(finding: FindingRecord): string[] {
  return finding.signals.filter(({ clearedAt }) => clearedAt === undefined).map(({ kind }) => kind)
}

function isRefused({ finding, replies }: AvoidCandidate): boolean {
  return (
    activeSignals(finding).some((kind) => REFUSING_SIGNALS.has(kind)) ||
    replies.some(({ kind }) => REFUSING_REPLIES.has(kind))
  )
}

function isNew(entry: { lessonsSentAt?: string }): boolean {
  return entry.lessonsSentAt === undefined
}

function isLearnable(miss: MissRecord, linked: ReadonlySet<number>): boolean {
  return (
    miss.origin === 'person' &&
    miss.role !== undefined &&
    TEAM_ROLES.has(miss.role) &&
    !linked.has(miss.id)
  )
}

function nextBatch(history: History, repo: string): Batch {
  const { misses, findings, fixed } = candidates(history, repo)
  const freshFindings = findings
    .filter(({ finding }) => isNew(finding))
    .slice(0, NEW_FINDINGS_PER_CALL)
  const earlierFindings = findings
    .filter(({ finding }) => !isNew(finding))
    .slice(0, EARLIER_FINDINGS_PER_CALL)
  const files = new Set([...freshFindings, ...earlierFindings].map(({ finding }) => finding.file))
  return {
    fresh: misses.filter(isNew).slice(0, NEW_MISSES_PER_CALL),
    earlier: misses.filter((miss) => !isNew(miss)).slice(0, EARLIER_MISSES_PER_CALL),
    freshFindings,
    earlierFindings,
    fixed: fixed.filter(({ file }) => files.has(file)).slice(0, HITS_PER_CALL),
  }
}

async function proposeFor(repo: string, deps: ProposeLessonsDeps): Promise<RepositoryLessons> {
  const { provider, rules } = await deps.setup(repo)
  const result = emptyResult(repo)
  for (let call = 0; call < CALLS_PER_REPOSITORY; call++) {
    const batch = nextBatch(deps.history, repo)
    if (batch.fresh.length === 0 && batch.freshFindings.length === 0) break
    deps.events.proposing(repo, {
      fresh: batch.fresh.length,
      earlier: batch.earlier.length,
      freshFindings: batch.freshFindings.length,
      earlierFindings: batch.earlierFindings.length,
    })
    const changes = await proposeBatch(repo, batch, provider, rules, deps)
    result.sent += batch.fresh.length
    result.sentFindings += batch.freshFindings.length
    result.created += changes.created.length
    for (const { missIds, findingIds = [] } of changes.attached) {
      result.attached += missIds.length
      result.attachedFindings += findingIds.length
    }
  }
  return result
}

async function proposeBatch(
  repo: string,
  batch: Batch,
  provider: ReviewProvider,
  rules: readonly KnownRule[],
  deps: ProposeLessonsDeps,
): Promise<Pick<LessonChanges, 'created' | 'attached'>> {
  const misses = [...batch.fresh, ...batch.earlier]
  const findings = [...batch.freshFindings, ...batch.earlierFindings]
  const pending = deps.history.lessons({ repo, states: ['pending'] })
  const output = await provider.review(
    buildLessonsPrompt(
      {
        repo,
        misses: misses.map(({ id, number, file, line, role, body }) => ({
          id,
          number,
          file,
          line,
          role: role ?? '',
          body,
        })),
        findings: findings.map((candidate) => lessonFinding(candidate, deps.history)),
        hits: batch.fixed.map(lessonHit),
        pending: pending.map(({ id, kind, rule, scope }) => ({ id, kind, rule, scope })),
        rules,
      },
      newNonce(),
    ),
  )
  const changes = checkLessonAnswers(parseLessons(output.text), {
    misses,
    findings: findings.map(({ finding }) => finding),
    pending,
  })
  deps.history.recordLessons(
    {
      repo,
      provider: provider.id,
      ...(output.model === undefined ? {} : { model: output.model }),
      ...changes,
      sent: batch.fresh.map(({ id }) => id),
      sentFindings: batch.freshFindings.map(({ finding }) => finding.id),
    },
    deps.now(),
  )
  return changes
}

function lessonFinding({ finding, replies }: AvoidCandidate, history: History): LessonFinding {
  const { id, number, file, line, severity, rule, title } = finding
  return {
    id,
    number,
    file,
    ...(line === undefined ? {} : { line }),
    ...(severity === undefined ? {} : { severity }),
    ...(rule === undefined ? {} : { rule }),
    title,
    why: whyOf(finding, history),
    signals: activeSignals(finding),
    replies: replies.map(({ kind, body }) => ({ kind, ...(body === undefined ? {} : { body }) })),
  }
}

function whyOf(finding: FindingRecord, history: History): string {
  const run = finding.runId === undefined ? undefined : history.run(finding.runId)
  const reported = storedFindings(run?.resultJson) ?? []
  const same = (item: RunFinding) => item.file === finding.file && item.title === finding.title
  const match =
    reported.find((item) => same(item) && item.line === finding.line) ?? reported.find(same)
  return match?.body ?? ''
}

function lessonHit({ file, line, title }: FindingRecord): LessonHit {
  return { file, ...(line === undefined ? {} : { line }), title }
}
