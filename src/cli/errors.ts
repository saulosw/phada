export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export class MissingGitHubTokenError extends Error {
  override readonly name = 'MissingGitHubTokenError'

  constructor() {
    super(
      'No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN) to a token that can read the pull request and write reviews (read-only is enough with --dry-run), e.g. export GITHUB_TOKEN=$(gh auth token)',
    )
  }
}
