export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export class MissingGitHubTokenError extends Error {
  override readonly name = 'MissingGitHubTokenError'

  constructor() {
    super('GITHUB_TOKEN is not set. Run: export GITHUB_TOKEN=$(gh auth token)')
  }
}
