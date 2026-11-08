import type { PullRequest } from '../github/pull-request.js'
import type { LocalCommitMessage } from '../repository/local-git.js'
import type { LocalRun } from './local-review.js'
import { localRunName } from './run-target.js'

export type LocalChanges = LocalRun & {
  private: boolean
  messages: readonly LocalCommitMessage[]
  stats: PullRequest['stats']
  diff: string
}

const UNCOMMITTED_LINE = 'This review includes uncommitted changes.'

export function localPullRequest(changes: LocalChanges): PullRequest {
  return {
    repo: changes.repo,
    number: 0,
    url: '',
    title: titleOf(changes),
    description: descriptionOf(changes),
    author: '',
    association: 'OWNER',
    state: 'open',
    draft: false,
    baseRef: changes.baseRef,
    baseSha: changes.base,
    headRef: changes.branch ?? 'HEAD',
    headSha: changes.reviewed,
    fromFork: false,
    private: changes.private,
    stats: changes.stats,
    diff: changes.diff,
  }
}

function titleOf(changes: LocalChanges): string {
  const [only, ...others] = changes.messages
  const name = localRunName(changes.branch, changes.head)
  if (only !== undefined && others.length === 0) return only.subject
  if (only === undefined && changes.dirty) return `Uncommitted changes on ${name}`
  return name
}

function descriptionOf(changes: LocalChanges): string {
  const messages = changes.messages.map(({ subject, body }) =>
    body === '' ? subject : `${subject}\n\n${body}`,
  )
  return [...messages, ...(changes.dirty ? [UNCOMMITTED_LINE] : [])].join('\n\n')
}
