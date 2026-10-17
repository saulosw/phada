import type { DeclaredRepository } from '../config/merge-config.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { RelatedState } from '../review/types.js'

export const MAX_RELATED = 7
export const MAX_RELATED_CANDIDATES = 20

export type SkipReason =
  'reviewed-repository' | 'no-access' | 'empty' | 'private-on-public' | 'fetch-failed' | 'limit'

export interface RelatedCandidate {
  declared: DeclaredRepository
  info: RepositoryInfo
}

export interface SkippedRepository {
  repo: string
  origin: string
  reason: SkipReason
  message?: string
}

export interface SelectOptions {
  reviewed: string
  pullRequestPrivate: boolean
  privateOnPublic: boolean
}

const STATE_RANK: Readonly<Record<RelatedState, number>> = {
  consumers: 0,
  uses: 0,
  linked: 1,
  unlinked: 2,
}

export function selectCandidates(
  declared: readonly DeclaredRepository[],
  infos: ReadonlyMap<string, RepositoryInfo | 'no-access'>,
  options: SelectOptions,
): { candidates: RelatedCandidate[]; skipped: SkippedRepository[] } {
  const candidates: RelatedCandidate[] = []
  const skipped: SkippedRepository[] = []
  const skip = (item: DeclaredRepository, reason: SkipReason) =>
    skipped.push({ repo: item.repo, origin: item.origin, reason })
  for (const item of declared) {
    if (item.repo.toLowerCase() === options.reviewed.toLowerCase()) {
      skip(item, 'reviewed-repository')
      continue
    }
    const info = infos.get(item.repo) ?? 'no-access'
    if (info === 'no-access') skip(item, 'no-access')
    else if (info.empty || info.defaultBranch === undefined) skip(item, 'empty')
    else if (info.private && !options.pullRequestPrivate && !options.privateOnPublic) {
      skip(item, 'private-on-public')
    } else if (candidates.length >= MAX_RELATED_CANDIDATES) skip(item, 'limit')
    else candidates.push({ declared: item, info })
  }
  return { candidates, skipped }
}

export function rankRelated<T extends { state: RelatedState; order: number }>(
  items: readonly T[],
): T[] {
  return [...items]
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.order - b.order)
    .slice(0, MAX_RELATED)
}
