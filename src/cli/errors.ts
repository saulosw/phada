export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export class MissingGitHubTokenError extends Error {
  override readonly name = 'MissingGitHubTokenError'

  constructor() {
    super(
      'No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN) to a token that can read the pull request, e.g. export GITHUB_TOKEN=$(gh auth token)',
    )
  }
}
