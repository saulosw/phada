import { field, numberField, stringField } from './json-fields.js'
import { MAX_PULL_PAGES, readPullPage } from './list-pull-requests.js'
import type { RepositoryFilesOptions } from './repository-files.js'
import { ACCEPT_JSON, nextPagePath, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_LIMIT = 50

export type ListClosedPullRequestsOptions = RepositoryFilesOptions & {
  since: string
  limit?: number
}

interface ClosedPull {
  number: number
  closedAt: string
}

export async function listClosedPullRequests(
  options: ListClosedPullRequestsOptions,
): Promise<number[]> {
  const name = `${options.owner}/${options.repo}`
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const since = Date.parse(options.since)
  const limit = options.limit ?? DEFAULT_LIMIT
  let path: string | undefined =
    `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=100`
  const closed: ClosedPull[] = []
  for (let page = 0; path !== undefined && page < MAX_PULL_PAGES; page++) {
    const response = await sendGitHubRequest(ctx, path, ACCEPT_JSON)
    const items = await readPullPage(response, ctx, name)
    for (const item of items) {
      const closedAt = field(item, 'closed_at')
      if (typeof closedAt === 'string' && Date.parse(closedAt) >= since) {
        closed.push({ number: numberField(item, 'number'), closedAt })
      }
    }
    const older = items.every((item) => Date.parse(stringField(item, 'updated_at')) < since)
    if (older) break
    path = nextPagePath(response.headers.get('link'))
  }
  return closed
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, limit)
    .map(({ number }) => number)
}
