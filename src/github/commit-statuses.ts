import { arrayField, field, numberField, stringField } from './json-fields.js'
import type { RepositoryFilesOptions } from './repository-files.js'
import {
  ACCEPT_JSON,
  ensureReadable,
  nextPagePath,
  readJson,
  sendGitHubRequest,
} from './request.js'
import type { GitHubRequestContext, ReadPermission } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_PAGES = 10
const STATUSES: ReadPermission = { what: 'the commit statuses', permission: 'statuses:read' }

export interface CommitStatus {
  context: string
  state: string
  description: string | null
  url: string | null
}

export async function fetchCommitStatuses(
  options: RepositoryFilesOptions & { sha: string },
): Promise<CommitStatus[]> {
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const repo = `${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`
  let path: string | undefined =
    `/repos/${repo}/commits/${encodeURIComponent(options.sha)}/status?per_page=100`
  const statuses: CommitStatus[] = []
  for (let page = 0; path !== undefined && page < MAX_PAGES; page++) {
    const response = await sendGitHubRequest(ctx, path, ACCEPT_JSON)
    await ensureReadable(response, ctx, STATUSES)
    const json = await readJson(response, ctx)
    if (numberField(json, 'total_count') === 0) return []
    statuses.push(...arrayField(json, 'statuses').map(toStatus))
    path = nextPagePath(response.headers.get('link'))
  }
  return statuses
}

function toStatus(json: unknown): CommitStatus {
  const description = field(json, 'description')
  const url = field(json, 'target_url')
  return {
    context: stringField(json, 'context'),
    state: stringField(json, 'state'),
    description: typeof description === 'string' ? description : null,
    url: typeof url === 'string' ? url : null,
  }
}
