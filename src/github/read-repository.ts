import { GitHubRequestError } from './errors.js'
import { ACCEPT_JSON, ensureOk, readJson, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000

export interface RepositoryReaderOptions {
  repo: string
  token: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export function repositoryReader(
  options: RepositoryReaderOptions,
): (path: string, query?: Readonly<Record<string, string>>) => Promise<unknown> {
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const prefix = `repos/${options.repo}`.toLowerCase()
  return async (path, query) => {
    const lower = path.toLowerCase()
    const allowed =
      !path.split('/').includes('..') &&
      (lower === 'search/issues' || lower === prefix || lower.startsWith(`${prefix}/`))
    if (!allowed) {
      throw new GitHubRequestError(`Only ${options.repo} can be read during this review.`)
    }
    const search = query === undefined ? '' : new URLSearchParams(query).toString()
    const response = await sendGitHubRequest(
      ctx,
      `/${path}${search === '' ? '' : `?${search}`}`,
      ACCEPT_JSON,
    )
    await ensureOk(response, ctx)
    return readJson(response, ctx)
  }
}
