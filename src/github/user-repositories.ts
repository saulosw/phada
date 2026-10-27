import {
  booleanField,
  field,
  invalidPayload,
  nullableStringField,
  stringField,
} from './json-fields.js'
import {
  ACCEPT_JSON,
  ensureReadable,
  nextPagePath,
  readJson,
  sendGitHubRequest,
} from './request.js'
import type { GitHubRequestContext, ReadPermission } from './request.js'
import type { FetchUserOptions } from './user.js'

const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_REPO_PAGES = 10
const FIRST_PAGE =
  '/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100'
const REPOSITORIES: ReadPermission = {
  what: 'the repositories of the token owner',
  permission: 'metadata:read',
}

export interface UserRepository {
  name: string
  private: boolean
  fork: boolean
  pushedAt: string | null
}

export async function listUserRepositories(options: FetchUserOptions): Promise<UserRepository[]> {
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  let path: string | undefined = FIRST_PAGE
  const repositories: UserRepository[] = []
  for (let page = 0; path !== undefined && page < MAX_REPO_PAGES; page++) {
    const response = await sendGitHubRequest(ctx, path, ACCEPT_JSON)
    await ensureReadable(response, ctx, REPOSITORIES)
    const items = await readJson(response, ctx)
    if (!Array.isArray(items)) throw invalidPayload('repositories')
    repositories.push(...items.filter((item) => field(item, 'archived') !== true).map(toRepository))
    path = nextPagePath(response.headers.get('link'))
  }
  return repositories
}

function toRepository(json: unknown): UserRepository {
  return {
    name: stringField(json, 'full_name'),
    private: booleanField(json, 'private'),
    fork: booleanField(json, 'fork'),
    pushedAt: nullableStringField(json, 'pushed_at'),
  }
}
