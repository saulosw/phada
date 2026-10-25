export interface GhPullData {
  repo: string
  number: number
  url: string
  title: string
  body: string
  author: string
  baseRef: string
  headRef: string
  mergeBase: string
  headSha: string
  diff: string
  viewer: string
  checks?: GhCheck[]
}

export interface GhCheck {
  name: string
  state: string
  link: string
  description: string
  workflow: string
  startedAt?: string
  completedAt?: string
}

export type ReadGitHub = (
  path: string,
  query?: Readonly<Record<string, string>>,
) => Promise<unknown>

export interface GhAnswer {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GhCommandInput {
  stdin?: string
  files: Readonly<Record<string, string>>
}

export type FieldValue =
  string | number | boolean | null | FieldValue[] | { [key: string]: FieldValue }

interface Listing {
  repo?: string
  json?: string[]
  jq?: string
}

export type GhCommand =
  | ({ kind: 'pr-view'; target?: string; comments: boolean } & Listing)
  | { kind: 'pr-diff'; target?: string; repo?: string; nameOnly: boolean }
  | ({ kind: 'pr-checks'; target?: string; watch: boolean } & Listing)
  | ({
      kind: 'pr-list'
      state?: string
      search?: string
      limit?: number
      filters?: string[]
    } & Listing)
  | { kind: 'pr-comment'; target?: string; repo?: string; body: string }
  | {
      kind: 'pr-review'
      target?: string
      repo?: string
      event: 'comment' | 'approve' | 'request-changes'
      body: string
    }
  | ({ kind: 'issue-view'; target: string; comments: boolean } & Listing)
  | ({
      kind: 'issue-list'
      state?: string
      search?: string
      limit?: number
      filters?: string[]
    } & Listing)
  | ({ kind: 'search'; type: 'prs' | 'issues'; query: string; limit?: number } & Listing)
  | ({ kind: 'repo-view'; target?: string } & Listing)
  | {
      kind: 'api'
      method: string
      path: string
      fields?: Record<string, FieldValue>
      input?: FieldValue
      paginate: boolean
      jq?: string
    }
  | { kind: 'auth-status' }
  | { kind: 'unsupported'; sub: string }

export class GhFacadeError extends Error {
  override readonly name = 'GhFacadeError'
}
