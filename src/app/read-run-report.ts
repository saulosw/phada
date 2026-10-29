import { z } from 'zod'
import type { ContextReport } from '../context/types.js'
import type { ImpactReport } from '../graph/report.js'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { BlockedCommand } from '../providers/types.js'
import type { UsageReport } from '../review/token-usage.js'
import type { PassReport } from '../review/types.js'
import type { RelatedReport } from './related-report.js'
import { storedClaims, storedCi, storedFindings } from './read-history.js'
import { numberOf, objectOf, parseJson, stringOf } from './stored-json.js'
import type {
  HistoryReader,
  RunRecord,
  StoredCi,
  StoredClaim,
  StoredFinding,
} from './read-history.js'

export type ConversationEntry =
  | { kind: 'comment'; at: string; author: string; role: string; bytes: number }
  | { kind: 'review'; at: string; author: string; role: string; state: string; bytes: number }
  | {
      kind: 'thread'
      at: string
      author: string
      role: string
      file: string
      line: number | null
      resolved: boolean
      outdated: boolean
      replies: number
      omittedReplies: number
      bytes: number
    }

export interface ConversationBlock {
  count: number
  omitted: number
  resolved: number
  bots: number
  truncated: number
  budget: { limit: number; used: number }
  items: ConversationEntry[]
}

export interface CiCheckLine {
  name: string
  state: string
  conclusion: string | null
  annotations: number
  logBytes: number | null
}

export interface CiBlock {
  state: string
  total: number
  failing: string[]
  pending: string[]
  checks: CiCheckLine[]
  annotations: { sent: number; omitted: number; limit: number }
  logs: { sent: number; omitted: number; limit: number }
  truncated: number
  bytes: number
  warnings: string[]
}

export interface PostedReview {
  body: string
  comments: { path: string; startLine?: number; line: number; body: string }[]
}

export interface StoredPasses {
  reports: PassReport[]
  fixes: ReadonlyMap<BlockedCommand, string>
}

export interface RunReport {
  run: Omit<RunRecord, 'resultJson'>
  result: unknown
  title: string | null
  publishedFrom?: number
  posted?: PostedReview
  closeToCut?: { minConfidence: number; findings: StoredFinding[] }
  claims?: StoredClaim[]
  context?: ContextReport | null
  conversation?: ConversationBlock | null
  ci?: CiBlock | null
  checks?: StoredCi
  impact?: { report: ImpactReport; text?: string } | null
  related?: RelatedReport | null
  passes?: StoredPasses
  investigation?: InvestigationReport | null
  usage?: UsageReport
}

export function readRunReport(
  history: Pick<HistoryReader, 'run'> | undefined,
  id: number,
): RunReport | undefined {
  const stored = history?.run(id)
  return stored === undefined ? undefined : runReportOf(stored)
}

function runReportOf(stored: RunRecord): RunReport {
  const { resultJson, ...run } = stored
  const result = parseJson(resultJson)
  const json = objectOf(result) ?? {}
  const review = objectOf(json.review)
  const ci = blockOf(json, 'ci', CiSchema)
  const passes = review === undefined ? undefined : PassesSchema.safeParse(review.passes)
  return {
    run,
    result: result ?? null,
    title: stringOf(objectOf(json.pullRequest)?.title) ?? null,
    ...defined('publishedFrom', numberOf(json.publishedFrom)),
    ...defined('posted', postedOf(json.publication)),
    ...defined('closeToCut', closeToCutOf(review)),
    ...(Array.isArray(review?.claims) ? { claims: storedClaims(review.claims) } : {}),
    ...defined('context', blockOf(json, 'context', ContextSchema)),
    ...defined('conversation', blockOf(json, 'conversation', ConversationSchema)),
    ...defined('ci', ci),
    ...(ci === undefined ? defined('checks', storedCi(json.ci) ?? undefined) : {}),
    ...defined('impact', blockOf(json, 'impact', ImpactSchema)),
    ...defined('related', blockOf(json, 'related', RelatedSchema)),
    ...(passes?.success === true && passes.data !== null ? { passes: passesOf(passes.data) } : {}),
    ...defined('investigation', blockOf(json, 'investigation', InvestigationSchema)),
    ...defined('usage', UsageSchema.safeParse(json.usage).data),
  }
}

function defined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

