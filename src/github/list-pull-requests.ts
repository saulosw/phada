import { arrayField, booleanField, field, numberField, stringField } from './json-fields.js'
import { RepositoryAccessError } from './repository.js'
import type { RepositoryFilesOptions } from './repository-files.js'
import { ACCEPT_JSON, API_ORIGIN, ensureOk, readJson, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'
import { GitHubAuthError } from './errors.js'

const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_PULL_PAGES = 10
const NEXT_LINK = /<([^>]+)>;\s*rel="next"/

export interface OpenPull {
  number: number
  headSha: string
  title?: string
  draft: boolean
  author: string
  authorIsBot: boolean
  association: string
  labels: string[]
  baseRef: string
  private: boolean
}

export type PullListing =
  { status: 'not-modified' } | { status: 'ok'; etag?: string; pulls: OpenPull[] }

export async function listOpenPullRequests(
  options: RepositoryFilesOptions & { etag?: string },
): Promise<PullListing> {
  const name = `${options.owner}/${options.repo}`
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  let path: string | undefined =
    `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/pulls?state=open&sort=updated&direction=desc&per_page=100`
  const pulls: OpenPull[] = []
  let etag: string | undefined
  for (let page = 0; path !== undefined && page < MAX_PULL_PAGES; page++) {
    const response = await sendGitHubRequest(
      ctx,
      path,
      ACCEPT_JSON,
      page === 0 && options.etag !== undefined ? { ifNoneMatch: options.etag } : {},
    )
    if (page === 0 && response.status === 304) return { status: 'not-modified' }
    if (response.status === 404) throw new RepositoryAccessError(name, 404)
    try {
      await ensureOk(response, ctx)
    } catch (error) {
      if (error instanceof GitHubAuthError && error.status === 403) {
        throw new RepositoryAccessError(name, 403)
      }
      throw error
    }
    if (page === 0) etag = response.headers.get('etag') ?? undefined
    const items = await readJson(response, ctx)
    if (!Array.isArray(items)) throw new RepositoryAccessError(name, response.status)
    pulls.push(...items.map(toOpenPull))
    path = nextPath(response.headers.get('link'))
  }
  return { status: 'ok', ...(etag === undefined ? {} : { etag }), pulls }
}

function toOpenPull(json: unknown): OpenPull {
  const author = stringField(json, 'user.login')
  return {
    number: numberField(json, 'number'),
    headSha: stringField(json, 'head.sha'),
    ...(typeof field(json, 'title') === 'string' ? { title: stringField(json, 'title') } : {}),
    draft: field(json, 'draft') === true,
    author,
    authorIsBot: field(json, 'user.type') === 'Bot' || author.endsWith('[bot]'),
    association: stringField(json, 'author_association'),
    labels: arrayField(json, 'labels').map((label) => stringField(label, 'name')),
    baseRef: stringField(json, 'base.ref'),
    private: booleanField(json, 'base.repo.private'),
  }
}

function nextPath(link: string | null): string | undefined {
  const url = link === null ? undefined : NEXT_LINK.exec(link)?.[1]
  if (url === undefined || !url.startsWith(`${API_ORIGIN}/`)) return undefined
  return url.slice(API_ORIGIN.length)
}
