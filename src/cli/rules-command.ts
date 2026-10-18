import { inspectPullRequestContext, inspectRepositoryContext } from '../app/inspect-context.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadUserLayers } from '../config/user-config.js'
import { GitHubError } from '../github/errors.js'
import type { FetchPullRequestOptions, PullRequest } from '../github/pull-request.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { ContextSources } from '../context/types.js'
import type { IndexFormat, RulesTarget } from './args.js'
import { contextSourcesAt } from './context-sources.js'
import type { ContextReaders } from './context-sources.js'
import { MissingGitHubTokenError } from './errors.js'
import { formatRulesJson, formatRulesText } from './format-rules.js'
import type { RulesView } from './format-rules.js'
import type { TextOutput } from './progress.js'

export interface RulesCommand {
  target: RulesTarget
  format: IndexFormat
}

export interface RulesCommandDeps extends ContextReaders {
  env: NodeJS.ProcessEnv
  files: LocalFileSystem
  stdout: TextOutput
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  fetchRepository: (options: RepositoryFilesOptions) => Promise<RepositoryInfo>
}

export async function runRules(command: RulesCommand, deps: RulesCommandDeps): Promise<void> {
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
  if (!token) throw new MissingGitHubTokenError('read the repository contents')
  const { owner, repo } = command.target.kind === 'pull' ? command.target.ref : command.target.repo
  const userLayers = await loadUserLayers({
    env: deps.env,
    home: deps.home,
    owner,
    repo,
    files: deps.files,
  })
  const repository = { owner, repo, token }

  if (command.target.kind === 'pull') {
    const pullRequest = await deps.fetchPullRequest({ ...command.target.ref, token })
    const report = await inspectPullRequestContext({
      diff: pullRequest.diff,
      baseSha: pullRequest.baseSha,
      userLayers,
      sources: await readableSources(contextSourcesAt(deps, repository, pullRequest.baseSha)),
    })
    const view: RulesView = {
      pullRequest: { owner, repo, number: command.target.ref.number, baseSha: pullRequest.baseSha },
      repository: { owner, repo, ref: pullRequest.baseSha },
    }
    deps.stdout.write(
      command.format === 'json' ? formatRulesJson(view, report) : formatRulesText(view, report),
    )
    return
  }

  const info = await deps.fetchRepository(repository)
  if (info.empty || info.defaultBranch === undefined) {
    throw new GitHubError(`${owner}/${repo} is empty: there is no branch to read.`)
  }
  const ref = info.defaultBranch
  const { report, ignore } = await inspectRepositoryContext({
    ref,
    userLayers,
    sources: await readableSources(contextSourcesAt(deps, repository, ref)),
  })
  const view: RulesView = { pullRequest: null, repository: { owner, repo, ref } }
  deps.stdout.write(
    command.format === 'json'
      ? formatRulesJson(view, report, ignore)
      : formatRulesText(view, report, ignore),
  )
}

async function readableSources(sources: ContextSources): Promise<ContextSources> {
  const tree = await sources.readTree()
  return { ...sources, readTree: async () => tree }
}
