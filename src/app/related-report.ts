import { hasLink } from '../graph/repository-links.js'
import type { DiffImpact, RelatedState, RelatedSummary } from '../review/types.js'
import type { OpenedRelated } from './related-repositories.js'
import { rankRelated } from './select-related.js'
import type { SkipReason, SkippedRepository } from './select-related.js'

export interface RelatedEntry {
  repo: string
  origin: string
  description?: string
  commit?: string
  state: RelatedState | 'skipped'
  count?: number
  packages: string[]
  graph: boolean
  reason?: SkipReason
}

export interface RelatedReport {
  status: 'used' | 'off' | 'unavailable' | 'none'
  reason?: string
  repositories: RelatedEntry[]
}

export interface RankedRelated {
  item: OpenedRelated
  state: RelatedState
  count?: number
  order: number
}

export function rankOpened(
  opened: readonly OpenedRelated[],
  impact: DiffImpact | undefined,
): RankedRelated[] {
  const ranked = opened.map((item): RankedRelated => {
    const reach = (impact?.symbols ?? []).flatMap((symbol) =>
      (symbol.related ?? []).filter((entry) => entry.repo === item.repo),
    )
    const callers = reach.reduce((sum, entry) => sum + entry.callers, 0)
    const uses = reach.reduce((sum, entry) => sum + entry.uses, 0)
    const state: RelatedState =
      callers > 0 ? 'consumers' : uses > 0 ? 'uses' : hasLink(item.link) ? 'linked' : 'unlinked'
    return {
      item,
      state,
      ...(callers > 0 ? { count: callers } : uses > 0 ? { count: uses } : {}),
      order: item.order,
    }
  })
  return rankRelated(ranked)
}

export function reachesDropped(
  opened: readonly OpenedRelated[],
  kept: readonly RankedRelated[],
  impact: DiffImpact,
): boolean {
  const keptRepos = new Set(kept.map(({ item }) => item.repo))
  return impact.symbols.some((symbol) =>
    (symbol.related ?? []).some(
      (entry) => !keptRepos.has(entry.repo) && opened.some((item) => item.repo === entry.repo),
    ),
  )
}

export function buildRelatedReport(input: {
  status: RelatedReport['status']
  reason?: string
  opened: readonly OpenedRelated[]
  kept: readonly RankedRelated[]
  skipped: readonly SkippedRepository[]
  graphTools: boolean
}): RelatedReport {
  const keptRepos = new Set(input.kept.map(({ item }) => item.repo))
  return {
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    repositories: [
      ...input.kept.map((ranked) => entryOf(ranked, input.graphTools)),
      ...input.opened
        .filter((item) => !keptRepos.has(item.repo))
        .map((item) => skippedEntry({ ...item, reason: 'limit' })),
      ...input.skipped.map(skippedEntry),
    ],
  }
}

export function relatedSummaries(
  kept: readonly RankedRelated[],
  graphTools: boolean,
): RelatedSummary[] {
  return kept.map(({ item, state, count }) => ({
    repo: item.repo,
    commit: item.commit,
    state,
    ...(count === undefined ? {} : { count }),
    ...(item.description === undefined ? {} : { description: item.description }),
    graph: graphTools && item.graph !== undefined,
  }))
}

function entryOf({ item, state, count }: RankedRelated, graphTools: boolean): RelatedEntry {
  return {
    repo: item.repo,
    origin: item.origin,
    ...(item.description === undefined ? {} : { description: item.description }),
    commit: item.commit,
    state,
    ...(count === undefined ? {} : { count }),
    packages: [...item.link.consumedByRelated, ...item.link.consumedByReviewed].map(
      (ref) => ref.name,
    ),
    graph: graphTools && item.graph !== undefined,
  }
}

function skippedEntry(item: Pick<SkippedRepository, 'repo' | 'origin' | 'reason'>): RelatedEntry {
  return {
    repo: item.repo,
    origin: item.origin,
    state: 'skipped',
    packages: [],
    graph: false,
    reason: item.reason,
  }
}