function blockOf<T>(
  json: Record<string, unknown>,
  key: string,
  schema: z.ZodType<T>,
): T | null | undefined {
  if (!(key in json)) return undefined
  if (json[key] === null) return null
  const parsed = schema.safeParse(json[key])
  return parsed.success ? parsed.data : undefined
}

function closeToCutOf(
  review: Record<string, unknown> | undefined,
): RunReport['closeToCut'] | undefined {
  const minConfidence = numberOf(review?.minConfidence)
  const findings = review?.findings
  if (minConfidence === undefined || !Array.isArray(findings)) return undefined
  const marked = findings.every((finding) => typeof objectOf(finding)?.closeToCut === 'boolean')
  return marked ? { minConfidence, findings: storedFindings(findings) } : undefined
}

function postedOf(value: unknown): PostedReview | undefined {
  const publication = objectOf(value)
  const body = stringOf(publication?.body)
  if (publication === undefined || body === undefined) return undefined
  const comments = Array.isArray(publication.comments)
    ? publication.comments
    : publication.lineComments
  return { body, comments: list(CommentSchema).parse(comments) }
}

function passesOf(passes: StoredPass[]): StoredPasses {
  const fixes = new Map<BlockedCommand, string>()
  const reports = passes.map(({ blocked, ...pass }): PassReport => {
    const commands = blocked.map(({ tool, input, fix }) => {
      const command = { tool, input }
      if (fix !== undefined) fixes.set(command, fix)
      return command
    })
    return { ...pass, ...(commands.length === 0 ? {} : { blocked: commands }) }
  })
  return { reports, fixes }
}

function optional<T extends z.ZodType>(schema: T) {
  return schema
    .nullish()
    .catch(undefined)
    .transform((value) => value ?? undefined)
}

function list<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((value): z.output<T>[] => {
        const parsed = item.safeParse(value)
        return parsed.success ? [parsed.data] : []
      }),
    )
}

const count = z.number().catch(0)
const strings = z.array(z.string()).catch([])

const CommentSchema = z.object({
  path: z.string(),
  startLine: optional(z.number()),
  line: z.number(),
  body: z.string(),
})

const ContextSchema = z.object({
  configFiles: list(
    z.object({
      path: z.string(),
      origin: z.enum(['repository', 'user']),
      status: z.enum(['loaded', 'invalid']),
      message: optional(z.string()),
    }),
  ),
  rules: list(
    z.object({
      key: z.string(),
      origin: z.string(),
      scope: strings,
      severity: optional(z.enum(['P0', 'P1', 'P2'])),
      status: z.enum(['applied', 'disabled', 'out-of-scope', 'listed']),
    }),
  ),
  docs: list(
    z.object({
      path: z.string(),
      origin: z.enum(['repository', 'local']),
      category: z.enum(['declared', 'module', 'agents', 'contributing', 'other']).catch('other'),
      bytes: count,
      status: z.enum(['included', 'truncated', 'omitted', 'listed']),
      reason: optional(
        z.enum([
          'budget',
          'binary',
          'not-found',
          'unreadable',
          'out-of-scope',
          'manual',
          'excluded',
        ]),
      ),
      scope: optional(z.array(z.string())),
    }),
  ),
  ignored: strings,
  budget: z.object({ limit: count, used: count }).catch({ limit: 0, used: 0 }),
  warnings: strings,
}) satisfies z.ZodType<ContextReport>

const ConversationSchema = z.object({
  count,
  omitted: count,
  resolved: count,
  bots: count,
  truncated: count,
  budget: z.object({ limit: count, used: count }).catch({ limit: 0, used: 0 }),
  items: list(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('comment'),
        at: z.string(),
        author: z.string(),
        role: z.string(),
        bytes: count,
      }),
      z.object({
        kind: z.literal('review'),
        at: z.string(),
        author: z.string(),
        role: z.string(),
        state: z.string(),
        bytes: count,
      }),
      z.object({
        kind: z.literal('thread'),
        at: z.string(),
        author: z.string(),
        role: z.string(),
        file: z.string(),
        line: z.number().nullable().catch(null),
        resolved: z.boolean().catch(false),
        outdated: z.boolean().catch(false),
        replies: count,
        omittedReplies: count,
        bytes: count,
      }),
    ]),
  ),
}) satisfies z.ZodType<ConversationBlock>

