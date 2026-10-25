import { localRules, readRules } from '../app/read-rules.js'
import type { BranchRules, LocalRules, PullRequestRules } from '../app/read-rules.js'
import type { ConfigLayer } from '../config/types.js'
import { loadUserLayers } from '../config/user-config.js'
import type { ContextSources } from '../context/types.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import type { RepositoryInfo } from '../github/repository.js'
import { contextSourcesAt } from './context-sources.js'
import { readGitHubToken } from './github-token.js'
import { pullRequestPrompt } from './prompt-command.js'
import type { PromptReaderDeps } from './prompt-command.js'

export interface RulesReaderDeps extends PromptReaderDeps {
  fetchRepository: (options: RepositoryFilesOptions) => Promise<RepositoryInfo>
}

export interface RulesReaders {
  readLocalRules(repo: string): Promise<LocalRules>
  readRepositoryRules(repo: string): Promise<BranchRules>
  readPullRequestRules(repo: string, number: number): Promise<PullRequestRules>
}

export function rulesReaders(deps: RulesReaderDeps): RulesReaders {
  return {
    readLocalRules: async (repo) => localRules(await userLayersOf(deps, repo)),
    readRepositoryRules: async (repo) => {
      const token = await readGitHubToken(deps)
      if (token === undefined) return { status: 'no-token' }
      const repository = { ...ownerAndName(repo), token }
      return readRules({
        target: { kind: 'default-branch' },
        userLayers: await userLayersOf(deps, repo),
        readers: {
          fetchPullRequest: (number) => deps.fetchPullRequest({ ...repository, number }),
          fetchRepository: () => deps.fetchRepository(repository),
          sourcesAt: (ref) => contextSourcesAt(deps, repository, ref),
        },
      })
    },
    readPullRequestRules: async (repo, number) => {
      const token = await readGitHubToken(deps)
      if (token === undefined) return { status: 'no-token' }
      const repository = { ...ownerAndName(repo), token }
      const userLayers = await userLayersOf(deps, repo)
      const pullRequest = await deps.fetchPullRequest({ ...repository, number })
      const sources = sharedSources(contextSourcesAt(deps, repository, pullRequest.baseSha))
      const [rules, prompt] = await Promise.all([
        readRules({
          target: { kind: 'pull-request', number },
          userLayers,
          readers: {
            fetchPullRequest: async () => pullRequest,
            fetchRepository: () => deps.fetchRepository(repository),
            sourcesAt: () => sources,
          },
        }),
        pullRequestPrompt(deps, {
          target: { ...repository, number },
          userLayers,
          pullRequest,
          sources,
        }),
      ])
      return { status: 'read', rules, prompt }
    },
  }
}

function ownerAndName(repo: string): { owner: string; repo: string } {
  const [owner = '', name = ''] = repo.split('/')
  return { owner, repo: name }
}

function userLayersOf(deps: RulesReaderDeps, repo: string): Promise<ConfigLayer[]> {
  return loadUserLayers({
    env: deps.env,
    home: deps.home,
    files: deps.files,
    ...ownerAndName(repo),
  })
}

function sharedSources(sources: ContextSources): ContextSources {
  let tree: ReturnType<ContextSources['readTree']> | undefined
  const files = new Map<string, Promise<string | null>>()
  return {
    ...sources,
    readTree: () => (tree ??= sources.readTree()),
    readRepoFile: (path) => {
      const read = files.get(path) ?? sources.readRepoFile(path)
      files.set(path, read)
      return read
    },
  }
}
