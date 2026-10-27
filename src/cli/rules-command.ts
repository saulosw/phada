import { readRules } from '../app/read-rules.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadUserLayers } from '../config/user-config.js'
import { GitHubError } from '../github/errors.js'
import type { FetchPullRequestOptions, PullRequest } from '../github/pull-request.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { IndexFormat, RulesTarget } from './args.js'
import { contextSourcesAt } from './context-sources.js'
import type { ContextReaders } from './context-sources.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { formatRulesJson, formatRulesText } from './format-rules.js'
import type { RulesView } from './format-rules.js'
import type { TextOutput } from './progress.js'

export interface RulesCommand {
  target: RulesTarget
  format: IndexFormat
}

export interface RulesCommandDeps extends ContextReaders, GitHubTokenDeps {
  files: LocalFileSystem
  stdout: TextOutput
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  fetchRepository: (options: RepositoryFilesOptions) => Promise<RepositoryInfo>
}

export async function runRules(command: RulesCommand, deps: RulesCommandDeps): Promise<void> {
  const token = await requireGitHubToken(deps, 'read the repository contents')
  const { owner, repo } = command.target.kind === 'pull' ? command.target.ref : command.target.repo
  const userLayers = await loadUserLayers({
    env: deps.env,
    home: deps.home,
    owner,
    repo,
    files: deps.files,
  })
  const repository = { owner, repo, token }
  const rules = await readRules({
    target:
      command.target.kind === 'pull'
        ? { kind: 'pull-request', number: command.target.ref.number }
        : { kind: 'default-branch' },
    userLayers,
    readers: {
      fetchPullRequest: (number) => deps.fetchPullRequest({ owner, repo, number, token }),
      fetchRepository: () => deps.fetchRepository(repository),
      sourcesAt: (ref) => contextSourcesAt(deps, repository, ref),
    },
  })
  if (rules.status === 'empty') {
    throw new GitHubError(`${owner}/${repo} is empty: there is no branch to read.`)
  }
  const { target, report, ignore } = rules
  const view: RulesView =
    target.kind === 'pull-request'
      ? {
          pullRequest: { owner, repo, number: target.number, baseSha: target.baseSha },
          repository: { owner, repo, ref: target.baseSha },
        }
      : { pullRequest: null, repository: { owner, repo, ref: target.ref } }
  const shownIgnore = target.kind === 'pull-request' ? undefined : ignore
  deps.stdout.write(
    command.format === 'json'
      ? formatRulesJson(view, report, shownIgnore)
      : formatRulesText(view, report, shownIgnore),
  )
}
