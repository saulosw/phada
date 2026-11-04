import { GhFacadeError } from '../gh-facade/types.js'
import type { ReadGitHub } from '../gh-facade/types.js'

export function replayReads(read: ReadGitHub, pullRequest: { repo: string }): ReadGitHub {
  const repo = pullRequest.repo.toLowerCase()
  const ownRepo = (path: string) => {
    const lower = path.replace(/^\/+/, '').toLowerCase()
    return lower === `repos/${repo}` || lower.startsWith(`repos/${repo}/`)
  }
  const ownSearch = (path: string, query: Readonly<Record<string, string>> | undefined) =>
    path.replace(/^\/+/, '').toLowerCase().startsWith('search/') &&
    (query?.q ?? '').toLowerCase().split(/\s+/).includes(`repo:${repo}`)
  return (path, query) => {
    if (ownRepo(path) || ownSearch(path, query)) {
      return Promise.reject(
        new GhFacadeError(
          `phada: this review replays an earlier commit of the pull request, so ${pullRequest.repo} is not read from GitHub, which shows it as it is today. Read the checkout, gh pr view, gh pr diff and gh pr checks.`,
        ),
      )
    }
    return read(path, query)
  }
}
