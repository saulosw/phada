import { GitHubAuthError, GitHubError } from './errors.js'
import { booleanField, field, numberField, stringField } from './json-fields.js'
import { ACCEPT_JSON, ensureOk, readJson, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'
import type { RepositoryFilesOptions } from './repository-files.js'

const DEFAULT_TIMEOUT_MS = 30_000

export interface RepositoryInfo {
  repo: string
  private: boolean
  defaultBranch?: string
  archived: boolean
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
  const defaultBranch = field(json, 'default_branch')
  const size = numberField(json, 'size')
  return {
    repo: stringField(json, 'full_name'),
    private: booleanField(json, 'private'),
    ...(typeof defaultBranch === 'string' && defaultBranch !== '' ? { defaultBranch } : {}),
    archived: booleanField(json, 'archived'),
    empty: size === 0 || typeof defaultBranch !== 'string' || defaultBranch === '',
  }
}
