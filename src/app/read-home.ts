export type GitHubTokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh'

export type GitHubAccount =
  { state: 'found'; login: string } | { state: 'refused' } | { state: 'failed'; error: string }

export type GitHubAccess = { source: null } | { source: GitHubTokenSource; account: GitHubAccount }
