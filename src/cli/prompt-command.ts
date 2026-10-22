import { defaultPromptView, inspectPrompt } from '../app/inspect-prompt.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadUserLayers } from '../config/user-config.js'
import { loadContext } from '../context/load-context.js'
import type { FetchPullRequestOptions, PullRequest } from '../github/pull-request.js'
import type { CliCommand } from './args.js'
import { contextSourcesAt } from './context-sources.js'
import type { ContextReaders } from './context-sources.js'
import { MissingGitHubTokenError } from './errors.js'
import { formatPromptJson, formatPromptText } from './format-prompt.js'
import type { TextOutput } from './progress.js'
import { diskSkillCatalog } from './skill-catalog.js'

export type PromptCommand = Extract<CliCommand, { kind: 'prompt' }>

export interface PromptCommandDeps extends ContextReaders {
  env: NodeJS.ProcessEnv
  files: LocalFileSystem
  stdout: TextOutput
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
}

export async function runPrompt(command: PromptCommand, deps: PromptCommandDeps): Promise<void> {
  const format = command.format === 'json' ? formatPromptJson : formatPromptText
  if (command.target.kind === 'default') {
    deps.stdout.write(format(defaultPromptView()))
    return
  }
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
  if (!token) throw new MissingGitHubTokenError('read the pull request and the repository contents')
  const { ref } = command.target
  const userLayers = await loadUserLayers({
    env: deps.env,
    home: deps.home,
    owner: ref.owner,
    repo: ref.repo,
    files: deps.files,
  })
  const pullRequest = await deps.fetchPullRequest({ ...ref, token })
  const sources = contextSourcesAt(
    deps,
    { owner: ref.owner, repo: ref.repo, token },
    pullRequest.baseSha,
  )
  const loaded = await loadContext({
    diff: pullRequest.diff,
    baseSha: pullRequest.baseSha,
    userLayers,
    sources,
  })
  const view = await inspectPrompt({
    pullRequest,
    loaded,
    ...(command.skills === undefined ? {} : { cliSkills: command.skills }),
    investigate: loaded.options.investigate ?? true,
    skills: diskSkillCatalog(deps.files, deps.env, deps.home),
    readRepoFile: (path) => sources.readRepoFile(path),
    readLocalFile: (path) => sources.readLocalFile(path),
  })
  deps.stdout.write(format(view))
}
