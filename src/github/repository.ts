import { GitHubAuthError, GitHubError } from './errors.js'
import { booleanField, field, stringField } from './json-fields.js'
import {
  ACCEPT_JSON,
  ACCEPT_SHA,
  ensureOk,
  readJson,
  readText,
  sendGitHubRequest,
} from './request.js'
import type { GitHubRequestContext } from './request.js'
import type { RepositoryFilesOptions } from './repository-files.js'

const DEFAULT_TIMEOUT_MS = 30_000

export interface RepositoryInfo {
  repo: string
  private: boolean
  defaultBranch?: string
  empty: boolean
}

export class RepositoryAccessError extends GitHubError {
  override readonly name = 'RepositoryAccessError'
  readonly repo: string

  constructor(repo: string, status: number) {
    super(`Cannot read ${repo} with this token (HTTP ${status})`)
    this.repo = repo
  }
}

export async function fetchRepository(options: RepositoryFilesOptions): Promise<RepositoryInfo> {
  const name = `${options.owner}/${options.repo}`
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const response = await sendGitHubRequest(
    ctx,
    `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`,
    ACCEPT_JSON,
  )
  if (response.status === 404) throw new RepositoryAccessError(name, 404)
  try {
    await ensureOk(response, ctx)
  } catch (error) {
    if (error instanceof GitHubAuthError && error.status === 403) {
      throw new RepositoryAccessError(name, 403)
    }
    throw error
  }
  const json = await readJson(response, ctx)
  const branch = field(json, 'default_branch')
  const defaultBranch = typeof branch === 'string' && branch !== '' ? branch : undefined
  return {
    repo: stringField(json, 'full_name'),
    private: booleanField(json, 'private'),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    empty: defaultBranch === undefined,
  }
}

export type BranchHead = { status: 'not-modified' } | { status: 'ok'; sha: string; etag?: string }

export async function fetchBranchHead(
  options: RepositoryFilesOptions & { branch: string; etag?: string },
): Promise<BranchHead> {
  const name = `${options.owner}/${options.repo}`
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const response = await sendGitHubRequest(
    ctx,
    `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/commits/${encodeURIComponent(options.branch)}`,
    ACCEPT_SHA,
    options.etag === undefined ? {} : { ifNoneMatch: options.etag },
  )
  if (response.status === 304) return { status: 'not-modified' }
  if (response.status === 404) throw new RepositoryAccessError(name, 404)
  await ensureOk(response, ctx)
  const sha = (await readText(response, ctx)).trim()
  const etag = response.headers.get('etag')
  return { status: 'ok', sha, ...(etag === null ? {} : { etag }) }
}
