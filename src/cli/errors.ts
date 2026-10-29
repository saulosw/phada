export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export class MissingGitHubTokenError extends Error {
  override readonly name = 'MissingGitHubTokenError'

  constructor(
    need = 'read the pull request and write reviews (read-only is enough with --dry-run)',
  ) {
    super(
      `No GitHub token found. Log in with gh auth login, or set GITHUB_TOKEN (or GH_TOKEN) to a token that can ${need}.`,
    )
  }
}

export class WatchRunningError extends Error {
  override readonly name = 'WatchRunningError'
}

export class RunNotFoundError extends Error {
  override readonly name = 'RunNotFoundError'

  constructor(id: number) {
    super(`No run ${id} in the history.`)
  }
}

export const NOTHING_TO_WATCH =
  'Nothing to watch: list the repositories under watch: in your own config, e.g. watch: { repos: [owner/repo] } in ~/.config/phada/config.yml.'
