import { listCommentPages } from './issue-comments.js'
import { field, numberField, stringField } from './json-fields.js'
import type { RepositoryFilesOptions } from './repository-files.js'

const PULL_NUMBER = /\/pulls\/(\d+)$/

export interface ReviewComment {
  id: number
  inReplyTo?: number
  number: number
  author: string
  authorIsBot: boolean
  association: string
  createdAt: string
}

export type ReviewCommentListing =
  { status: 'not-modified' } | { status: 'ok'; etag?: string; comments: ReviewComment[] }

export async function listReviewComments(
  options: RepositoryFilesOptions & { since: string; etag?: string },
): Promise<ReviewCommentListing> {
  const listed = await listCommentPages(options, 'pulls/comments', toReviewComment)
  if (listed.status === 'not-modified') return listed
  return {
    status: 'ok',
    ...(listed.etag === undefined ? {} : { etag: listed.etag }),
    comments: listed.items,
  }
}

function toReviewComment(json: unknown): ReviewComment {
  const author = stringField(json, 'user.login')
  const inReplyTo = field(json, 'in_reply_to_id')
  return {
    id: numberField(json, 'id'),
    ...(typeof inReplyTo === 'number' ? { inReplyTo } : {}),
    number: Number(PULL_NUMBER.exec(stringField(json, 'pull_request_url'))?.[1] ?? 0),
    author,
    authorIsBot: field(json, 'user.type') === 'Bot' || author.endsWith('[bot]'),
    association: stringField(json, 'author_association'),
    createdAt: stringField(json, 'created_at'),
  }
}
