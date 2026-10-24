import { field, numberField, stringField } from './json-fields.js'
import { RepositoryAccessError } from './repository.js'
import type { RepositoryFilesOptions } from './repository-files.js'
import { ACCEPT_JSON, API_ORIGIN, ensureOk, readJson, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_COMMENT_PAGES = 5
const NEXT_LINK = /<([^>]+)>;\s*rel="next"/
const ISSUE_NUMBER = /\/issues\/(\d+)$/

export interface IssueComment {
  id: number
  body: string
  author: string
  authorIsBot: boolean
  association: string
  createdAt: string
  url: string
  number: number
  pullRequest: boolean
}

export type CommentListing =
  { status: 'not-modified' } | { status: 'ok'; etag?: string; comments: IssueComment[] }

export async function listIssueComments(
  options: RepositoryFilesOptions & { since: string; etag?: string },
): Promise<CommentListing> {
  const ctx = context(options)
  const query = new URLSearchParams({
    since: options.since,
    sort: 'created',
    direction: 'asc',
    per_page: '100',
  })
  let path: string | undefined = `${repoPath(options)}/issues/comments?${query.toString()}`
  const comments: IssueComment[] = []
  let etag: string | undefined
  for (let page = 0; path !== undefined && page < MAX_COMMENT_PAGES; page++) {
    const response = await sendGitHubRequest(
      ctx,
      path,
      ACCEPT_JSON,
      page === 0 && options.etag !== undefined ? { ifNoneMatch: options.etag } : {},
    )
    if (page === 0 && response.status === 304) return { status: 'not-modified' }
    await ensureOk(response, ctx)
    if (page === 0) etag = response.headers.get('etag') ?? undefined
    const items = await readJson(response, ctx)
    if (!Array.isArray(items)) {
      throw new RepositoryAccessError(`${options.owner}/${options.repo}`, response.status)
    }
    comments.push(...items.map(toComment))
    path = nextPath(response.headers.get('link'))
  }
  return { status: 'ok', ...(etag === undefined ? {} : { etag }), comments }
}

export async function addCommentReaction(
  options: RepositoryFilesOptions & { commentId: number },
): Promise<void> {
  const ctx = context(options)
  const response = await sendGitHubRequest(
    ctx,
    `${repoPath(options)}/issues/comments/${options.commentId}/reactions`,
    ACCEPT_JSON,
    { method: 'POST', body: JSON.stringify({ content: 'eyes' }) },
  )
  await ensureOk(response, ctx)
}

function toComment(json: unknown): IssueComment {
  const author = stringField(json, 'user.login')
  const url = stringField(json, 'html_url')
  return {
    id: numberField(json, 'id'),
    body: typeof field(json, 'body') === 'string' ? stringField(json, 'body') : '',
    author,
    authorIsBot: field(json, 'user.type') === 'Bot' || author.endsWith('[bot]'),
    association: stringField(json, 'author_association'),
    createdAt: stringField(json, 'created_at'),
    url,
    number: Number(ISSUE_NUMBER.exec(stringField(json, 'issue_url'))?.[1] ?? 0),
    pullRequest: url.includes('/pull/'),
  }
}

function context(options: RepositoryFilesOptions): GitHubRequestContext {
  return {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

function repoPath(options: { owner: string; repo: string }): string {
  return `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`
}

function nextPath(link: string | null): string | undefined {
  const url = link === null ? undefined : NEXT_LINK.exec(link)?.[1]
  if (url === undefined || !url.startsWith(`${API_ORIGIN}/`)) return undefined
  return url.slice(API_ORIGIN.length)
}
