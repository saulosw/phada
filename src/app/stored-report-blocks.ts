import { z } from 'zod'
import type { ContextReport } from '../context/types.js'
import type { ImpactReport } from '../graph/report.js'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { BlockedCommand } from '../providers/types.js'
import type { DiffGroupReport, PassReport } from '../review/types.js'
import type { RelatedReport } from './related-report.js'
import { stringOf } from './stored-json.js'

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
  omittedBots: number
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
export interface ReportBlocks {
  ci: CiBlock | null | undefined
  context: ContextReport | null | undefined
  conversation: ConversationBlock | null | undefined
  impact: { report: ImpactReport; text?: string } | null | undefined
  related: RelatedReport | null | undefined
  investigation: InvestigationReport | null | undefined
}

export function reportBlocksOf(json: Record<string, unknown>): ReportBlocks {
  return {
    ci: blockOf(json, 'ci', CiSchema),
    context: blockOf(json, 'context', ContextSchema),
    conversation: blockOf(json, 'conversation', ConversationSchema),
    impact: blockOf(json, 'impact', ImpactSchema),
    related: blockOf(json, 'related', RelatedSchema),
    investigation: blockOf(json, 'investigation', InvestigationSchema),
  }
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

export function postedOf(publication: Record<string, unknown>): PostedReview | null {
  const body = stringOf(publication.body)
  if (body === undefined) return null
  const comments = Array.isArray(publication.comments)
    ? publication.comments
    : publication.lineComments
  return { body, comments: list(CommentSchema).parse(comments) }
}

export function passesOf(review: Record<string, unknown>): StoredPasses | null {
  const parsed = PassesSchema.safeParse(review.passes)
  if (!parsed.success || parsed.data === null) return null
  const fixes = new Map<BlockedCommand, string>()
  const reports = parsed.data.map(({ blocked, ...pass }): PassReport => {
    const commands = blocked.map(({ tool, input, fix }) => {
      const command = { tool, input }
      if (fix !== undefined) fixes.set(command, fix)
      return command
    })
    return { ...pass, ...(commands.length === 0 ? {} : { blocked: commands }) }
  })
  return { reports, fixes }
}

export function groupsOf(value: unknown): DiffGroupReport[] | null {
  return Array.isArray(value) ? GroupsSchema.parse(value) : null
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
  omittedBots: count,
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

const PassesSchema = z.array(PassSchema).nullable()

const GroupsSchema = list(
  z.object({
    label: z.string(),
    files: strings,
    bytes: count,
    link: z.enum(['directory', 'single']).catch('directory'),
    findings: count,
    durationMs: count,
    usage: optional(TokensSchema),
    failed: z
      .boolean()
      .catch(false)
      .transform((failed) => (failed ? (true as const) : undefined)),
  }),
)

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
  totals: z.object({ calls: count, bytes: count }).catch({ calls: 0, bytes: 0 }),
}) satisfies z.ZodType<InvestigationReport>
