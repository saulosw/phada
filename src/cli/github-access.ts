import { errorMessage } from '../app/error-message.js'
import type { GitHubAccess } from '../app/read-home.js'
import { GitHubAuthError } from '../github/errors.js'
import type { FetchUserOptions, GitHubUser } from '../github/user.js'
import { findGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'

export interface GitHubAccessDeps extends GitHubTokenDeps {
  fetchUser(options: FetchUserOptions): Promise<GitHubUser>
}

export async function readGitHubAccess(deps: GitHubAccessDeps): Promise<GitHubAccess> {
  const found = await findGitHubToken(deps)
  if (found === undefined) return { source: null }
  try {
    const { login } = await deps.fetchUser({ token: found.token })
    return { source: found.source, account: { state: 'found', login } }
  } catch (error) {
    if (error instanceof GitHubAuthError && error.status === 401) {
      return { source: found.source, account: { state: 'refused' } }
    }
    return { source: found.source, account: { state: 'failed', error: errorMessage(error) } }
  }
}
