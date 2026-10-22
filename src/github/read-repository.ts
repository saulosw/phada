import { GitHubRequestError } from './errors.js'
import { ACCEPT_JSON, API_ORIGIN, ensureOk, readJson, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000
const SEARCH_PATH = 'search/issues'
const SCOPE_QUALIFIER = /^-?(?:repo|org|user|owner):(.*)$/i

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
  const inRepository = (path: string) => {
    const lower = path.toLowerCase()
    return lower === SEARCH_PATH || lower === prefix || lower.startsWith(`${prefix}/`)
  }
  return async (path, query) => {
    const plain =
      !/[%\\]/.test(path) &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    const resolved = new URL(`${API_ORIGIN}/${path}`).pathname.slice(1)
    if (!plain || !inRepository(path) || !inRepository(resolved)) {
      throw new GitHubRequestError(`Only ${options.repo} can be read during this review.`)
    }
    if (path.toLowerCase() === SEARCH_PATH && !searchesOnly(query?.q ?? '', options.repo)) {
      throw new GitHubRequestError(`Only ${options.repo} can be searched during this review.`)
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

function searchesOnly(query: string, repo: string): boolean {
  const scopes = query
    .split(/\s+/)
    .map((word) => SCOPE_QUALIFIER.exec(word))
    .filter((match) => match !== null)
  return (
    scopes.length > 0 &&
    scopes.every((match) => match[0].toLowerCase() === `repo:${repo.toLowerCase()}`)
  )
}