const CiSchema = z.object({
  state: z.string(),
  total: count,
  failing: strings,
  pending: strings,
  checks: list(
    z.object({
      name: z.string(),
      state: z.string(),
      conclusion: z.string().nullable().catch(null),
      annotations: count,
      logBytes: z.number().nullable().catch(null),
    }),
  ),
  annotations: z.object({ sent: count, omitted: count, limit: count }),
  logs: z.object({ sent: count, omitted: count, limit: count }),
  truncated: count,
  bytes: z.number(),
  warnings: strings,
}) satisfies z.ZodType<CiBlock>

const ImpactSchema = z
  .object({
    status: z.enum(['used', 'unavailable', 'off']),
    reason: optional(z.string()),
    index: optional(z.object({ files: count, extracted: count, durationMs: count })),
    changed: list(
      z.object({
        kind: z.string(),
        name: z.string(),
        path: z.string(),
        lines: z.tuple([z.number(), z.number()]),
        callers: count,
        files: count,
        shown: count,
        dependencies: count,
        capped: z.boolean().catch(false),
      }),
    ),
    totals: z
      .object({ symbols: count, callers: count, files: count })
      .catch({ symbols: 0, callers: 0, files: 0 }),
    learned: list(z.object({ from: z.string(), to: z.string(), pullRequest: z.number() })),
    text: optional(z.string()),
  })
  .transform(({ text, ...report }): { report: ImpactReport; text?: string } => ({
    report,
    ...(text === undefined ? {} : { text }),
  }))

const RelatedSchema = z.object({
  status: z.enum(['used', 'off', 'unavailable', 'none']),
  reason: optional(z.string()),
  repositories: list(
    z.object({
      repo: z.string(),
      origin: z.string(),
      description: optional(z.string()),
      commit: optional(z.string()),
      state: z.enum(['consumers', 'uses', 'linked', 'unlinked', 'skipped']),
      count: optional(z.number()),
      packages: strings,
      graph: z.boolean().catch(false),
      reason: optional(
        z.enum([
          'reviewed-repository',
          'no-access',
          'empty',
          'private-on-public',
          'fetch-failed',
          'candidate-limit',
          'limit',
        ]),
      ),
    }),
  ),
}) satisfies z.ZodType<RelatedReport>

const TokensSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: optional(z.number()),
  outputTokens: z.number(),
})

const PassSchema = z.object({
  skill: z.string(),
  origin: z.string(),
  status: z.enum(['reviewed', 'skipped', 'failed']),
  mode: optional(z.literal('native')).catch(undefined),
  durationMs: count,
  usage: optional(TokensSchema),
  findings: count,
  reason: optional(z.string()),
  output: optional(z.string()),
  captured: optional(z.number()),
  blocked: list(z.object({ tool: z.string(), input: z.string(), fix: optional(z.string()) })),
})

type StoredPass = z.output<typeof PassSchema>

const PassesSchema = z.array(PassSchema).nullable()

const InvestigationSchema = z.object({
  status: z.enum(['used', 'off', 'unavailable']),
  reason: optional(z.string()),
  calls: list(
    z.object({
      pass: z.enum(['review', 'verify', 'recheck']),
      tool: z.string(),
      server: z.string().nullable().catch(null),
      target: z.string(),
      bytes: count,
      error: z.string().nullable().catch(null),
      inSources: z.boolean().catch(false),
    }),
  ),
  external: list(z.object({ server: z.string(), tool: z.string() })),
  mcp: optional(
    list(
      z.object({
        server: z.string(),
        via: z.enum(['phada', 'cli']),
        status: z.enum(['connected', 'failed', 'off']),
        tools: strings,
        hidden: strings,
        reason: optional(z.string()),
      }),
    ),
  ),
  floor: optional(z.object({ expected: z.number(), shortfalls: strings })),
  totals: z.object({ calls: count, bytes: count }).catch({ calls: 0, bytes: 0 }),
}) satisfies z.ZodType<InvestigationReport>

const UsageSchema = z.object({
  passes: list(
    z.object({
      pass: z.enum(['review', 'verify', 'recheck']),
      skill: optional(z.string()),
      usage: optional(TokensSchema),
    }),
  ),
  total: optional(TokensSchema),
}) satisfies z.ZodType<UsageReport>
