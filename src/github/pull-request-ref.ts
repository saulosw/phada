import { InvalidPullRequestRefError } from './errors.js'

export interface PullRequestRef {
  owner: string
  repo: string
  number: number
}

const NAME = '[A-Za-z0-9_.-]+'
const NUMBER = '[1-9]\\d*'
const SHORT_REF = new RegExp(`^(${NAME})/(${NAME})#(${NUMBER})$`)
const URL_REF = new RegExp(
  `^https://(?:www\\.)?github\\.com/(${NAME})/(${NAME})/pull/(${NUMBER})(?:/[^?#]*)?(?:[?#].*)?$`,
)

/** Parses "owner/repo#123" or a GitHub pull request URL. */
export function parsePullRequestRef(input: string): PullRequestRef {
  const trimmed = input.trim()
  const [, owner, repo, digits] = SHORT_REF.exec(trimmed) ?? URL_REF.exec(trimmed) ?? []
  const number = Number(digits)

  if (
    owner === undefined ||
    repo === undefined ||
    isDotSegment(owner) ||
    isDotSegment(repo) ||
    !Number.isSafeInteger(number)
  ) {
    throw new InvalidPullRequestRefError(input)
  }
  return { owner, repo, number }
}

export function formatPullRequestRef(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

// "." and ".." would turn into path traversal inside the API URL.
function isDotSegment(name: string): boolean {
  return name === '.' || name === '..'
}
