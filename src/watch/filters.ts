import type { WatchedRepoSettings } from '../config/watch-settings.js'
import type { OpenPull } from '../github/list-pull-requests.js'

export type IneligibleReason = 'draft' | 'bot' | 'external' | 'author' | 'label' | 'base'

export type Eligibility = { eligible: true } | { eligible: false; reason: IneligibleReason }

export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
])

export function eligibility(pull: OpenPull, repo: WatchedRepoSettings): Eligibility {
  const reason = ineligibleReason(pull, repo)
  return reason === undefined ? { eligible: true } : { eligible: false, reason }
}

function ineligibleReason(pull: OpenPull, repo: WatchedRepoSettings): IneligibleReason | undefined {
  if (pull.draft) return 'draft'
  if (pull.authorIsBot) return 'bot'
  if (!pull.private && !repo.allowExternal && !TRUSTED_ASSOCIATIONS.has(pull.association))
    return 'external'
  if (repo.authors !== undefined && !includesIgnoringCase(repo.authors, [pull.author])) {
    return 'author'
  }
  if (repo.labels !== undefined && !includesIgnoringCase(repo.labels, pull.labels)) return 'label'
  if (repo.baseBranches !== undefined && !repo.baseBranches.includes(pull.baseRef)) return 'base'
  return undefined
}

function includesIgnoringCase(allowed: readonly string[], values: readonly string[]): boolean {
  const wanted = new Set(allowed.map((value) => value.toLowerCase()))
  return values.some((value) => wanted.has(value.toLowerCase()))
}
